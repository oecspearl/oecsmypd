import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';
import { finalizeIfOver, participantDurationMinutes } from '@/lib/conferences/attendance';
import { listAccessLogs, summariseAccessByUser } from '@/lib/conferences/access-log';

/**
 * GET /api/conferences/[id]/attendance
 * Get attendance report for a conference
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: conferenceId } = await params;
    const serviceSupabase = createServiceSupabaseClient();

    // Get conference details
    const { data: conference, error: conferenceError } = await serviceSupabase
      .from('video_conferences')
      .select('id, title, course_id, instructor_id, scheduled_at, duration_minutes, status, updated_at, video_provider')
      .eq('id', conferenceId)
      .single();

    if (conferenceError || !conference) {
      return NextResponse.json({ error: 'Conference not found' }, { status: 404 });
    }

    // Check if user is instructor or admin
    const { data: userData } = await serviceSupabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    const isAdmin = ['admin', 'super_admin', 'curriculum_designer'].includes(userData?.role || '');
    const isInstructor = conference.instructor_id === user.id;

    if (!isAdmin && !isInstructor) {
      // Check if user is a course instructor
      const { data: courseInstructor } = await serviceSupabase
        .from('course_instructors')
        .select('id')
        .eq('course_id', conference.course_id)
        .eq('instructor_id', user.id)
        .single();

      if (!courseInstructor) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    // Get all participants with their attendance data
    // Note: name is in users table, avatar is in user_profiles
    const { data: participants, error: participantsError } = await serviceSupabase
      .from('conference_participants')
      .select(`
        id,
        user_id,
        joined_at,
        left_at,
        role,
        user:users!conference_participants_user_id_fkey(
          id,
          email,
          name
        )
      `)
      .eq('conference_id', conferenceId)
      .order('joined_at', { ascending: true });

    if (participantsError) {
      console.error('Error fetching participants:', participantsError);
      return NextResponse.json({ error: 'Failed to fetch attendance' }, { status: 500 });
    }

    // Get avatars from user_profiles for all participants
    const userIds = participants?.map(p => p.user_id).filter(Boolean) || [];
    let avatarMap: Record<string, string> = {};

    if (userIds.length > 0) {
      const { data: profiles } = await serviceSupabase
        .from('user_profiles')
        .select('user_id, avatar')
        .in('user_id', userIds);

      if (profiles) {
        avatarMap = profiles.reduce((acc, p) => {
          if (p.user_id && p.avatar) {
            acc[p.user_id] = p.avatar;
          }
          return acc;
        }, {} as Record<string, string>);
      }
    }

    // If the conference is over (explicitly ended, or well past its scheduled
    // window), backfill left_at for anyone still marked in-session and mark a
    // stale live row as ended. Durations are then measured to the real end.
    const now = new Date();
    const finalized = await finalizeIfOver(serviceSupabase, conference, participants || [], now);
    const rows = finalized.participants;
    const endIfStillIn = finalized.over && finalized.endTime ? finalized.endTime : now;

    // External providers (Zoom): per-click access log with device data and
    // heartbeat-based presence. Empty when the log table is not installed.
    const isExternal = conference.video_provider === 'zoom';
    const accessLogs = isExternal ? await listAccessLogs(serviceSupabase, conferenceId) : [];
    const accessByUser = summariseAccessByUser(accessLogs);
    const nameByUser = new Map<string, { name: string; email?: string }>();

    // Calculate attendance statistics
    const attendanceReport = rows.map(p => {
      const userRecord = p.user as unknown as { id: string; email: string; name: string } | null;
      const access = p.user_id ? accessByUser.get(p.user_id) : undefined;
      if (p.user_id) nameByUser.set(p.user_id, { name: userRecord?.name || userRecord?.email || 'Unknown', email: userRecord?.email });

      // For Zoom we cannot see the meeting itself, so a missing leave time is
      // bounded by the last heartbeat from the lobby tab (if any).
      const presenceEnd = !p.left_at && access ? access.ended_at || access.last_seen_at : null;
      const measured = presenceEnd ? { ...p, left_at: presenceEnd } : p;
      const durationMinutes = participantDurationMinutes(measured, endIfStillIn);
      const stillActive = !p.left_at && !finalized.over && (!isExternal || !access?.ended_at);
      const effectiveStatus: 'active' | 'left' = stillActive ? 'active' : 'left';

      return {
        id: p.id,
        user_id: p.user_id,
        name: userRecord?.name || userRecord?.email || 'Unknown',
        email: userRecord?.email,
        avatar: p.user_id ? avatarMap[p.user_id] : undefined,
        role: p.role,
        joined_at: p.joined_at,
        left_at: p.left_at,
        duration_minutes: durationMinutes,
        status: effectiveStatus,
        access: access
          ? {
              join_count: access.join_count,
              last_seen_at: access.last_seen_at,
              device_type: access.device_type,
              browser: access.browser,
              os: access.os,
              ip: access.ip,
              tracked_minutes: access.tracked_minutes,
              presence_estimated: Boolean(presenceEnd),
            }
          : null
      };
    });

    const accessLog = accessLogs.map(l => ({
      id: l.id,
      user_id: l.user_id,
      name: l.user_id ? nameByUser.get(l.user_id)?.name || 'Unknown' : 'Unknown',
      email: l.user_id ? nameByUser.get(l.user_id)?.email : undefined,
      event: l.event,
      role: l.role,
      occurred_at: l.occurred_at,
      last_seen_at: l.last_seen_at,
      ended_at: l.ended_at,
      device_type: l.device_type,
      browser: l.browser,
      os: l.os,
      ip: l.ip,
    }));

    // Summary statistics
    const totalParticipants = attendanceReport.length;
    const activeParticipants = attendanceReport.filter(p => p.status === 'active').length;
    const avgDuration = totalParticipants > 0
      ? Math.round(attendanceReport.reduce((sum, p) => sum + p.duration_minutes, 0) / totalParticipants)
      : 0;

    return NextResponse.json({
      conference: {
        id: conference.id,
        title: conference.title,
        scheduled_at: conference.scheduled_at,
        status: conference.status,
        video_provider: conference.video_provider
      },
      attendance: attendanceReport,
      access_log: accessLog,
      summary: {
        total_participants: totalParticipants,
        active_participants: activeParticipants,
        average_duration_minutes: avgDuration,
        total_join_clicks: accessLogs.filter(l => l.event === 'join_click' || l.event === 'join_redirect').length,
        access_logging_available: isExternal ? accessLogs.length > 0 || rows.length === 0 : null
      }
    });
  } catch (error) {
    console.error('Error in attendance GET:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
