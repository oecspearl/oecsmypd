import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole, isAdminRole } from "@/lib/rbac";
import { unauthorized, forbidden, serverError } from "@/lib/api-errors";
import { getCourseAccess, courseIdForLesson } from "@/lib/course-access";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const lessonId = searchParams.get("lesson_id");
    const courseId = searchParams.get("course_id");
    const published = searchParams.get("published");

    const isStaff = hasRole(user.role, ["instructor", "curriculum_designer", "admin", "super_admin"]);
    const isAdmin = isAdminRole(user.role);

    // Service client: scope is restricted below based on the caller's access.
    const supabase = createServiceSupabaseClient();

    // Resolve the course being asked about (directly, or via the lesson).
    let scopeCourseId: string | null = courseId;
    if (!scopeCourseId && lessonId) scopeCourseId = await courseIdForLesson(lessonId);

    let query = supabase.from("quizzes").select("*");
    let forceStudentView = false;

    if (scopeCourseId) {
      const access = await getCourseAccess(user.id, user.role, scopeCourseId);
      if (!access.canView) return forbidden();
      forceStudentView = !access.canManage;
    } else if (!isAdmin) {
      if (isStaff) {
        // Instructors: quizzes they created or that belong to courses they teach.
        const { data: coTaught } = await supabase
          .from("course_instructors")
          .select("course_id")
          .eq("instructor_id", user.id);
        const courseIds = Array.from(new Set((coTaught || []).map((c: any) => c.course_id).filter(Boolean)));
        const parts = [`creator_id.eq.${user.id}`];
        if (courseIds.length > 0) parts.push(`course_id.in.(${courseIds.join(",")})`);
        query = query.or(parts.join(","));
      } else {
        // Students: only published quizzes in courses they are actively enrolled in.
        const { data: enrollments } = await supabase
          .from("enrollments")
          .select("course_id")
          .eq("student_id", user.id)
          .in("status", ["active", "completed"]);
        const courseIds = Array.from(new Set((enrollments || []).map((e: any) => e.course_id).filter(Boolean)));
        if (courseIds.length === 0) return NextResponse.json({ quizzes: [] });
        query = query.in("course_id", courseIds);
        forceStudentView = true;
      }
    }

    if (lessonId) query = query.eq("lesson_id", lessonId);
    if (courseId) query = query.eq("course_id", courseId);
    if (forceStudentView) {
      query = query.eq("published", true);
    } else if (published !== null) {
      query = query.eq("published", published === "true");
    }

    query = query.order("created_at", { ascending: false });
    const { data: quizzes, error } = await query.limit(100);
    if (error) return serverError("Failed to fetch quizzes", error);

    const validQuizzes = (quizzes || []).filter((quiz) => quiz && quiz.id);
    return NextResponse.json({ quizzes: validQuizzes });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user || !hasRole(user.role, ["instructor", "curriculum_designer", "admin", "super_admin"])) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Use service client to bypass RLS and prevent infinite recursion
    const serviceSupabase = createServiceSupabaseClient();
    const data = await request.json();

    // Get course_id - use provided course_id, or get from lesson if lesson_id is provided
    let courseId = data.course_id || null;
    if (!courseId && data.lesson_id) {
      const { data: lesson, error: lessonError } = await serviceSupabase
        .from("lessons")
        .select("course_id")
        .eq("id", data.lesson_id)
        .single();

      if (lessonError || !lesson) {
        console.error('Lesson fetch error:', lessonError);
        return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
      }

      courseId = lesson.course_id;
      console.log('Quiz creation: Setting course_id from lesson:', courseId);
    }
    
    // Require course_id
    if (!courseId) {
      return NextResponse.json({ error: "Course is required. Please select a course or provide a lesson that belongs to a course." }, { status: 400 });
    }

    const payload = {
      lesson_id: data.lesson_id ?? null,
      course_id: courseId, // Add course_id to the payload
      title: String(data.title || "Untitled Quiz"),
      description: String(data.description || ""),
      instructions: String(data.instructions || ""),
      time_limit: data.time_limit ?? null,
      attempts_allowed: Number(data.attempts_allowed ?? 1),
      show_correct_answers: Boolean(data.show_correct_answers),
      show_feedback: String(data.show_feedback ?? "after_submit"),
      randomize_questions: Boolean(data.randomize_questions),
      randomize_answers: Boolean(data.randomize_answers),
      passing_score: data.passing_score ?? null,
      due_date: data.due_date ?? null,
      available_from: data.available_from ?? null,
      available_until: data.available_until ?? null,
      points: Number(data.points ?? 0),
      published: Boolean(data.published),
      proctored_mode: Boolean(data.proctored_mode),
      proctor_settings: data.proctored_mode ? (data.proctor_settings ?? null) : null,
      show_in_curriculum: Boolean(data.show_in_curriculum),
      curriculum_order: data.curriculum_order ?? null,
      creator_id: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: quiz, error } = await serviceSupabase
      .from("quizzes")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('Quiz creation error:', error);
      return NextResponse.json({ error: "Failed to create quiz" }, { status: 500 });
    }

    // If quiz was created with a lesson_id, automatically add it to the lesson content
    if (quiz.lesson_id) {
      try {
        // Create quiz content item
        const quizContentItem = {
          type: 'quiz',
          title: quiz.title,
          data: {
            quizId: quiz.id,
            description: quiz.description || '',
            points: quiz.points || 100,
            timeLimit: quiz.time_limit,
            attemptsAllowed: quiz.attempts_allowed || 1
          },
          id: `quiz-${quiz.id}` // Unique ID for the content item
        };

        // Use atomic append via Postgres to avoid read-modify-write race
        const { error: updateError } = await serviceSupabase.rpc('append_lesson_content', {
          p_lesson_id: quiz.lesson_id,
          p_content_item: quizContentItem
        });

        // Fallback to read-modify-write if RPC doesn't exist
        if (updateError && updateError.code === '42883') {
          const { data: lesson } = await serviceSupabase
            .from("lessons")
            .select("content, course_id")
            .eq("id", quiz.lesson_id)
            .single();

          if (lesson) {
            const currentContent = lesson.content || [];
            const alreadyExists = currentContent.some((item: any) => item.id === `quiz-${quiz.id}`);
            if (!alreadyExists) {
              await serviceSupabase
                .from("lessons")
                .update({ content: [...currentContent, quizContentItem], updated_at: new Date().toISOString() })
                .eq("id", quiz.lesson_id);
            }
          }
        }

        // Get lesson course_id for gradebook sync
        const { data: lesson } = await serviceSupabase
          .from("lessons")
          .select("course_id")
          .eq("id", quiz.lesson_id)
          .single();

          // Also add quiz to gradebook if course_id is available
          if (lesson?.course_id) {
            try {
              // Check if grade item already exists (use service client to bypass RLS)
              const { data: existingGradeItem } = await serviceSupabase
                .from("course_grade_items")
                .select("id")
                .eq("course_id", lesson.course_id)
                .eq("type", "quiz")
                .eq("assessment_id", quiz.id)
                .single();

              if (!existingGradeItem) {
                // Calculate actual total points from questions (not from quiz.points field)
                const { data: questions, error: questionsError } = await serviceSupabase
                  .from("questions")
                  .select("points")
                  .eq("quiz_id", quiz.id);
                
                let totalPoints = 0;
                if (!questionsError && questions) {
                  totalPoints = questions.reduce((sum: number, q: any) => sum + Number(q.points ?? 0), 0);
                }
                const pointsToUse = totalPoints > 0 ? totalPoints : (quiz.points || 100);
                
                // Create grade item for the quiz (use service client to bypass RLS)
                const { error: gradeItemError } = await serviceSupabase
                  .from("course_grade_items")
                  .insert([{
                    course_id: lesson.course_id,
                    title: quiz.title,
                    type: "quiz",
                    category: "Quizzes",
                    points: pointsToUse,
                    assessment_id: quiz.id,
                    due_date: quiz.due_date,
                    weight: 1.0,
                    is_active: true,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                  }]);

                if (gradeItemError) {
                  console.error('Failed to create grade item for quiz:', gradeItemError);
                } else {
                  console.log('Successfully created grade item for quiz:', quiz.id, 'in course:', lesson.course_id);
                }
              } else {
                console.log('Grade item already exists for quiz:', quiz.id);
              }
            } catch (gradebookError) {
              console.error('Error creating gradebook item for quiz:', gradebookError);
              // Don't fail the quiz creation, just log the error
            }
          } else {
            console.log('No course_id found for lesson, skipping gradebook creation');
          }
      } catch (contentError) {
        console.error('Error adding quiz to lesson content:', contentError);
        // Don't fail the quiz creation, just log the error
      }
    }

    return NextResponse.json({ id: quiz.id });
  } catch (e: any) {
    console.error('Quiz POST API error:', e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
