import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { getCourseAccess, courseIdForAssignment } from "@/lib/course-access";
import { badRequest, conflict, forbidden, notFound, serverError, unauthorized } from "@/lib/api-errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assignmentId } = await params;
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

    const { submission_type, content, files, status } = data || {};

    // Validate required fields
    if (!submission_type || !status) {
      return badRequest("Missing required fields");
    }

    // Validate submission_type
    if (!['file', 'text', 'url'].includes(submission_type)) {
      return badRequest("Invalid submission type");
    }

    // Validate status (a student can never set 'graded')
    if (!['draft', 'submitted'].includes(status)) {
      return badRequest("Invalid status");
    }

    // Get assignment details to check due date and course association
    const { data: assignment, error: assignmentError } = await serviceSupabase
      .from("assignments")
      .select("due_date, allow_late_submissions, course_id, lesson_id, published")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError || !assignment) {
      return notFound("Assignment not found");
    }

    // The caller submits on their own behalf: they must be an actively
    // enrolled student in the assignment's course, or a course manager.
    const assignmentCourseId = await courseIdForAssignment(assignmentId);
    if (assignmentCourseId) {
      const access = await getCourseAccess(user.id, user.role, assignmentCourseId);
      const activeStudent = access.role === "student" && access.enrollmentStatus === "active";
      if (!access.canManage && !activeStudent) {
        return forbidden("You must be enrolled in this course to submit");
      }
      if (!access.canManage && assignment.published === false) {
        return notFound("Assignment not found");
      }
    }

    // Check if there's an existing submission (the caller is always the owner:
    // submissions are keyed by the caller's id).
    const { data: existingSubmission, error: existingError } = await serviceSupabase
      .from("assignment_submissions")
      .select("id, status, grade, submitted_at, late")
      .eq("assignment_id", assignmentId)
      .eq("student_id", user.id)
      .maybeSingle();

    if (existingError) {
      return serverError("Failed to load submission", existingError);
    }

    if (existingSubmission) {
      // Graded work is frozen.
      if (existingSubmission.status === 'graded' || existingSubmission.grade !== null) {
        return conflict("Submission has already been graded");
      }
      // Never downgrade a submitted piece of work back to a draft.
      if (existingSubmission.status === 'submitted' && status === 'draft') {
        return badRequest("A submitted assignment cannot be reverted to a draft");
      }
    }

    const now = new Date().toISOString();

    // submitted_at is set once, on the first transition to 'submitted', and
    // preserved on resubmission. Lateness is judged from that original time.
    const originalSubmittedAt: string | null = existingSubmission?.submitted_at ?? null;
    const effectiveSubmittedAt: string | null =
      status === 'submitted' ? (originalSubmittedAt ?? now) : originalSubmittedAt;

    const isLate = !!(
      status === 'submitted' &&
      assignment.due_date &&
      effectiveSubmittedAt &&
      new Date(effectiveSubmittedAt) > new Date(assignment.due_date)
    );

    // Check if late submissions are allowed (only for a first-time submission;
    // a resubmission of on-time work is not late).
    if (isLate && !assignment.allow_late_submissions) {
      return badRequest("Late submissions are not allowed for this assignment");
    }

    // Prepare submission data
    const submissionData: Record<string, unknown> = {
      submission_type,
      content: content || null,
      files: files ? JSON.stringify(files) : null,
      status,
      submitted_at: effectiveSubmittedAt,
      late: isLate,
      updated_at: now
    };

    let result;
    if (existingSubmission) {
      // Update existing submission (created_at, student_id, assignment_id untouched)
      const { data: submission, error } = await serviceSupabase
        .from("assignment_submissions")
        .update(submissionData)
        .eq("id", existingSubmission.id)
        .eq("student_id", user.id)
        .select()
        .single();

      if (error) {
        return serverError("Failed to update submission", error);
      }
      result = submission;
    } else {
      // Create new submission
      const { data: submission, error } = await serviceSupabase
        .from("assignment_submissions")
        .insert([{
          ...submissionData,
          assignment_id: assignmentId,
          student_id: user.id,
          created_at: now
        }])
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          return conflict("A submission already exists; please retry");
        }
        return serverError("Failed to create submission", error);
      }
      result = submission;
    }

    return NextResponse.json({
      success: true,
      submission: result,
      message: status === 'draft'
        ? 'Draft saved successfully'
        : originalSubmittedAt
          ? 'Assignment resubmitted successfully'
          : 'Assignment submitted successfully'
    });

  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: assignmentId } = await params;
    const user = await getCurrentUser();
    if (!user) {
      return unauthorized();
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Check if this is a request for all submissions (instructor view)
    const url = new URL(request.url);
    const allSubmissions = url.searchParams.get('all') === '1';

    const { data: assignment, error: assignmentError } = await serviceSupabase
      .from("assignments")
      .select("creator_id, lesson_id, course_id, anonymous_grading, published")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError || !assignment) {
      return notFound("Assignment not found");
    }

    const courseId = await courseIdForAssignment(assignmentId);
    const access = courseId
      ? await getCourseAccess(user.id, user.role, courseId)
      : null;
    const isCreator = assignment.creator_id === user.id;
    const isStaffRole = !!user.role && ['admin', 'super_admin', 'curriculum_designer'].includes(user.role);
    const canManage = isCreator || isStaffRole || !!access?.canManage;

    if (allSubmissions) {
      // Instructor view - get all submissions for this assignment
      if (!canManage) {
        return forbidden("Access denied");
      }

      // Get all submissions for this assignment with student info
      const { data: submissions, error: submissionsError } = await serviceSupabase
        .from("assignment_submissions")
        .select(`
          *,
          users!assignment_submissions_student_id_fkey(
            id,
            email,
            name
          )
        `)
        .eq("assignment_id", assignmentId)
        .order("submitted_at", { ascending: false });

      if (submissionsError) {
        return serverError("Failed to fetch submissions", submissionsError);
      }

      // If anonymous grading is enabled, mask student information
      let processedSubmissions = submissions || [];
      const isAnonymous = assignment.anonymous_grading === true;

      if (isAnonymous) {
        // Shuffle submissions deterministically by assignment ID to ensure stable anonymous numbering
        const shuffled = [...processedSubmissions].sort((a: any, b: any) => {
          const hashA = (a.id || '').split('').reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 0);
          const hashB = (b.id || '').split('').reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 0);
          return hashA - hashB;
        });
        processedSubmissions = shuffled.map((sub: any, index: number) => ({
          ...sub,
          users: {
            id: `anonymous_${index + 1}`,
            email: `student_${index + 1}@anonymous`,
            name: `Student ${index + 1}`
          },
          _anonymous: true
        }));
      }

      return NextResponse.json({
        submissions: processedSubmissions,
        anonymous_grading: isAnonymous
      });
    }

    // Student view - get only the user's own submission. Students must be
    // able to view the course (active/completed enrollment).
    if (!canManage && access && !access.canView) {
      return forbidden("Access denied");
    }

    const { data: submission, error } = await serviceSupabase
      .from("assignment_submissions")
      .select("*")
      .eq("assignment_id", assignmentId)
      .eq("student_id", user.id)
      .maybeSingle();

    if (error) {
      return serverError("Failed to fetch submission", error);
    }

    return NextResponse.json({
      submission: submission || null
    });

  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
