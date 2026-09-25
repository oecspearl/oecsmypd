import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';
import { serverError } from "@/lib/api-errors";
import { redactExternalLinks, resolveConferenceAccess } from '@/lib/conferences/access';
import { parseZoomLink } from '@/lib/conferences/zoom';

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

    const { data: conference, error } = await supabase
      .from('video_conferences')
      .select(`
        *,
        instructor:users!video_conferences_instructor_id_fkey(
          id,
          email,
          name
        ),
        course:courses!video_conferences_course_id_fkey(
          id,
          title,
          description
        ),
        lesson:lessons!video_conferences_lesson_id_fkey(
          id,
          title
        ),
        participants:conference_participants(
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
        )
      `)
      .eq('id', conferenceId)
      .single();

    if (error) {
      console.error('Error fetching conference:', error);
      return NextResponse.json({ error: 'Conference not found' }, { status: 404 });
    }

    // Zoom links are only handed out through the tracked join flow.
    if (conference?.video_provider === 'zoom') {
      const access = await resolveConferenceAccess(createServiceSupabaseClient(), user.id, conferenceId);
      const canManage = access.ok && access.canManage;
      return NextResponse.json({ conference: redactExternalLinks(conference, canManage) });
    }

    return NextResponse.json({ conference });
  } catch (error) {
    console.error('Error in conference GET:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(
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

    const body = await request.json();
    const {
      title,
      description,
      scheduled_at,
      duration_minutes,
      max_participants,
      recording_enabled,
      waiting_room_enabled,
      status,
      zoom_link,
      zoom_passcode
    } = body;

    // Verify user is instructor of the conference
    const { data: existingConference, error: fetchError } = await supabase
      .from('video_conferences')
      .select('id, instructor_id, course_id, video_provider')
      .eq('id', conferenceId)
      .eq('instructor_id', user.id)
      .single();

    if (fetchError || !existingConference) {
      return NextResponse.json({ error: 'Conference not found or access denied' }, { status: 403 });
    }

    // Verify user is instructor of the course
    const { data: courseInstructor, error: courseError } = await supabase
      .from('course_instructors')
      .select('id')
      .eq('course_id', existingConference.course_id)
      .eq('instructor_id', user.id)
      .single();

    if (courseError || !courseInstructor) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Zoom link / passcode changes (only for Zoom conferences)
    const zoomUpdate: { meeting_url?: string; meeting_password?: string | null } = {};
    if (existingConference.video_provider === 'zoom') {
      if (zoom_link !== undefined) {
        const parsed = parseZoomLink(zoom_link);
        if (!parsed) return NextResponse.json({ error: 'A valid Zoom link is required.' }, { status: 400 });
        zoomUpdate.meeting_url = parsed.url;
      }
      if (zoom_passcode !== undefined) {
        zoomUpdate.meeting_password = zoom_passcode ? String(zoom_passcode).trim().slice(0, 64) : null;
      }
    }

    // Update conference
    // Use service client to bypass RLS policies
    const serviceSupabase = createServiceSupabaseClient();

    const { data: conference, error } = await serviceSupabase
      .from('video_conferences')
      .update({
        ...zoomUpdate,
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(scheduled_at !== undefined && { scheduled_at }),
        ...(duration_minutes !== undefined && { duration_minutes }),
        ...(max_participants !== undefined && { max_participants }),
        ...(recording_enabled !== undefined && { recording_enabled }),
        ...(waiting_room_enabled !== undefined && { waiting_room_enabled }),
        ...(status && { status })
      })
      .eq('id', conferenceId)
      .select(`
        *,
        instructor:users!video_conferences_instructor_id_fkey(
          id,
          email,
          name
        ),
        course:courses!video_conferences_course_id_fkey(
          id,
          title,
          description
        ),
        lesson:lessons!video_conferences_lesson_id_fkey(
          id,
          title
        )
      `)
      .single();

    if (error) {
      console.error('Error updating conference:', error);
      return NextResponse.json({ error: 'Failed to update conference' }, { status: 500 });
    }

    return NextResponse.json({ conference });
  } catch (error) {
    console.error('Error in conference PUT:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
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
    console.log('Delete conference request:', { conferenceId, userId: user.id });

    // Check if user is admin (using same method as other endpoints)
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      console.log('User not found:', { userError, userData });
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const isAdmin = ['admin', 'super_admin', 'curriculum_designer'].includes(userData.role);
    console.log('User role check:', {
      isAdmin,
      role: userData.role,
      userError,
      userId: user.id,
      userEmail: user.email
    });

    // Get conference details using service client to ensure we can find it even if RLS hides it from non-instructors
    // We will perform manual authorization checks below
    const serviceSupabase = createServiceSupabaseClient();
    const { data: existingConference, error: fetchError } = await serviceSupabase
      .from('video_conferences')
      .select('id, instructor_id, course_id')
      .eq('id', conferenceId)
      .single();

    if (fetchError || !existingConference) {
      console.log('Conference not found:', { fetchError, existingConference });
      return NextResponse.json({ error: 'Conference not found' }, { status: 404 });
    }

    // Check authorization: either admin OR (instructor of conference AND course instructor)
    const isInstructorOfConference = existingConference.instructor_id === user.id;

    console.log('Authorization check:', {
      isAdmin,
      isInstructorOfConference,
      conferenceInstructorId: existingConference.instructor_id,
      userId: user.id,
      shouldAllow: isAdmin || isInstructorOfConference
    });

    if (!isAdmin && !isInstructorOfConference) {
      console.log('Not authorized: not admin and not conference instructor');
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // If not admin, verify user is instructor of the course
    if (!isAdmin) {
      const { data: courseInstructor, error: courseError } = await supabase
        .from('course_instructors')
        .select('id')
        .eq('course_id', existingConference.course_id)
        .eq('instructor_id', user.id)
        .single();

      if (courseError || !courseInstructor) {
        console.log('Course instructor check failed:', { courseError, courseInstructor, courseId: existingConference.course_id });
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    console.log('Proceeding with conference deletion:', { conferenceId });

    // Use service client to bypass RLS policies (which only allow instructors to delete their own)
    // We have already verified permissions above
    // serviceSupabase is already initialized above

    // Delete related records first (no CASCADE set up in database)
    // 1. Delete conference recordings
    const { error: recordingsError } = await serviceSupabase
      .from('conference_recordings')
      .delete()
      .eq('conference_id', conferenceId);

    if (recordingsError) {
      console.log('Note: Error deleting conference recordings (may not exist):', recordingsError.message);
      // Continue anyway - recordings might not exist
    } else {
      console.log('Deleted conference recordings for:', conferenceId);
    }

    // 2. Delete conference participants
    const { error: participantsError } = await serviceSupabase
      .from('conference_participants')
      .delete()
      .eq('conference_id', conferenceId);

    if (participantsError) {
      console.log('Note: Error deleting conference participants (may not exist):', participantsError.message);
      // Continue anyway - participants might not exist
    } else {
      console.log('Deleted conference participants for:', conferenceId);
    }

    // 3. Now delete the conference itself
    const { error } = await serviceSupabase
      .from('video_conferences')
      .delete()
      .eq('id', conferenceId);

    if (error) {
      console.error('Error deleting conference:', error);
      return serverError('Failed to delete conference', error);
    }

    console.log('Conference deleted successfully:', { conferenceId });

    return NextResponse.json({ message: 'Conference deleted successfully' });
  } catch (error) {
    console.error('Error in conference DELETE:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
