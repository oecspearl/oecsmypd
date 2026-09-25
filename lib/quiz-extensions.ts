import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCourseAccess, courseIdForQuiz, type CourseAccess } from "@/lib/course-access";
import { isAdminRole } from "@/lib/rbac";

export interface QuizExtension {
  id: string;
  quiz_id: string;
  student_id: string;
  course_id: string;
  extended_due_date: string | null;
  extended_available_until: string | null;
  extra_time_minutes: number | null;
  extra_attempts: number | null;
  reason: string | null;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

export interface EffectiveQuizSettings {
  due_date: string | null;
  available_from: string | null;
  available_until: string | null;
  time_limit: number | null;
  attempts_allowed: number;
  has_extension: boolean;
}

/**
 * Get the extension record for a specific student and quiz.
 * Returns null if no extension exists.
 */
export async function getStudentExtension(
  quizId: string,
  studentId: string
): Promise<QuizExtension | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("quiz_extensions")
    .select("*")
    .eq("quiz_id", quizId)
    .eq("student_id", studentId)
    .maybeSingle();

  if (error) {
    console.error("[QuizExtensions] Error fetching extension:", error);
    return null;
  }
  return data;
}

/**
 * Merge quiz defaults with a student's extension to produce effective settings.
 * Pure function — no I/O.
 */
export function resolveEffectiveSettings(
  quiz: {
    due_date?: string | null;
    available_from?: string | null;
    available_until?: string | null;
    time_limit?: number | null;
    attempts_allowed?: number;
  },
  extension: QuizExtension | null
): EffectiveQuizSettings {
  const baseAttempts = Number(quiz.attempts_allowed ?? 1);
  const baseTimeLimit = quiz.time_limit ?? null;

  if (!extension) {
    return {
      due_date: quiz.due_date ?? null,
      available_from: quiz.available_from ?? null,
      available_until: quiz.available_until ?? null,
      time_limit: baseTimeLimit,
      attempts_allowed: baseAttempts,
      has_extension: false,
    };
  }

  return {
    due_date: extension.extended_due_date ?? quiz.due_date ?? null,
    available_from: quiz.available_from ?? null,
    available_until: extension.extended_available_until ?? quiz.available_until ?? null,
    time_limit:
      baseTimeLimit !== null && extension.extra_time_minutes !== null
        ? baseTimeLimit + extension.extra_time_minutes
        : baseTimeLimit,
    attempts_allowed: baseAttempts + (extension.extra_attempts ?? 0),
    has_extension: true,
  };
}

/**
 * Get all extensions for a quiz (instructor view).
 */
