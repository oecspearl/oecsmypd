import { NextRequest } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { badRequest, notFound, serverError } from "@/lib/api-errors";
import { enrollStudentInCourse } from "@/app/api/enrollments/_lib/enroll-student";

/**
 * POST /api/enrollments/by-code  { code }
 *
 * Enrollment codes live on `classes.enrollment_code`. A class belongs to a
 * course, so joining with a code enrolls the student in that course (with the
 * class recorded on the enrollment) and enforces `classes.max_enrollment`.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }
    const { user } = authResult;

    let body: any = null;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const rawCode = typeof body?.code === "string" ? body.code.trim() : "";
    if (!rawCode || rawCode.length > 50) {
      return badRequest("An enrollment code is required");
    }

    // Case-insensitive exact match; escape LIKE wildcards so a code cannot
    // be turned into a pattern.
    const pattern = rawCode.replace(/[\\%_]/g, (ch) => `\\${ch}`);

    const serviceSupabase = createServiceSupabaseClient();
    const { data: cls, error: classError } = await serviceSupabase
      .from("classes")
      .select("id, course_id, active, enrollment_open, max_enrollment")
      .ilike("enrollment_code", pattern)
      .maybeSingle();

    if (classError) return serverError("Failed to look up enrollment code", classError);
    if (!cls || !cls.course_id) return notFound("Invalid enrollment code");
    if (cls.active === false || cls.enrollment_open === false) {
      return badRequest("This enrollment code is no longer accepting students");
    }

    const maxEnrollment =
      typeof cls.max_enrollment === "number" && Number.isFinite(cls.max_enrollment)
        ? cls.max_enrollment
        : null;

    return await enrollStudentInCourse({
      userId: user.id,
      courseId: cls.course_id,
      classId: cls.id,
      maxEnrollment,
    });
  } catch (error) {
    return serverError("Internal server error", error);
  }
}
