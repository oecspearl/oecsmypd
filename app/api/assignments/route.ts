import { NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole, type UserRole } from "@/lib/rbac";
import { getCourseAccess, courseIdForLesson } from "@/lib/course-access";
import { badRequest, forbidden, notFound, serverError, unauthorized } from "@/lib/api-errors";

const STAFF_ROLES: UserRole[] = ["instructor", "curriculum_designer", "admin", "super_admin"];

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return unauthorized();
    }

    const { searchParams } = new URL(request.url);
    const lessonId = searchParams.get("lesson_id");
    const courseIdParam = searchParams.get("course_id");
    const published = searchParams.get("published");

    // Resolve the course being queried so we can gate access on it.
    let courseId: string | null = courseIdParam;
    if (!courseId && lessonId) {
      courseId = await courseIdForLesson(lessonId);
      if (!courseId) return notFound("Lesson not found");
    }

    // Course-scoped access: managers see everything, enrolled students only
    // see published assignments. Everyone else is refused.
    let restrictToPublished = false;
    if (courseId) {
      const access = await getCourseAccess(user.id, user.role, courseId);
      if (!access.courseExists) return notFound("Course not found");
      const canManage = access.canManage || user.role === "curriculum_designer";
      if (!canManage) {
        if (!access.canView) return forbidden();
        restrictToPublished = true;
      }
    } else if (!hasRole(user.role, STAFF_ROLES)) {
      // Unscoped listing is a staff-only view.
      return badRequest("course_id or lesson_id is required");
    }

    // Use the service client for course-scoped reads (access already checked);
    // fall back to the RLS-bound client for the unscoped staff listing.
    const supabase = courseId ? createServiceSupabaseClient() : await createServerSupabaseClient();

    let query = supabase.from("assignments").select("*");

    // Apply filters
    if (lessonId) query = query.eq("lesson_id", lessonId);
    if (published !== null) query = query.eq("published", published === "true");
    if (restrictToPublished) query = query.eq("published", true);

    // For course_id filter: also include assignments linked via lesson_id
    if (courseIdParam) {
      // Get all lesson IDs belonging to this course
      const { data: courseLessons } = await supabase
        .from("lessons")
        .select("id")
        .eq("course_id", courseIdParam);

      const lessonIds = courseLessons?.map((l: any) => l.id) || [];

      if (lessonIds.length > 0) {
        // Match assignments by course_id OR by lesson_id belonging to the course
        query = query.or(`course_id.eq.${courseIdParam},lesson_id.in.(${lessonIds.join(",")})`);
      } else {
        query = query.eq("course_id", courseIdParam);
      }
    }

    const { data: assignments, error } = await query.order("created_at", { ascending: false });

    if (error) {
      return serverError("Failed to fetch assignments", error);
    }

    // Parse rubric JSON strings back to arrays for all assignments
    const parsedAssignments = assignments?.map(assignment => {
      if (assignment.rubric && typeof assignment.rubric === 'string') {
        try {
          assignment.rubric = JSON.parse(assignment.rubric);
        } catch (parseError) {
          console.error('Error parsing rubric for assignment:', assignment.id, parseError);
          assignment.rubric = [];
        }
      } else if (!assignment.rubric) {
        assignment.rubric = [];
      }
      return assignment;
    }) || [];

    return NextResponse.json({ assignments: parsedAssignments });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return unauthorized();
    }
    if (!hasRole(user.role, STAFF_ROLES)) {
      return forbidden();
    }

    const supabase = await createServerSupabaseClient();
    let data: any;
    try {
      data = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    // If lesson_id is provided, fetch the course_id from the lesson
    let courseId: string | null = data.course_id ?? null;
    if (data.lesson_id && !courseId) {
      courseId = await courseIdForLesson(data.lesson_id);
    }

    // Creating an assignment in a course requires manage rights on that course.
    if (courseId) {
      const access = await getCourseAccess(user.id, user.role, courseId);
      if (!access.courseExists) return notFound("Course not found");
      if (!access.canManage && user.role !== "curriculum_designer") {
        return forbidden("You do not manage this course");
      }
    }

    const payload = {
      lesson_id: data.lesson_id ?? null,
      course_id: courseId, // Automatically set from lesson if available
      class_id: data.class_id ?? null, // Keep for backward compatibility
      title: String(data.title || "Untitled Assignment"),
      description: String(data.description || ""),
      due_date: data.due_date ?? null,
      points: Number(data.points ?? 100),
      submission_types: Array.isArray(data.submission_types) ? data.submission_types : ["file"],
      file_types_allowed: Array.isArray(data.file_types_allowed) ? data.file_types_allowed : null,
      max_file_size: Number(data.max_file_size ?? 50),
      rubric: Array.isArray(data.rubric) ? data.rubric : [],
      allow_late_submissions: Boolean(data.allow_late_submissions ?? true),
      late_penalty: data.late_penalty ?? null,
      published: Boolean(data.published ?? false),
      show_in_curriculum: Boolean(data.show_in_curriculum ?? false),
      curriculum_order: data.curriculum_order ?? null,
      creator_id: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: assignment, error } = await supabase
      .from("assignments")
      .insert([payload])
      .select()
      .single();

    if (error) {
      return serverError("Failed to create assignment", error);
    }

    // If assignment is associated with a lesson, add it to the lesson's content
    if (assignment.lesson_id) {
      try {
        const assignmentContentItem = {
          type: 'assignment',
          title: assignment.title,
          data: { assignmentId: assignment.id },
          id: `assignment-${assignment.id}`
        };

        // Use atomic append via Postgres to avoid read-modify-write race
        const { error: rpcError } = await supabase.rpc('append_lesson_content', {
          p_lesson_id: assignment.lesson_id,
          p_content_item: assignmentContentItem
        });

        // Fallback to read-modify-write if RPC doesn't exist
        if (rpcError && rpcError.code === '42883') {
          const { data: lesson, error: lessonError } = await supabase
            .from("lessons")
            .select("content")
            .eq("id", assignment.lesson_id)
            .single();

          if (!lessonError && lesson) {
            const currentContent = lesson.content || [];
            const assignmentExists = currentContent.some((item: any) =>
              item.type === 'assignment' && item.data?.assignmentId === assignment.id
            );

            if (!assignmentExists) {
              await supabase
                .from("lessons")
                .update({ content: [...currentContent, assignmentContentItem] })
                .eq("id", assignment.lesson_id);
            }
          }
        }
      } catch (contentError) {
        console.error('Error adding assignment to lesson content:', contentError);
        // Don't fail the assignment creation if content update fails
      }
    }

    return NextResponse.json({ id: assignment.id });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
