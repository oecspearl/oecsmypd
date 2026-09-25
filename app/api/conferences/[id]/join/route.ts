import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';

export async function POST(
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

    // Use service client to avoid RLS recursion issues
    const serviceSupabase = createServiceSupabaseClient();

    // Get conference details using service client
    const { data: conference, error: conferenceError } = await serviceSupabase
      .from('video_conferences')
      .select(`
        id,
        course_id,
        instructor_id,
        status,
        meeting_url,
        meeting_password,
        waiting_room_enabled,
        meeting_id,
        video_provider
      `)
      .eq('id', conferenceId)
      .single();

    if (conferenceError || !conference) {
      console.error('Conference fetch error:', conferenceError);
      return NextResponse.json({ 
        error: 'Conference not found',
        details: conferenceError?.message 
      }, { status: 404 });
    }

    // Get user data to check role
    const { data: userData, error: userError } = await serviceSupabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const isAdmin = ['admin', 'super_admin', 'instructor', 'curriculum_designer'].includes(userData.role);
    const isInstructor = conference.instructor_id === user.id;

    // Check access: instructor, admin, or enrolled student
    if (!isInstructor && !isAdmin) {
      // Check enrollment using service client to avoid RLS recursion
      const { data: enrollment, error: enrollmentError } = await serviceSupabase
        .from('enrollments')
        .select('id')
        .eq('student_id', user.id)
        .eq('course_id', conference.course_id)
        .eq('status', 'active')
        .single();

      if (enrollmentError || !enrollment) {
        console.error('Enrollment check failed:', enrollmentError);
        return NextResponse.json({ 
          error: 'Access denied. You must be enrolled in this course to join the conference.',
          details: enrollmentError?.message 
        }, { status: 403 });
      }
    }

    // Check if conference is live or scheduled
    if (conference.status === 'ended' || conference.status === 'cancelled') {
      return NextResponse.json({ error: 'Conference is not available' }, { status: 400 });
    }

    // Add or update participant record using service client
    // Reset left_at to null on rejoin so the user appears active again
    const { data: participant, error: participantError } = await serviceSupabase
      .from('conference_participants')
      .upsert([{
        conference_id: conferenceId,
        user_id: user.id,
        joined_at: new Date().toISOString(),
        left_at: null,
        role: conference.instructor_id === user.id ? 'host' : 'participant'
      }], {
        onConflict: 'conference_id,user_id'
      })
      .select()
      .single();

    if (participantError) {
      console.error('Error adding participant:', participantError);
      return NextResponse.json({ 
        error: 'Failed to join conference',
        details: participantError.message 
      }, { status: 500 });
    }

    // Update conference status to live if it was scheduled
    if (conference.status === 'scheduled') {
      await serviceSupabase
        .from('video_conferences')
        .update({ status: 'live' })
        .eq('id', conferenceId);
    }

    return NextResponse.json({
      conference,
      participant,
      meetingUrl: conference.meeting_url,
      meetingPassword: conference.meeting_password,
      meetingId: conference.meeting_id,
      videoProvider: conference.video_provider,
      waitingRoomEnabled: false // Force disable waiting room to prevent members-only error
    });
  } catch (error) {
    console.error('Error in conference join:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
