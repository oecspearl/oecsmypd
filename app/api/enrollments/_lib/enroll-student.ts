import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { badRequest, conflict, notFound, serverError } from "@/lib/api-errors";

/**
 * Shared enrollment logic used by POST /api/courses/[id]/enroll and
 * POST /api/enrollments/by-code.
 *
 * Handles every enrollment status explicitly:
 *   active    -> 409 already enrolled
 *   completed -> 409 already completed (never re-inserted)
 *   dropped / anything else -> reactivated
 * A concurrent insert that trips the unique constraint (23505) is a 409.
 *
 * Capacity: `courses` has no capacity column, so course-level enrollment is
 * uncapped. `classes.max_enrollment` is enforced when enrolling via a class
 * enrollment code.
 */
export async function enrollStudentInCourse(opts: {
  userId: string;
  courseId: string;
  classId?: string | null;
  /** Class capacity (from classes.max_enrollment); null/undefined = unlimited. */
  maxEnrollment?: number | null;
}): Promise<NextResponse> {
  const { userId, courseId, classId = null, maxEnrollment = null } = opts;
  const serviceSupabase = createServiceSupabaseClient();
  const now = new Date().toISOString();

  const { data: course, error: courseError } = await serviceSupabase
    .from("courses")
    .select("id, title, published")
    .eq("id", courseId)
    .maybeSingle();

  if (courseError) return serverError("Failed to load course", courseError);
  if (!course) return notFound("Course not found");
  if (!course.published) return badRequest("Course is not available for enrollment");

  const { data: existing, error: checkError } = await serviceSupabase
    .from("enrollments")
    .select("id, status")
    .eq("course_id", courseId)
    .eq("student_id", userId)
    .maybeSingle();

  if (checkError) return serverError("Failed to check enrollment status", checkError);

  if (existing) {
    if (existing.status === "active") {
      return conflict("You are already enrolled in this course");
    }
    if (existing.status === "completed") {
      return conflict("You have already completed this course");
    }

    // 'dropped' or any unexpected status: reactivate the existing row.
    if (typeof maxEnrollment === "number" && classId) {
      const full = await classIsFull(classId, maxEnrollment);
      if (full) return conflict("This class is full");
    }

    const reactivate: Record<string, unknown> = {
      status: "active",
      enrolled_at: now,
      updated_at: now,
      completed_at: null,
    };
    if (classId) reactivate.class_id = classId;

    const { error: updateError } = await serviceSupabase
      .from("enrollments")
      .update(reactivate)
      .eq("id", existing.id);

    if (updateError) return serverError("Failed to re-enroll in course", updateError);

    await sendEnrollmentNotification(userId, course.title, courseId);

    return NextResponse.json({
      message: "Successfully re-enrolled in course",
      enrollment: { id: existing.id, status: "active", enrolled_at: now },
    });
  }

  if (typeof maxEnrollment === "number" && classId) {
    const full = await classIsFull(classId, maxEnrollment);
    if (full) return conflict("This class is full");
  }

  const insertRow: Record<string, unknown> = {
    course_id: courseId,
    student_id: userId,
    status: "active",
    enrolled_at: now,
    updated_at: now,
  };
  if (classId) insertRow.class_id = classId;

  const { data: enrollment, error: enrollError } = await serviceSupabase
    .from("enrollments")
    .insert([insertRow])
    .select("id, status, enrolled_at")
    .single();

  if (enrollError) {
    if (enrollError.code === "23505") {
      return conflict("You are already enrolled in this course");
    }
    return serverError("Failed to enroll in course", enrollError);
  }

  await sendEnrollmentNotification(userId, course.title, courseId);

  return NextResponse.json({
    message: "Successfully enrolled in course",
    enrollment,
  });
}

async function classIsFull(classId: string, maxEnrollment: number): Promise<boolean> {
  if (!Number.isFinite(maxEnrollment) || maxEnrollment <= 0) return false;
  const serviceSupabase = createServiceSupabaseClient();
  const { count, error } = await serviceSupabase
    .from("enrollments")
    .select("id", { count: "exact", head: true })
    .eq("class_id", classId)
    .eq("status", "active");
  if (error) {
    console.error("[enroll] capacity check failed; allowing enrollment", error);
    return false;
  }
  return (count ?? 0) >= maxEnrollment;
}

async function sendEnrollmentNotification(userId: string, courseTitle: string, courseId: string) {
  try {
    const { notifyEnrollment } = await import("@/lib/notifications");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    await notifyEnrollment(userId, {
      courseTitle,
      courseUrl: `${appUrl}/courses/${courseId}`,
    });
  } catch (notifError) {
    // Never fail enrollment because a notification failed.
    console.error("Failed to send enrollment notification:", notifError);
  }
}
