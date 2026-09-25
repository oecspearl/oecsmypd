import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { resolveQuizAccess } from "@/lib/quiz-extensions";
import { unauthorized, forbidden, notFound, serverError } from "@/lib/api-errors";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; attemptId: string }> }) {
  try {
    const { id, attemptId } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    // Service client: ownership / course access is verified below.
    const supabase = createServiceSupabaseClient();

    const { data: attempt, error: attemptError } = await supabase
      .from("quiz_attempts")
      .select("*")
      .eq("id", attemptId)
      .eq("quiz_id", id)
      .maybeSingle();

    if (attemptError) return serverError("Failed to load attempt", attemptError);
    if (!attempt) return notFound("Quiz attempt not found");

    // Owner, or a manager of the quiz's course.
    if (attempt.student_id !== user.id) {
      const access = await resolveQuizAccess(user.id, user.role, id);
      if (!access.canManage) return forbidden();
    }

    const { data: quiz, error: quizError } = await supabase.from("quizzes").select("*").eq("id", id).maybeSingle();
    if (quizError) console.error("[QuizResults GET] Quiz fetch error:", quizError);

    return NextResponse.json({ attempt, quiz: quiz || null });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
