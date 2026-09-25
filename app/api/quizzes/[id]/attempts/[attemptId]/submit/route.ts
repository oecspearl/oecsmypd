import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { generateAdaptiveRecommendations, updateCompetenciesFromQuiz } from "@/lib/adaptive-learning";
import { getStudentExtension, resolveEffectiveSettings, syncQuizToGradebook } from "@/lib/quiz-extensions";
import { unauthorized, forbidden, notFound, badRequest, conflict, serverError } from "@/lib/api-errors";

/** Seconds of grace after the time limit before a submission is refused outright. */
const HARD_TIME_LIMIT_GRACE_SECONDS = 5 * 60;

type ClientAnswer = { question_id: string; answer: unknown };
type GradedAnswer = { question_id: string; answer: unknown; correct: boolean; points_earned: number; feedback?: string };

const MANUAL_TYPES = new Set(["essay", "fill_blank", "matching"]);

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Grade against the server-side question list. The client answer array is
 * reduced to a Map keyed by question_id (last entry wins) so duplicate
 * entries can never be scored twice, and unknown question ids are ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grade(questions: any[], clientAnswers: unknown) {
  const answerMap = new Map<string, unknown>();
  if (Array.isArray(clientAnswers)) {
    for (const a of clientAnswers as ClientAnswer[]) {
      if (a && typeof a === "object" && typeof a.question_id === "string") {
        answerMap.set(a.question_id, a.answer);
      }
    }
  }

  let score = 0;
  let max = 0;
  const gradedAnswers: GradedAnswer[] = [];

  for (const q of questions) {
    const pts = Math.max(0, Number(q.points ?? 0));
    max += pts;
    if (!answerMap.has(q.id)) continue;

    const answer = answerMap.get(q.id);
    const type = q.type as string;
    let correct = false;
    let earned = 0;

    if (type === "true_false" || type === "multiple_choice") {
      const correctIds = new Set<string>(
        (q.options ?? []).filter((o: { is_correct?: boolean }) => o?.is_correct).map((o: { id: string }) => String(o.id))
      );
      if (Array.isArray(answer)) {
        const picked = new Set((answer as unknown[]).map(String));
        const totalCorrect = correctIds.size;
        const correctlyPicked = Array.from(picked).filter((id) => correctIds.has(id)).length;
        const incorrectlyPicked = Array.from(picked).filter((id) => !correctIds.has(id)).length;
        const ratio = Math.max(0, (correctlyPicked - incorrectlyPicked) / Math.max(1, totalCorrect));
        earned = Math.round(ratio * pts);
        correct = pts > 0 ? earned === pts : correctlyPicked === totalCorrect && incorrectlyPicked === 0;
      } else {
        correct = correctIds.has(String(answer));
        earned = correct ? pts : 0;
      }
    } else if (type === "short_answer") {
      const expected = q.correct_answer;
      const normalized = String(answer ?? "").trim();
      const norm = (s: string) => (q.case_sensitive ? s : s.toLowerCase());
      if (Array.isArray(expected)) {
        correct = expected.some((exp: unknown) => norm(normalized) === norm(String(exp ?? "").trim()));
      } else if (typeof expected === "string") {
        correct = norm(normalized) === norm(expected.trim());
      }
      earned = correct ? pts : 0;
    } else if (MANUAL_TYPES.has(type)) {
      // Requires manual grading; recorded but not scored here.
      earned = 0;
      correct = false;
    }

    earned = clamp(earned, 0, pts);
    const feedback = correct ? (q.feedback_correct ?? undefined) : (q.feedback_incorrect ?? undefined);
    gradedAnswers.push({ question_id: q.id, answer, correct, points_earned: earned, feedback });
    score += earned;
  }

  score = clamp(score, 0, max);
  const percentage = max > 0 ? clamp(Math.round((score / max) * 100), 0, 100) : 0;
  return { score, max, percentage, gradedAnswers };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; attemptId: string }> }) {
  try {
    const { id, attemptId } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    // Service client: ownership is verified below before anything is read or written.
    const supabase = createServiceSupabaseClient();

    const { data: attempt, error: attemptError } = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("id", attemptId)
      .eq("quiz_id", id)
      .maybeSingle();

    if (attemptError) return serverError("Failed to load attempt", attemptError);
    if (!attempt) return notFound("Attempt not found");
    if (attempt.student_id !== user.id) return forbidden();
    if (attempt.status !== "in_progress") return conflict("This attempt has already been submitted");

    const { data: quiz, error: quizError } = await supabase.from("quizzes").select("*").eq("id", id).maybeSingle();
    if (quizError) return serverError("Failed to load quiz", quizError);
    if (!quiz) return notFound("Quiz not found");

    // Extension-aware settings (extra time etc.)
    const extension = await getStudentExtension(id, attempt.student_id);
    const effective = resolveEffectiveSettings(quiz, extension);

    const { data: questions, error: questionsError } = await supabase
      .from("questions")
      .select("*")
      .eq("quiz_id", id)
      .order("order", { ascending: true })
      .limit(300);
    if (questionsError) return serverError("Failed to fetch questions", questionsError);

    // Server clock is authoritative for elapsed time.
    const now = new Date();
    const startedMs = attempt.started_at ? new Date(attempt.started_at).getTime() : now.getTime();
    const timeTaken = Math.max(0, Math.floor((now.getTime() - startedMs) / 1000));

    const limitMinutes = Number(effective.time_limit ?? 0);
    if (limitMinutes > 0) {
      const limitSeconds = limitMinutes * 60;
      if (timeTaken > limitSeconds + HARD_TIME_LIMIT_GRACE_SECONDS) {
        return badRequest("Time limit exceeded");
      }
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const clientAnswers = body?.answers !== undefined ? body.answers : attempt.answers;
    if (clientAnswers !== undefined && clientAnswers !== null && !Array.isArray(clientAnswers)) {
      return badRequest("answers must be an array");
    }

    const { score, max, percentage, gradedAnswers } = grade(questions || [], clientAnswers ?? []);

    // Any manually graded question type leaves the attempt awaiting an instructor.
    const hasManual = (questions || []).some((q) => MANUAL_TYPES.has(q.type));
    const status = hasManual ? "submitted" : "graded";

    // Guard against a concurrent submit of the same attempt.
    const { data: updated, error: updateError } = await supabase
      .from("quiz_attempts")
      .update({
        submitted_at: now.toISOString(),
        score,
        max_score: max,
        percentage,
        answers: gradedAnswers,
        time_taken: timeTaken,
        status,
        updated_at: now.toISOString(),
      })
      .eq("id", attemptId)
      .eq("status", "in_progress")
      .select("id")
      .maybeSingle();

    if (updateError) return serverError("Failed to submit quiz attempt", updateError);
    if (!updated) return conflict("This attempt has already been submitted");

    if (!hasManual) {
      try {
        await syncQuizToGradebook(supabase, id, attempt.course_id, user.id);
      } catch (syncError) {
        console.error("[QuizSubmit] Gradebook sync error:", syncError);
      }
    }

    try {
      await generateAdaptiveRecommendations(attemptId, user.id);
    } catch (recError) {
      console.error("[QuizSubmit] Adaptive recommendations error:", recError);
    }

    try {
      await updateCompetenciesFromQuiz(id, user.id, percentage);
    } catch (compError) {
      console.error("[QuizSubmit] Competency update error:", compError);
    }

    return NextResponse.json({ score, max_score: max, percentage, status, time_taken: timeTaken });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
