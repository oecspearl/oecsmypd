import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { getCourseAccess, courseIdForAssignment } from "@/lib/course-access";
import { badRequest, forbidden, notFound, serverError, unauthorized } from "@/lib/api-errors";
import { updateCompetenciesFromAssignment } from "@/lib/adaptive-learning";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; submissionId: string }> }
) {
  try {
    const { id: assignmentId, submissionId } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return unauthorized();
    }

    const serviceSupabase = createServiceSupabaseClient();
    let data: any;
    try {
      data = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const { feedback, grade } = data || {};

    // Validate required fields
    if (grade === undefined || grade === null || grade === "") {
      return badRequest("Grade is required");
    }

    // Load the assignment and resolve its course (direct course_id, else via lesson)
    const { data: assignment, error: assignmentError } = await serviceSupabase
      .from("assignments")
      .select("creator_id, lesson_id, course_id, points, title")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError || !assignment) {
      return notFound("Assignment not found");
    }

    const courseId = assignment.course_id ?? (await courseIdForAssignment(assignmentId));

    // Check authorization: creator, admin/curriculum designer, or course manager
    // (owner or co-instructor) for course-level AND lesson-level assignments.
    const isCreator = assignment.creator_id === user.id;
    const isAdmin = !!user.role && ['admin', 'super_admin', 'curriculum_designer'].includes(user.role);
    const access = courseId ? await getCourseAccess(user.id, user.role, courseId) : null;

    if (!isCreator && !isAdmin && !access?.canManage) {
      return forbidden("Access denied");
    }

    // Validate grade is within assignment points. A null/undefined points
    // value defaults to 100; an explicit 0 is honoured.
    const rawPoints = assignment.points;
    const maxPoints =
      rawPoints === null || rawPoints === undefined
        ? 100
        : Number.isFinite(Number(rawPoints))
          ? Number(rawPoints)
          : 100;
    const g = Number(grade);
    if (!Number.isFinite(g) || g < 0 || g > maxPoints) {
      return badRequest(`Grade must be a number between 0 and ${maxPoints}`);
    }

    // Update the submission with grade and feedback
    const { data: updatedSubmission, error: updateError } = await serviceSupabase
      .from("assignment_submissions")
      .update({
        grade: g,
        feedback: feedback || null,
        graded_by: user.id,
        graded_at: new Date().toISOString(),
        status: 'graded',
        updated_at: new Date().toISOString()
      })
      .eq("id", submissionId)
      .eq("assignment_id", assignmentId)
      .select()
      .single();

    if (updateError || !updatedSubmission) {
      if (updateError?.code === "PGRST116") return notFound("Submission not found");
      return serverError("Failed to grade submission", updateError);
    }

    // Sync to gradebook if assignment is associated with a course
    if (courseId) {
      try {
        // Check if grade item exists for this assignment
        const { data: gradeItem } = await serviceSupabase
          .from("course_grade_items")
          .select("id")
          .eq("course_id", courseId)
          .eq("type", "assignment")
          .eq("assessment_id", assignmentId)
          .maybeSingle();

        if (gradeItem && updatedSubmission.student_id) {
          // Update or create grade in course_grades
          const percentage = maxPoints > 0 ? (g / maxPoints) * 100 : 0;

          const { error: gradeSyncError } = await serviceSupabase
            .from("course_grades")
            .upsert([{
              course_id: courseId,
              student_id: updatedSubmission.student_id,
              grade_item_id: gradeItem.id,
              score: g,
              max_score: maxPoints,
              percentage: Number(percentage.toFixed(2)),
              feedback: feedback || null,
              graded_by: user.id,
              graded_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }], {
              onConflict: "student_id,grade_item_id"
            });
          if (gradeSyncError) {
            console.error('Gradebook sync error:', gradeSyncError);
          }
        }
      } catch (syncError) {
        console.error('Gradebook sync error:', syncError);
        // Don't fail the grading if gradebook sync fails
      }
    }

    // Send email notification to student
    try {
      const { notifyGradePosted } = await import('@/lib/notifications');
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

      let courseTitle = 'Your Course';
      if (courseId) {
        const { data: courseRow } = await serviceSupabase
          .from("courses")
          .select("title")
          .eq("id", courseId)
          .maybeSingle();
        if (courseRow?.title) courseTitle = courseRow.title;
      }

      await notifyGradePosted(updatedSubmission.student_id, {
        assignmentName: assignment.title || 'Assignment',
        courseTitle,
        score: g,
        totalPoints: maxPoints,
        percentage: maxPoints > 0 ? Math.round((g / maxPoints) * 100) : 0,
        feedback: feedback || undefined,
        courseUrl: courseId ? `${appUrl}/courses/${courseId}` : `${appUrl}/assignments/${assignmentId}`,
      });
    } catch (notifError) {
      // Don't fail grading if notification fails
      console.error('Failed to send grade notification:', notifError);
    }

    // Update student competencies based on assignment grade
    try {
      const percentage = maxPoints > 0 ? (g / maxPoints) * 100 : 0;
      const compResult = await updateCompetenciesFromAssignment(
        assignmentId,
        updatedSubmission.student_id,
        percentage
      );
      if (compResult.updated > 0) {
        console.log(`Updated ${compResult.updated} competencies for student ${updatedSubmission.student_id}`);
      }
    } catch (compError) {
      console.error('Competency update error:', compError);
      // Don't fail grading if competency update fails
    }

    return NextResponse.json({
      success: true,
      submission: updatedSubmission,
      message: "Submission graded successfully"
    });

  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
