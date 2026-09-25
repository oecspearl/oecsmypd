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

    // Use service client to bypass RLS for updating participant record
    const serviceSupabase = createServiceSupabaseClient();

    // Update participant record with leave time (only if not already set)
    const { error: participantError } = await serviceSupabase
      .from('conference_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('conference_id', conferenceId)
      .eq('user_id', user.id)
      .is('left_at', null);

    if (participantError) {
      console.error('Error updating participant:', participantError);
      return NextResponse.json({ error: 'Failed to leave conference' }, { status: 500 });
    }

    // Check if this was the instructor leaving
    const { data: conference, error: conferenceError } = await serviceSupabase
      .from('video_conferences')
      .select('instructor_id, status')
      .eq('id', conferenceId)
      .single();

    if (conferenceError) {
      console.error('Error fetching conference:', conferenceError);
      return NextResponse.json({ error: 'Conference not found' }, { status: 404 });
    }

    // If instructor is leaving, end the conference
    if (conference.instructor_id === user.id && conference.status === 'live') {
      const endedAt = new Date().toISOString();
      await serviceSupabase
        .from('video_conferences')
        .update({ status: 'ended' })
        .eq('id', conferenceId);
      // Everyone still marked in-session left when the host ended the meeting.
      await serviceSupabase
        .from('conference_participants')
        .update({ left_at: endedAt })
        .eq('conference_id', conferenceId)
        .is('left_at', null);
    }

    return NextResponse.json({ message: 'Successfully left conference' });
  } catch (error) {
    console.error('Error in conference leave:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
