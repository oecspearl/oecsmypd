import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { getCourseAccess, courseIdForLesson } from "@/lib/course-access";
import { badRequest, forbidden, notFound, serverError } from "@/lib/api-errors";
import { isLessonProgressStatus, recomputeCourseCompletion } from "@/lib/certificates/completion";

/**
 * Resolve whether `caller` may read/write progress for `studentId` in `courseId`.
 * - The student themself needs an active/completed enrollment (canView).
 * - Anyone else needs canManage on the course, and the target student must
 *   actually be enrolled.
 */
async function authorizeProgressAccess(
  caller: { id: string; role?: string | null },
  studentId: string,
  courseId: string
): Promise<NextResponse | null> {
  const access = await getCourseAccess(caller.id, caller.role, courseId);
  if (!access.courseExists) return notFound("Course not found");

  if (caller.id === studentId) {
    if (!access.canView) return forbidden("You are not enrolled in this course");
    return null;
  }

  if (!access.canManage) return forbidden();

  const target = await getCourseAccess(studentId, "student", courseId);
  if (!target.canView) return notFound("Student is not enrolled in this course");
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string; courseId: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user, userProfile } = authResult;
    const { studentId, courseId } = await params;

    const denied = await authorizeProgressAccess(
      { id: user.id, role: userProfile?.role },
      studentId,
      courseId
    );
    if (denied) return denied;

    const serviceSupabase = createServiceSupabaseClient();

    // Get course lessons by course_id
    const { data: lessons, error: lessonsError } = await serviceSupabase
      .from('lessons')
      .select('id, title, order, published')
      .eq('course_id', courseId)
      .eq('published', true)
      .order('order', { ascending: true });

    if (lessonsError) {
      return serverError("Failed to fetch course lessons", lessonsError);
    }

    if (!lessons || lessons.length === 0) {
      return NextResponse.json({
        total: 0,
        completed: 0,
        percentage: 0,
        lessons: []
      });
    }

    // Get user's lesson progress
    const { data: progressRecords, error: progressError } = await serviceSupabase
      .from('lesson_progress')
      .select('lesson_id, completed_at, status')
      .eq('student_id', studentId)
      .in('lesson_id', lessons.map(l => l.id));

    if (progressError) {
      return serverError("Failed to fetch progress records", progressError);
    }

    // Calculate progress
    const total = lessons.length;
    const completed = progressRecords?.filter(p => p.status === 'completed' || p.completed_at).length || 0;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Create detailed progress for each lesson
    const lessonProgress = lessons.map(lesson => {
      const progress = progressRecords?.find(p => p.lesson_id === lesson.id);
      return {
        lesson_id: lesson.id,
        title: lesson.title,
        order: lesson.order,
        completed: !!(progress?.status === 'completed' || progress?.completed_at),
        completed_at: progress?.completed_at || null,
        status: progress?.status || 'not_started'
      };
    });

    return NextResponse.json({
      total,
      completed,
      percentage,
      lessons: lessonProgress
    });

  } catch (error) {
    return serverError("Internal server error", error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string; courseId: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user, userProfile } = authResult;
    const { studentId, courseId } = await params;

    // Only the student (with an active enrollment) or a course manager may write.
    const denied = await authorizeProgressAccess(
      { id: user.id, role: userProfile?.role },
      studentId,
      courseId
    );
    if (denied) return denied;

    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    const { lesson_id, status: rawStatus } = body || {};

    if (!lesson_id || typeof lesson_id !== "string") {
      return badRequest("Lesson ID is required");
    }

    // Status must come from the allowed set; default keeps prior behaviour.
    const status = rawStatus === undefined || rawStatus === null ? 'completed' : rawStatus;
    if (!isLessonProgressStatus(status)) {
      return badRequest("Invalid status");
    }

    // The lesson must belong to this course.
    const lessonCourseId = await courseIdForLesson(lesson_id);
    if (!lessonCourseId) {
      return notFound("Lesson not found");
    }
    if (lessonCourseId !== courseId) {
      return badRequest("Lesson does not belong to this course");
    }

    const serviceSupabase = createServiceSupabaseClient();
    const now = new Date().toISOString();

    // completed_at is always set server-side; client values are ignored.
    const progressData: Record<string, unknown> = {
      student_id: studentId,
      lesson_id,
      status,
      completed_at: status === 'completed' ? now : null,
      last_accessed_at: now,
      updated_at: now
    };

    // Upsert progress record
    const { data: progress, error: progressError } = await serviceSupabase
      .from('lesson_progress')
      .upsert([progressData], {
        onConflict: 'student_id,lesson_id'
      })
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
