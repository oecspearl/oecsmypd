import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';
import { rateLimit } from '@/lib/rate-limit';
import { tooManyRequests } from '@/lib/api-errors';
import { isUuid } from '@/lib/security';
import { resolveConferenceAccess } from '@/lib/conferences/access';
import { clientInfoFromRequest, endAccess, recordAccess, touchAccess } from '@/lib/conferences/access-log';

/**
 * POST /api/conferences/[id]/access
 *
 * Tracked access for external-provider conferences (Zoom). The lobby page
 * and the in-course Zoom panel call this instead of exposing the raw link.
 *
 *   { event: 'page_view' }               → logs the visit
 *   { event: 'join_click' }              → verifies access, records the join
 *                                          (IP, device, browser, OS), marks the
 *                                          participant as joined, returns the
 *                                          meeting URL and passcode + log_id
 *   { event: 'heartbeat', log_id }       → extends last_seen_at (every ~60s)
 *   { event: 'leave', log_id }           → closes the log row and the
 *                                          participant record
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conferenceId } = await params;
    if (!isUuid(conferenceId)) return NextResponse.json({ error: 'Invalid conference id' }, { status: 400 });

    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const limit = await rateLimit({ key: `conf-access:${user.id}`, limit: 120, windowSeconds: 60 });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    let body: { event?: string; log_id?: string } = {};
    try {
      body = await request.json();
    } catch {
      /* sendBeacon may post an empty/blob body; treat as invalid below */
    }
    const event = String(body.event || '');
    const service = createServiceSupabaseClient();

    // --- Heartbeat / leave: only touch the caller's own row -----------------
    if (event === 'heartbeat' || event === 'leave') {
      const logId = String(body.log_id || '');
      if (logId && !isUuid(logId)) return NextResponse.json({ error: 'Invalid log_id' }, { status: 400 });

      if (event === 'heartbeat') {
        const ok = logId ? await touchAccess(service, logId, user.id) : false;
        return NextResponse.json({ ok });
      }

      const closed = logId ? await endAccess(service, logId, user.id) : false;
      // Mirror the legacy leave route so the attendance report shows a leave time.
      await service
        .from('conference_participants')
        .update({ left_at: new Date().toISOString() })
        .eq('conference_id', conferenceId)
        .eq('user_id', user.id)
        .is('left_at', null);
      return NextResponse.json({ ok: true, closed });
    }

    if (event !== 'page_view' && event !== 'join_click') {
      return NextResponse.json({ error: 'Unknown event' }, { status: 400 });
    }

    // --- Page view / join: enforce access ------------------------------------
    const access = await resolveConferenceAccess(service, user.id, conferenceId);
    if (access.ok === false) return NextResponse.json({ error: access.error }, { status: access.status });
    const { conference, canManage, isHost } = access;
    const client = clientInfoFromRequest(request);
    const role = isHost ? 'host' : canManage ? 'co-host' : 'participant';

    if (event === 'page_view') {
      const logId = await recordAccess(service, {
        conference_id: conference.id,
        user_id: user.id,
        course_id: conference.course_id,
        event: 'page_view',
        role,
        client,
      });
      return NextResponse.json({
        ok: true,
        log_id: logId,
        conference: {
          id: conference.id,
          title: conference.title,
          description: conference.description,
          status: conference.status,
          scheduled_at: conference.scheduled_at,
          timezone: conference.timezone,
          duration_minutes: conference.duration_minutes,
          video_provider: conference.video_provider,
          course_id: conference.course_id,
          lesson_id: conference.lesson_id,
          meeting_id: conference.video_provider === 'zoom' ? conference.meeting_id : null,
        },
        can_manage: canManage,
        is_host: isHost,
      });
    }

    // join_click
    if (conference.status === 'ended' || conference.status === 'cancelled') {
      return NextResponse.json({ error: 'This conference has ended.' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { error: participantError } = await service
      .from('conference_participants')
      .upsert(
        [{ conference_id: conference.id, user_id: user.id, joined_at: now, left_at: null, role: isHost ? 'host' : 'participant' }],
        { onConflict: 'conference_id,user_id' }
      );
    if (participantError) {
      console.error('[conference-access] participant upsert failed:', participantError.code, participantError.message);
    }

    if (conference.status === 'scheduled') {
      await service.from('video_conferences').update({ status: 'live' }).eq('id', conference.id);
    }

    const logId = await recordAccess(service, {
      conference_id: conference.id,
      user_id: user.id,
      course_id: conference.course_id,
      event: 'join_click',
      role,
      client,
    });

    return NextResponse.json({
      ok: true,
      log_id: logId,
      url: conference.meeting_url,
      passcode: conference.meeting_password,
      meeting_id: conference.meeting_id,
      video_provider: conference.video_provider,
      is_host: isHost,
      tracked: Boolean(logId),
    });
  } catch (error) {
    console.error('[conference-access] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
