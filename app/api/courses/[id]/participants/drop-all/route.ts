import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser } from "@/lib/api-auth";
import { getCourseAccess } from "@/lib/course-access";
import { unauthorized, forbidden, notFound, badRequest, serverError, fromDbError } from "@/lib/api-errors";
import { isUuid } from "@/lib/security";

/**
 * POST /api/courses/[id]/participants/drop-all
 * Remove every active/suspended enrolment from a course. Managers only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: courseId } = await params;
    if (!courseId || !isUuid(courseId)) return badRequest("Invalid course ID format");

    const auth = await authenticateUser(request);
    if (!auth.success || !auth.user || !auth.userProfile) return unauthorized();

    const access = await getCourseAccess(auth.user.id, auth.userProfile.role, courseId);
    if (!access.courseExists) return notFound("Course not found");
    if (!access.canManage && auth.userProfile.role !== "curriculum_designer") return forbidden();

    const serviceSupabase = createServiceSupabaseClient();
    const { data, error } = await serviceSupabase
      .from("enrollments")
      .delete()
      .eq("course_id", courseId)
      .in("status", ["active", "suspended"])
      .select("id");

    if (error) return fromDbError(error, "Failed to delete all participants");

    return NextResponse.json({
      message: "All participants successfully deleted",
      deletedCount: data?.length || 0,
    });
  } catch (error) {
    return serverError("Failed to delete all participants", error);
  }
}
