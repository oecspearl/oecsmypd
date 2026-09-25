import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';

/**
 * POST /api/student/calendar/sync
 * Sync calendar events from assignments and quizzes
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceSupabase = await createServiceSupabaseClient();

    // Use the database function to sync events
    const { data: eventsCreated, error } = await serviceSupabase
      .rpc('sync_student_calendar_from_deadlines', {
        p_student_id: user.id
      });

    if (error) {
      console.error('Error syncing calendar:', error);
      // Fall back to manual sync if function doesn't exist
      return await manualSync(serviceSupabase, user.id);
    }

    return NextResponse.json({
      success: true,
      events_created: eventsCreated || 0,
    });
  } catch (error) {
    console.error('Error in calendar sync POST:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function manualSync(supabase: Awaited<ReturnType<typeof createServiceSupabaseClient>>, userId: string) {
  let eventsCreated = 0;

  // Get enrolled courses
  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('course_id')
    .eq('student_id', userId);

  if (!enrollments || enrollments.length === 0) {
    return NextResponse.json({ success: true, events_created: 0 });
  }

  const courseIds = enrollments.map(e => e.course_id);

  // Sync assignments
  const { data: assignments } = await supabase
    .from('assignments')
    .select(`
      id,
      title,
      description,
      due_date,
      course:courses(title)
    `)
    .in('course_id', courseIds)
    .gt('due_date', new Date().toISOString());

  for (const assignment of assignments || []) {
    // Check if already exists
    const { data: existing } = await supabase
      .from('student_calendar_events')
      .select('id')
      .eq('student_id', userId)
      .eq('source_type', 'assignment')
      .eq('source_id', assignment.id)
      .single();

    if (!existing) {
      const course = assignment.course as unknown as { title: string } | null;
      await supabase
        .from('student_calendar_events')
        .insert({
          student_id: userId,
          event_type: 'assignment',
          source_type: 'assignment',
          source_id: assignment.id,
          title: `Due: ${assignment.title}`,
          description: `Assignment due for ${course?.title || 'Unknown Course'}`,
          start_datetime: assignment.due_date,
          is_synced: true,
          color: '#ef4444', // Red for assignments
        });
      eventsCreated++;
    }
  }

  // Sync quizzes
  const { data: quizzes } = await supabase
    .from('quizzes')
    .select(`
      id,
      title,
      available_from,
      available_until,
      lesson:lessons(course_id, course:courses(title))
    `)
    .not('available_until', 'is', null)
    .gt('available_until', new Date().toISOString());

  for (const quiz of quizzes || []) {
    const lesson = quiz.lesson as unknown as { course_id: string; course: { title: string } } | null;
    if (!lesson || !courseIds.includes(lesson.course_id)) continue;

    // Check if already exists
    const { data: existing } = await supabase
      .from('student_calendar_events')
      .select('id')
      .eq('student_id', userId)
      .eq('source_type', 'quiz')
      .eq('source_id', quiz.id)
      .single();

    if (!existing) {
      await supabase
        .from('student_calendar_events')
        .insert({
          student_id: userId,
          event_type: 'quiz',
          source_type: 'quiz',
          source_id: quiz.id,
          title: `Quiz: ${quiz.title}`,
          description: `Quiz available for ${lesson.course?.title || 'Unknown Course'}`,
          start_datetime: quiz.available_from || new Date().toISOString(),
          end_datetime: quiz.available_until,
          is_synced: true,
          color: '#f59e0b', // Amber for quizzes
        });
      eventsCreated++;
    }
  }

  return NextResponse.json({
    success: true,
    events_created: eventsCreated,
  });
}
