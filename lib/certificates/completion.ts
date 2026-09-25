import { createServiceSupabaseClient } from "@/lib/supabase-server";

/**
 * Course-completion bookkeeping shared by the progress routes and the
 * certificate generator.
 *
 * Completion is defined as: every published lesson in the course has a
 * `lesson_progress` row for the student with status 'completed'. When that
 * reaches 100% the student's enrollment row is promoted from 'active' to
 * 'completed' (with `completed_at` set), which is what certificate issuance
 * requires.
 */

export const LESSON_PROGRESS_STATUSES = ["not_started", "in_progress", "completed"] as const;
export type LessonProgressStatus = (typeof LESSON_PROGRESS_STATUSES)[number];

export function isLessonProgressStatus(value: unknown): value is LessonProgressStatus {
  return typeof value === "string" && (LESSON_PROGRESS_STATUSES as readonly string[]).includes(value);
}

export interface CourseCompletion {
  total: number;
  completed: number;
  percentage: number;
  /** True when the enrollment row is (now) in status 'completed'. */
  enrollmentCompleted: boolean;
}

export async function computeCourseCompletion(studentId: string, courseId: string) {
  const supabase = createServiceSupabaseClient();

  const { data: lessons, error: lessonsError } = await supabase
    .from("lessons")
    .select("id")
    .eq("course_id", courseId)
    .eq("published", true);

  if (lessonsError) throw lessonsError;

  const lessonIds = (lessons || []).map((l) => l.id);
  const total = lessonIds.length;
  if (total === 0) {
    return { total: 0, completed: 0, percentage: 0 };
  }

  const { data: progress, error: progressError } = await supabase
    .from("lesson_progress")
    .select("lesson_id, status, completed_at")
    .eq("student_id", studentId)
    .in("lesson_id", lessonIds);

  if (progressError) throw progressError;

  const completedIds = new Set(
    (progress || [])
      .filter((p) => p.status === "completed" || !!p.completed_at)
      .map((p) => p.lesson_id)
  );
  const completed = lessonIds.filter((id) => completedIds.has(id)).length;
  const percentage = Math.round((completed / total) * 100);
  return { total, completed, percentage };
}

/**
 * Recompute the student's completion for a course and persist it on the
 * enrollment row. Promotes 'active' -> 'completed' at 100%.
 *
 * Never throws: progress writes must not fail because bookkeeping did.
 */
export async function recomputeCourseCompletion(
  studentId: string,
  courseId: string
): Promise<CourseCompletion> {
  const supabase = createServiceSupabaseClient();
  let summary = { total: 0, completed: 0, percentage: 0 };

  try {
    summary = await computeCourseCompletion(studentId, courseId);
  } catch (e) {
    console.error("[completion] failed to compute course completion", e);
    return { ...summary, enrollmentCompleted: false };
  }

  const now = new Date().toISOString();

  // Keep progress_percentage in sync (column exists in the canonical schema;
  // fall back gracefully if this environment lacks it).
  const { error: pctError } = await supabase
    .from("enrollments")
    .update({ progress_percentage: summary.percentage, updated_at: now })
    .eq("student_id", studentId)
    .eq("course_id", courseId);
  if (pctError) {
    console.warn("[completion] progress_percentage update skipped", pctError.code);
  }

  const isComplete = summary.total > 0 && summary.percentage >= 100;

  if (isComplete) {
    const { error: completeError } = await supabase
      .from("enrollments")
      .update({ status: "completed", completed_at: now, updated_at: now })
      .eq("student_id", studentId)
      .eq("course_id", courseId)
      .eq("status", "active");
    if (completeError) {
      console.error("[completion] failed to mark enrollment completed", completeError);
    }
  }

  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("status")
    .eq("student_id", studentId)
    .eq("course_id", courseId)
    .maybeSingle();

  return { ...summary, enrollmentCompleted: enrollment?.status === "completed" };
}