export async function getQuizExtensions(quizId: string): Promise<QuizExtension[]> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("quiz_extensions")
    .select("*")
    .eq("quiz_id", quizId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[QuizExtensions] Error fetching extensions:", error);
    return [];
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Quiz access + answer-key stripping
// ---------------------------------------------------------------------------


export interface QuizAccess extends CourseAccess {
  quizExists: boolean;
  courseId: string | null;
  /** Minimal quiz row used for the gate. */
  quiz: { id: string; course_id: string | null; lesson_id: string | null; creator_id: string | null; published: boolean | null } | null;
}

/**
 * Resolve the caller's relationship to a quiz via its course.
 * The quiz creator is always treated as a manager (covers quizzes that are not
 * yet linked to a course). Admins are always managers.
 */
export async function resolveQuizAccess(
  userId: string,
  userRole: string | null | undefined,
  quizId: string
): Promise<QuizAccess> {
  const supabase = createServiceSupabaseClient();
  const { data: quiz } = await supabase
    .from("quizzes")
    .select("id, course_id, lesson_id, creator_id, published")
    .eq("id", quizId)
    .maybeSingle();

  if (!quiz) {
    return { role: "none", canManage: false, canView: false, courseExists: false, quizExists: false, courseId: null, quiz: null };
  }

  const courseId = quiz.course_id ?? (await courseIdForQuiz(quizId));
  let access: CourseAccess = courseId
    ? await getCourseAccess(userId, userRole, courseId)
    : { role: "none", canManage: false, canView: false, courseExists: false };

  if (!access.canManage && (isAdminRole(userRole) || quiz.creator_id === userId)) {
    access = { ...access, role: isAdminRole(userRole) ? "admin" : "instructor", canManage: true, canView: true };
  }

  return { ...access, quizExists: true, courseId, quiz };
}

const QUESTION_KEY_FIELDS = ["correct_answer", "feedback_correct", "feedback_incorrect", "explanation"] as const;
const OPTION_KEY_FIELDS = ["is_correct", "isCorrect", "correct"] as const;

/**
 * Remove answer-key / correctness fields from a question row before sending it
 * to a student. Options keep their id/text so the player can render them.
 */
export function stripQuestionAnswerKey<T extends Record<string, any>>(question: T): Omit<T, (typeof QUESTION_KEY_FIELDS)[number]> {
  const copy: Record<string, any> = { ...question };
  for (const f of QUESTION_KEY_FIELDS) delete copy[f];
  if (Array.isArray(copy.options)) {
    copy.options = copy.options.map((opt: any) => {
      if (!opt || typeof opt !== "object") return opt;
      const o = { ...opt };
      for (const f of OPTION_KEY_FIELDS) delete o[f];
      return o;
    });
  }
  return copy as any;
}

export function stripQuestionsAnswerKey<T extends Record<string, any>>(questions: T[]): Array<Omit<T, (typeof QUESTION_KEY_FIELDS)[number]>> {
  return (questions || []).map((q) => stripQuestionAnswerKey(q));
}

// ---------------------------------------------------------------------------
// Gradebook sync (shared by auto-grading on submit and manual grading)
// ---------------------------------------------------------------------------

/** Sum of question points for a quiz (the true max score). */
export async function calculateQuizTotalPoints(supabase: any, quizId: string): Promise<number> {
  const { data: questions, error } = await supabase.from("questions").select("points").eq("quiz_id", quizId);
  if (error || !questions) {
    console.error("[QuizGradebook] Failed to fetch questions for points calculation:", error);
    return 0;
  }
  return questions.reduce((sum: number, q: any) => sum + Number(q.points ?? 0), 0);
}

/**
 * Upsert the student's course_grades row for this quiz from their BEST graded
 * attempt (highest percentage, then most recent). Creates the grade item on
 * first use and keeps its points in sync with the question total.
 */
export async function syncQuizToGradebook(supabase: any, quizId: string, courseId: string, studentId: string): Promise<void> {
  if (!quizId || !courseId || !studentId) return;

  let { data: gradeItem, error: itemError } = await supabase
    .from("course_grade_items")
    .select("*")
    .eq("course_id", courseId)
    .eq("type", "quiz")
    .eq("assessment_id", quizId)
    .maybeSingle();

  if (itemError || !gradeItem) {
    const { data: quiz, error: quizError } = await supabase.from("quizzes").select("*").eq("id", quizId).single();
    if (quizError || !quiz) {
      console.error("[QuizGradebook] Failed to fetch quiz details:", quizError);
      return;
    }

    const totalPoints = await calculateQuizTotalPoints(supabase, quizId);
    const pointsToUse = totalPoints > 0 ? totalPoints : (quiz.points || 100);

    const { data: newGradeItem, error: createError } = await supabase
      .from("course_grade_items")
      .insert([{
        course_id: courseId,
        title: quiz.title,
        type: "quiz",
        category: "Quizzes",
        points: pointsToUse,
        assessment_id: quizId,
        due_date: quiz.due_date,
        weight: 1.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])
      .select()
      .single();

    if (createError || !newGradeItem) {
      console.error("[QuizGradebook] Failed to create grade item:", createError);
      return;
    }
    gradeItem = newGradeItem;
  } else {
    const totalPoints = await calculateQuizTotalPoints(supabase, quizId);
    const currentPoints = Number(gradeItem.points || 0);

    if (totalPoints > 0 && currentPoints !== totalPoints) {
      const { error: updateError } = await supabase
        .from("course_grade_items")
        .update({ points: totalPoints, updated_at: new Date().toISOString() })
        .eq("id", gradeItem.id);

      if (!updateError) {
        gradeItem.points = totalPoints;

        const { data: existingGrades, error: gradesError } = await supabase
          .from("course_grades")
          .select("id, score")
          .eq("grade_item_id", gradeItem.id);

        if (!gradesError && existingGrades && existingGrades.length > 0) {
          for (const grade of existingGrades) {
            const newPercentage = totalPoints > 0 ? (Number(grade.score) / totalPoints) * 100 : 0;
            await supabase
              .from("course_grades")
              .update({
                max_score: totalPoints,
                percentage: Number(newPercentage.toFixed(2)),
                updated_at: new Date().toISOString(),
              })
              .eq("id", grade.id);
          }
        }
      }
    }
  }

  const { data: attempt, error: attemptError } = await supabase
    .from("quiz_attempts")
    .select("*")
    .eq("quiz_id", quizId)
    .eq("student_id", studentId)
    .eq("status", "graded")
    .order("percentage", { ascending: false })
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (attemptError || !attempt) return;

  const { data: existingGrade } = await supabase
    .from("course_grades")
    .select("id")
    .eq("course_id", courseId)
    .eq("student_id", attempt.student_id)
    .eq("grade_item_id", gradeItem.id)
    .maybeSingle();

  const percentage = gradeItem.points > 0 ? (attempt.score / gradeItem.points) * 100 : 0;

  if (existingGrade) {
    await supabase
      .from("course_grades")
      .update({
        score: attempt.score,
        max_score: gradeItem.points,
        percentage: Number(percentage.toFixed(2)),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingGrade.id);
  } else {
    await supabase
      .from("course_grades")
      .insert([{
        course_id: courseId,
        student_id: attempt.student_id,
        grade_item_id: gradeItem.id,
        score: attempt.score,
        max_score: gradeItem.points,
        percentage: Number(percentage.toFixed(2)),
        graded_at: attempt.submitted_at ?? new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }]);
  }
}
