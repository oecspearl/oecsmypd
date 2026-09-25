import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { getCourseAccess, courseIdForLesson } from "@/lib/course-access";
import { badRequest, forbidden, notFound, serverError } from "@/lib/api-errors";
import { isLessonProgressStatus, recomputeCourseCompletion } from "@/lib/certificates/completion";

/**
 * Resolve the lesson's course and check the caller may read/write progress
 * for `studentId` on it. Returns the course id or an error response.
 */
async function authorizeLessonProgress(
  caller: { id: string; role?: string | null },
  studentId: string,
  lessonId: string
): Promise<{ courseId: string } | { error: NextResponse }> {
  const courseId = await courseIdForLesson(lessonId);
  if (!courseId) return { error: notFound("Lesson not found") };

  const access = await getCourseAccess(caller.id, caller.role, courseId);
  if (!access.courseExists) return { error: notFound("Course not found") };

  if (caller.id === studentId) {
    if (!access.canView) return { error: forbidden("You are not enrolled in this course") };
    return { courseId };
  }

  if (!access.canManage) return { error: forbidden() };

  const target = await getCourseAccess(studentId, "student", courseId);
  if (!target.canView) return { error: notFound("Student is not enrolled in this course") };
  return { courseId };
}

// GET: Fetch lesson progress including content item progress
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string; lessonId: string }> }
) {
  try {
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user, userProfile } = authResult;
    const { studentId, lessonId } = await params;

    const auth = await authorizeLessonProgress(
      { id: user.id, role: userProfile?.role },
      studentId,
      lessonId
    );
    if ("error" in auth) return auth.error;

    const serviceSupabase = createServiceSupabaseClient();

    // Get lesson progress
    const { data: lessonProgress } = await serviceSupabase
      .from('lesson_progress')
      .select('*')
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
      .maybeSingle();

    // Get content item progress
    const { data: contentProgress } = await serviceSupabase
      .from('content_item_progress')
      .select('*')
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
      .order('content_index', { ascending: true });

    return NextResponse.json({
      lesson: lessonProgress || { status: 'not_started' },
      content_items: contentProgress || []
    });

  } catch (error) {
    return serverError("Internal server error", error);
  }
}

// PUT: Update lesson completion status
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string; lessonId: string }> }
) {
  try {
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user, userProfile } = authResult;
    const { studentId, lessonId } = await params;

    // Only the student (with an active enrollment) or a course manager may write,
    // and the lesson must resolve to a real course.
    const auth = await authorizeLessonProgress(
      { id: user.id, role: userProfile?.role },
      studentId,
      lessonId
    );
    if ("error" in auth) return auth.error;
    const { courseId } = auth;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    const { status: rawStatus, progress_percentage } = body || {};

    // Status must come from the allowed set; default keeps prior behaviour.
    let status = rawStatus === undefined || rawStatus === null ? 'in_progress' : rawStatus;
    if (!isLessonProgressStatus(status)) {
      return badRequest("Invalid status");
    }
    if (Number(progress_percentage) === 100) {
      status = 'completed';
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Build progress data. completed_at is always set server-side.
    const now = new Date().toISOString();
    const progressData: Record<string, unknown> = {
      student_id: studentId,
      lesson_id: lessonId,
      status,
      updated_at: now,
      last_accessed_at: now
    };

    if (status === 'completed') {
      progressData.completed_at = now;
    }

    // Upsert progress record
    const { data: progress, error: progressError } = await serviceSupabase
      .from('lesson_progress')
      .upsert([progressData], { onConflict: 'student_id,lesson_id' })
      .select()
      .single();

    if (progressError) {
      return serverError("Failed to update progress", progressError);
    }

    // Recompute course completion; promotes the enrollment at 100%.
    await recomputeCourseCompletion(studentId, courseId);

    return NextResponse.json(progress);

  } catch (error) {
    return serverError("Internal server error", error);
  }
}
