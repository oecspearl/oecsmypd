import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { isAdminRole } from "@/lib/rbac";

/**
 * Resolves the caller's relationship to a course.
 *
 * Use this in every API route that reads or writes course-scoped data with
 * the service-role client (which bypasses RLS). "Authenticated" is not the
 * same as "authorized": a student must be actively enrolled, an instructor
 * must own or co-teach the course, and admins can do anything.
 */

export type CourseRole = "admin" | "instructor" | "student" | "none";

export interface CourseAccess {
  role: CourseRole;
  /** True for admins, the course owner, and co-instructors. */
  canManage: boolean;
  /** True for anyone who may read course content: managers + active enrollees. */
  canView: boolean;
  /** Student enrollment row id, when applicable. */
  enrollmentId?: string;
  enrollmentStatus?: string;
  courseExists: boolean;
}

const NONE: CourseAccess = { role: "none", canManage: false, canView: false, courseExists: false };

export async function getCourseAccess(
  userId: string,
  userRole: string | null | undefined,
  courseId: string
): Promise<CourseAccess> {
  if (!userId || !courseId) return NONE;
  const supabase = createServiceSupabaseClient();

  // Select all columns: production `courses` has no `instructor_id` column
  // (instructors live in `course_instructors`), and selecting a missing column
  // makes PostgREST return an error, which would look like "course not found".
  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();

  if (courseError) {
    console.error("getCourseAccess: course lookup failed", courseError.code, courseError.message);
    return NONE;
  }
  if (!course) return NONE;

  if (isAdminRole(userRole)) {
    return { role: "admin", canManage: true, canView: true, courseExists: true };
  }

  // Legacy/optional owner column, if this environment has it.
  const ownerId: string | null | undefined = (course as any).instructor_id ?? (course as any).created_by;
  if (ownerId && ownerId === userId) {
    return { role: "instructor", canManage: true, canView: true, courseExists: true };
  }

  // Co-instructors (table may not exist in every environment; treat errors as "no row").
  const { data: coInstructor } = await supabase
    .from("course_instructors")
    .select("id")
    .eq("course_id", courseId)
    .eq("instructor_id", userId)
    .maybeSingle();
  if (coInstructor) {
    return { role: "instructor", canManage: true, canView: true, courseExists: true };
  }

  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("id, status")
    .eq("course_id", courseId)
    .eq("student_id", userId)
    .maybeSingle();

  if (enrollment) {
    const active = enrollment.status === "active" || enrollment.status === "completed";
    return {
      role: "student",
      canManage: false,
      canView: active,
      enrollmentId: enrollment.id,
      enrollmentStatus: enrollment.status,
      courseExists: true,
    };
  }

  return { ...NONE, courseExists: true };
}

/** Resolve the course a lesson belongs to. */
export async function courseIdForLesson(lessonId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient();
  const { data } = await supabase.from("lessons").select("course_id").eq("id", lessonId).maybeSingle();
  return data?.course_id ?? null;
}

/** Resolve the course a quiz belongs to (direct course_id, else via its lesson). */
export async function courseIdForQuiz(quizId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient();
  const { data } = await supabase.from("quizzes").select("course_id, lesson_id").eq("id", quizId).maybeSingle();
  if (!data) return null;
  if (data.course_id) return data.course_id;
  if (data.lesson_id) return courseIdForLesson(data.lesson_id);
  return null;
}

/** Resolve the course an assignment belongs to (direct course_id, else via its lesson). */
export async function courseIdForAssignment(assignmentId: string): Promise<string | null> {
  const supabase = createServiceSupabaseClient();
  const { data } = await supabase
    .from("assignments")
    .select("course_id, lesson_id")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!data) return null;
  if (data.course_id) return data.course_id;
  if (data.lesson_id) return courseIdForLesson(data.lesson_id);
  return null;
}
