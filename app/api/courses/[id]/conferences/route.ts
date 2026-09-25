import { NextRequest, NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { authenticateUser } from '@/lib/api-auth';
import { getCourseAccess } from '@/lib/course-access';
import { unauthorized, forbidden, notFound, badRequest, serverError, fromDbError } from '@/lib/api-errors';
import { isUuid } from '@/lib/security';
import { autoEndStaleConferences } from '@/lib/conferences/attendance';
import { redactExternalLinks } from '@/lib/conferences/access';

const CONFERENCE_STATUSES = ['scheduled', 'live', 'in_progress', 'ended', 'completed', 'cancelled'];

/**
 * GET /api/courses/[id]/conferences
 * Lists a course's video conferences for anyone who may view the course.
 * `meeting_password` is only returned to course managers.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: courseId } = await params;
    if (!courseId || !isUuid(courseId)) return badRequest('Invalid course ID format');

    const auth = await authenticateUser(request);
    if (!auth.success || !auth.user || !auth.userProfile) return unauthorized();

    const access = await getCourseAccess(auth.user.id, auth.userProfile.role, courseId);
    if (!access.courseExists) return notFound('Course not found');
    if (!access.canView) return forbidden();
    const canManage = access.canManage || auth.userProfile.role === 'curriculum_designer';

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    if (status && !CONFERENCE_STATUSES.includes(status)) return badRequest('Invalid status filter');

    const serviceSupabase = createServiceSupabaseClient();
    let query = serviceSupabase
      .from('video_conferences')
      .select(`
        *,
        instructor:users!video_conferences_instructor_id_fkey(
          id,
          name
        ),
        course:courses!video_conferences_course_id_fkey(
          id,
          title
        ),
        lesson:lessons!video_conferences_lesson_id_fkey(
          id,
          title
        )
      `)
      .eq('course_id', courseId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data: conferences, error } = await query;
    if (error) return fromDbError(error, 'Failed to fetch conferences');

    const current = await autoEndStaleConferences(serviceSupabase, (conferences || []) as any[]);
    const rows = current.map((c: any) => {
      if (canManage) return c;
      const { meeting_password, host_key, host_url, start_url, ...safe } = c;
      // Zoom links are only handed out through the tracked join flow.
      return redactExternalLinks(safe, false);
    });

    return NextResponse.json({ conferences: rows });
  } catch (error) {
    return serverError('Failed to fetch conferences', error);
  }
}
