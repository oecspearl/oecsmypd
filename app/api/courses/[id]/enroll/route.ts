import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { cleanupStudentCourseData } from "@/lib/database-helpers";
import { badRequest, serverError } from "@/lib/api-errors";
import { enrollStudentInCourse } from "@/app/api/enrollments/_lib/enroll-student";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user } = authResult;
    const { id: courseId } = await params;

    if (!courseId) {
      return badRequest("Course ID is required");
    }

    // Course lookup, status handling (active/completed/dropped), unique
    // violation -> 409, and notification all live in the shared helper.
    return await enrollStudentInCourse({ userId: user.id, courseId });

  } catch (error) {
    return serverError("Internal server error", error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }

    const { user } = authResult;
    const { id } = await params;
    const courseId = id;

    if (!courseId) {
      return NextResponse.json({ error: "Course ID is required" }, { status: 400 });
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Find and update enrollment status to 'dropped'
    const { data: enrollment, error: findError } = await serviceSupabase
      .from('enrollments')
      .select('id')
      .eq('course_id', courseId)
      .eq('student_id', user.id)
      .eq('status', 'active')
      .single();

    if (findError || !enrollment) {
      return NextResponse.json({ error: "No active enrollment found" }, { status: 404 });
    }

    const { error: updateError } = await serviceSupabase
      .from('enrollments')
      .update({
        status: 'dropped',
        updated_at: new Date().toISOString()
      })
      .eq('id', enrollment.id);

    if (updateError) {
      console.error('Error dropping enrollment:', updateError);
      return NextResponse.json({ error: "Failed to drop course" }, { status: 500 });
    }

    // Clean up student's todos, calendar events, notes, and bookmarks for this course
    const cleanup = await cleanupStudentCourseData(serviceSupabase, user.id, courseId);

    return NextResponse.json({
      message: "Successfully dropped course",
      cleanup
    });

  } catch (error) {
    console.error('Drop enrollment error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
