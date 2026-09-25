import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { resolveQuizAccess, syncQuizToGradebook } from "@/lib/quiz-extensions";
import { unauthorized, forbidden, notFound, badRequest, conflict, serverError } from "@/lib/api-errors";

const ATTEMPT_STATUSES = new Set(["in_progress", "submitted", "graded"]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; attemptId: string }> }) {
  try {
    const { id, attemptId } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const supabase = createServiceSupabaseClient();
    const { data: attempt, error } = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("id", attemptId)
      .eq("quiz_id", id)
      .maybeSingle();

    if (error) return serverError("Failed to load attempt", error);
    if (!attempt) return notFound("Quiz attempt not found");

    if (attempt.student_id !== user.id) {
      const access = await resolveQuizAccess(user.id, user.role, id);
      if (!access.canManage) return forbidden();
    }

    return NextResponse.json(attempt);
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

/**
 * PUT semantics:
 *  - Attempt owner (student): may save `answers` (and `time_taken`) only while
 *    the attempt is `in_progress`. Per-answer `correct` / `points_earned` /
 *    `feedback` are stripped. Status, score and percentage are never accepted.
 *  - Course manager (instructor / admin): may set `score`, `percentage`,
 *    `status`, `answers` (with per-answer points for manual grading) and
 *    `time_taken`. Setting `status: "graded"` triggers the gradebook sync.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; attemptId: string }> }) {
  try {
    const { id, attemptId } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const supabase = createServiceSupabaseClient();

    const { data: currentAttempt, error: fetchError } = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("id", attemptId)
      .eq("quiz_id", id)
      .maybeSingle();

    if (fetchError) return serverError("Failed to load attempt", fetchError);
    if (!currentAttempt) return notFound("Quiz attempt not found");

    const isOwner = currentAttempt.student_id === user.id;
    const access = await resolveQuizAccess(user.id, user.role, id);
    const isManager = access.canManage;

    if (!isOwner && !isManager) return forbidden();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    if (!body || typeof body !== "object") return badRequest("Invalid request body");

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (isManager) {
      if (body.answers !== undefined) {
        if (!Array.isArray(body.answers)) return badRequest("answers must be an array");
        updateData.answers = body.answers;
      }
      if (body.time_taken !== undefined) updateData.time_taken = Math.max(0, Math.floor(Number(body.time_taken) || 0));
      if (body.score !== undefined) updateData.score = Math.max(0, Number(body.score) || 0);
      if (body.max_score !== undefined) updateData.max_score = Math.max(0, Number(body.max_score) || 0);
      if (body.percentage !== undefined) {
        updateData.percentage = Math.min(100, Math.max(0, Number(body.percentage) || 0));
      }
      if (body.status !== undefined) {
        if (!ATTEMPT_STATUSES.has(String(body.status))) return badRequest("Invalid status");
        updateData.status = String(body.status);
      }

      // Derive percentage / max_score from the stored values when grading.
      if (updateData.status === "graded" || updateData.score !== undefined) {
        const score = Number(updateData.score ?? currentAttempt.score ?? 0);
        let max = Number(updateData.max_score ?? currentAttempt.max_score ?? 0);
        if (!(max > 0)) {
          const { data: qs } = await supabase.from("questions").select("points").eq("quiz_id", id);
          max = (qs || []).reduce((s: number, q: any) => s + Number(q.points ?? 0), 0);
          if (max > 0) updateData.max_score = max;
        }
        if (updateData.percentage === undefined) {
          updateData.percentage = max > 0 ? Math.min(100, Math.max(0, Math.round((score / max) * 100))) : 0;
        }
        if (updateData.status === "graded" && !currentAttempt.submitted_at) {
          updateData.submitted_at = new Date().toISOString();
        }
      }
    } else {
      // Student saving progress on their own attempt.
      if (currentAttempt.status !== "in_progress") {
        return conflict("This attempt has already been submitted");
      }
      if (body.answers !== undefined) {
        if (!Array.isArray(body.answers)) return badRequest("answers must be an array");
        // Keep only the raw answer; correctness is computed server-side on submit.
        updateData.answers = body.answers
          .filter((a: any) => a && typeof a === "object" && typeof a.question_id === "string")
          .map((a: any) => ({ question_id: a.question_id, answer: a.answer }));
      }
      if (body.time_taken !== undefined) {
        updateData.time_taken = Math.max(0, Math.floor(Number(body.time_taken) || 0));
      }
    }

    let query = supabase.from("quiz_attempts").update(updateData).eq("id", attemptId);
    // Students can only write while in progress (guards a concurrent submit).
    if (!isManager) query = query.eq("status", "in_progress");

    const { data: attempt, error: updateError } = await query.select().maybeSingle();
    if (updateError) return serverError("Failed to update quiz attempt", updateError);
    if (!attempt) return conflict("This attempt has already been submitted");

    // Manual grading reaches the gradebook the same way auto-grading does.
    if (isManager && attempt.status === "graded" && attempt.course_id) {
      try {
        await syncQuizToGradebook(supabase, id, attempt.course_id, attempt.student_id);
      } catch (syncError) {
        console.error("[QuizAttempt PUT] Gradebook sync error:", syncError);
      }
    }

    return NextResponse.json(attempt);
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
