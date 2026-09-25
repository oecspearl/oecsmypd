import { NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole, type UserRole } from "@/lib/rbac";
import { getCourseAccess } from "@/lib/course-access";
import { badRequest, forbidden, notFound, serverError, unauthorized } from "@/lib/api-errors";

const STAFF_ROLES: UserRole[] = ["instructor", "curriculum_designer", "admin", "super_admin"];

// Course managers: admins, the course owner, and co-instructors (via getCourseAccess).
async function canManageCourse(userId: string, role: string | null | undefined, courseId: string): Promise<boolean> {
  const access = await getCourseAccess(userId, role, courseId);
  return access.canManage;
}

// Helper function to get course_id from lesson_id
async function getCourseIdFromLesson(supabase: any, lessonId: string): Promise<string | null> {
  const { data } = await supabase
    .from("lessons")
    .select("course_id")
    .eq("id", lessonId)
    .single();

  return data?.course_id || null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const serviceSupabase = createServiceSupabaseClient();

    const { data: assignment, error } = await serviceSupabase
      .from("assignments")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !assignment) {
      return notFound("Assignment not found");
    }

    // Gate on the assignment's course: managers see everything, enrolled
    // students only see published assignments.
    const courseId = assignment.course_id || (assignment.lesson_id ? await getCourseIdFromLesson(serviceSupabase, assignment.lesson_id) : null);
    const isCreator = assignment.creator_id === user.id;
    const isStaffAdmin = hasRole(user.role, ["admin", "super_admin", "curriculum_designer"]);
    if (courseId) {
      const access = await getCourseAccess(user.id, user.role, courseId);
      const canManage = isCreator || isStaffAdmin || access.canManage;
      if (!canManage) {
        if (!access.canView || assignment.published === false) {
          return notFound("Assignment not found");
        }
      }
    } else if (!isCreator && !isStaffAdmin && !hasRole(user.role, STAFF_ROLES)) {
      return forbidden();
    }

    // Parse rubric if stored as JSON string
    if (assignment.rubric && typeof assignment.rubric === 'string') {
      try { assignment.rubric = JSON.parse(assignment.rubric); } catch { assignment.rubric = []; }
    }

    return NextResponse.json(assignment);
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!hasRole(user.role, STAFF_ROLES)) {
      return forbidden();
    }

    let data: any;
    try {
      data = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    const supabase = await createServerSupabaseClient();
    
    // Check if user can edit this assignment (creator, course instructor, or admin)
    const { data: existingAssignment, error: fetchError } = await supabase
      .from("assignments")
      .select("creator_id, lesson_id, course_id")
      .eq("id", id)
      .single();

    if (fetchError || !existingAssignment) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    // Get course_id from lesson if not directly set
    let courseId = existingAssignment.course_id;
    if (!courseId && existingAssignment.lesson_id) {
      courseId = await getCourseIdFromLesson(supabase, existingAssignment.lesson_id);
    }

    // Check authorization: creator, course manager (owner/co-instructor), or admin
    const isCreator = existingAssignment.creator_id === user.id;
    const isAdmin = hasRole(user.role, ["admin", "super_admin"]);
    const isCourseManager = courseId ? await canManageCourse(user.id, user.role, courseId) : false;

    if (!isCreator && !isAdmin && !isCourseManager) {
      return forbidden("You don't have permission to edit this assignment");
    }

    // Moving an assignment into a different course requires manage rights there too.
    if (data.course_id && data.course_id !== courseId && !isAdmin) {
      const targetOk = await canManageCourse(user.id, user.role, String(data.course_id));
      if (!targetOk) return forbidden("You do not manage the target course");
    }
    
    const updateData = {
      lesson_id: data.lesson_id ?? null,
      course_id: data.course_id ?? courseId ?? null,
      class_id: data.class_id ?? null,
      title: String(data.title || ""),
      description: String(data.description || ""),
      due_date: data.due_date ?? null,
      points: Number(data.points ?? 100),
      submission_types: Array.isArray(data.submission_types) ? data.submission_types : ["file"],
      file_types_allowed: Array.isArray(data.file_types_allowed) ? data.file_types_allowed : null,
      max_file_size: Number(data.max_file_size ?? 50),
      rubric: Array.isArray(data.rubric) ? data.rubric : [],
      allow_late_submissions: Boolean(data.allow_late_submissions ?? true),
      late_penalty: data.late_penalty ?? null,
      anonymous_grading: Boolean(data.anonymous_grading ?? false),
      peer_review_enabled: Boolean(data.peer_review_enabled ?? false),
      peer_reviews_required: Number(data.peer_reviews_required ?? 2),
      peer_review_due_date: data.peer_review_due_date ?? null,
      peer_review_anonymous: Boolean(data.peer_review_anonymous ?? true),
      is_group_assignment: Boolean(data.is_group_assignment ?? false),
      group_set_id: data.group_set_id ?? null,
      one_submission_per_group: Boolean(data.one_submission_per_group ?? true),
      published: Boolean(data.published ?? false),
      updated_at: new Date().toISOString()
    };
    
    const { data: assignment, error } = await supabase
      .from("assignments")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();
    
    if (error) {
      return serverError("Failed to update assignment", error);
    }
    
    // Sync with gradebook if assignment is associated with a course
    const syncCourseId = assignment.course_id || (assignment.lesson_id ? await getCourseIdFromLesson(supabase, assignment.lesson_id) : null);
    if (syncCourseId) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/courses/${syncCourseId}/gradebook/quiz-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assessmentId: id,
            assessmentType: 'assignment',
            action: 'updated'
          })
        });
      } catch (syncError) {
        console.error('Gradebook sync error:', syncError);
        // Don't fail the assignment update if sync fails
      }
    }
    
    return NextResponse.json(assignment);
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!hasRole(user.role, STAFF_ROLES)) {
      return forbidden();
    }

    const supabase = await createServerSupabaseClient();

    // Check if user can delete this assignment
    const { data: assignment, error: assignmentError } = await supabase
      .from("assignments")
      .select("creator_id, lesson_id, course_id")
      .eq("id", id)
      .single();

    if (assignmentError || !assignment) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    // Get course_id from lesson if not directly set
    let courseId = assignment.course_id;
    if (!courseId && assignment.lesson_id) {
      courseId = await getCourseIdFromLesson(supabase, assignment.lesson_id);
    }

    // Check authorization: creator, course manager (owner/co-instructor), or admin
    const isCreator = assignment.creator_id === user.id;
    const isAdmin = hasRole(user.role, ["admin", "super_admin"]);
    const isCourseManager = courseId ? await canManageCourse(user.id, user.role, courseId) : false;

    if (!isCreator && !isAdmin && !isCourseManager) {
      return forbidden("You don't have permission to delete this assignment");
    }

    // Get assignment data before deletion for sync
    const { data: assignmentToDelete } = await supabase
      .from("assignments")
      .select("lesson_id")
      .eq("id", id)
      .single();

    // Clean up gradebook items and student grades associated with this assignment
    // Use service client to bypass RLS
    const serviceSupabase = createServiceSupabaseClient();
    const { data: gradeItems } = await serviceSupabase
      .from("course_grade_items")
      .select("id")
      .eq("type", "assignment")
      .eq("assessment_id", id);

    if (gradeItems && gradeItems.length > 0) {
      const gradeItemIds = gradeItems.map(item => item.id);

      // Delete student grades for these grade items first (due to foreign key constraint)
      const { error: gradesDeleteError } = await serviceSupabase
        .from("course_grades")
        .delete()
        .in("grade_item_id", gradeItemIds);

      if (gradesDeleteError) {
        console.error('Error deleting student grades for assignment:', gradesDeleteError);
      }

      // Delete the grade items
      const { error: itemsDeleteError } = await serviceSupabase
        .from("course_grade_items")
        .delete()
        .in("id", gradeItemIds);

      if (itemsDeleteError) {
        console.error('Error deleting grade items for assignment:', itemsDeleteError);
      }

      console.log(`Cleaned up ${gradeItemIds.length} grade items for deleted assignment ${id}`);
    }

    const { error } = await supabase
      .from("assignments")
      .delete()
      .eq("id", id);
    
    if (error) {
      return serverError("Failed to delete assignment", error);
    }

    // Remove assignment from lesson content if it was associated with a lesson
    if (assignmentToDelete?.lesson_id) {
      try {
        // Get the current lesson content
        const { data: lesson, error: lessonError } = await supabase
          .from("lessons")
          .select("content")
          .eq("id", assignmentToDelete.lesson_id)
          .single();

        if (!lessonError && lesson) {
          const currentContent = lesson.content || [];
          
          // Remove assignment from lesson content
          const newContent = currentContent.filter((item: any) => 
            !(item.type === 'assignment' && item.data?.assignmentId === id)
          );

          // Update the lesson with the filtered content
          await supabase
            .from("lessons")
            .update({ content: newContent })
            .eq("id", assignmentToDelete.lesson_id);
        }
      } catch (contentError) {
        console.error('Error removing assignment from lesson content:', contentError);
        // Don't fail the assignment deletion if content update fails
      }
    }
    
    // Sync with gradebook if assignment was associated with a course
    if (assignmentToDelete?.lesson_id) {
      try {
        // Get the course_id from the lesson
        const { data: lesson } = await supabase
          .from("lessons")
          .select("course_id")
          .eq("id", assignmentToDelete.lesson_id)
          .single();
        
        if (lesson?.course_id) {
          await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/courses/${lesson.course_id}/gradebook/quiz-sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assessmentId: id,
              assessmentType: 'assignment',
              action: 'deleted'
            })
          });
        }
      } catch (syncError) {
        console.error('Gradebook sync error:', syncError);
        // Don't fail the assignment deletion if sync fails
      }
    }
    
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
