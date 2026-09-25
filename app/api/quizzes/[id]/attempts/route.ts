import { NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { getStudentExtension, resolveEffectiveSettings, resolveQuizAccess } from "@/lib/quiz-extensions";
import { unauthorized, forbidden, notFound, badRequest, conflict, serverError } from "@/lib/api-errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const access = await resolveQuizAccess(user.id, user.role, id);
    if (!access.quizExists) return notFound("Quiz not found");
    if (!access.canView) return forbidden();

    const { searchParams } = new URL(request.url);
    const requestedStudentId = searchParams.get("studentId");
    const allStudents = requestedStudentId === "*";

    // Only course managers may view other students' attempts.
    let studentId: string | null = user.id;
    if (requestedStudentId && requestedStudentId !== user.id) {
      if (!access.canManage) return forbidden();
      studentId = allStudents ? null : requestedStudentId;
    }

    // Service client: authorization verified above.
    const supabase = createServiceSupabaseClient();

    const selectFields = allStudents
      ? "*, student:users!quiz_attempts_student_id_fkey(id, name, email)"
      : "*";

    let query = supabase
      .from("quiz_attempts")
      .select(selectFields)
      .eq("quiz_id", id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (studentId) query = query.eq("student_id", studentId);

    const { data: attempts, error } = await query;
    if (error) return serverError("Failed to fetch attempts", error);

    return NextResponse.json({ attempts: attempts || [] });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();

    const access = await resolveQuizAccess(user.id, user.role, id);
    if (!access.quizExists) return notFound("Quiz not found");
    if (!access.canView) return forbidden("You are not enrolled in this course");

    const courseId = access.courseId;
    if (!courseId) {
      return badRequest("Quiz is not associated with a course");
    }

    // Service client: authorization verified above.
    const supabase = createServiceSupabaseClient();

    const { data: quiz, error: quizError } = await supabase.from("quizzes").select("*").eq("id", id).maybeSingle();
    if (quizError) return serverError("Failed to load quiz", quizError);
    if (!quiz) return notFound("Quiz not found");

    if (!access.canManage && !quiz.published) {
      return forbidden("This quiz is not published");
    }

    // Resolve effective settings (handles per-student extensions)
    const extension = await getStudentExtension(id, user.id);
    const effective = resolveEffectiveSettings(quiz, extension);

    const now = new Date();
    if (effective.available_from) {
      const availableFrom = new Date(effective.available_from);
      if (now < availableFrom) {
        return NextResponse.json(
          { error: `Quiz is not available yet. It opens on ${availableFrom.toLocaleString()}.`, available_from: effective.available_from },
          { status: 400 }
        );
      }
    }
    if (effective.available_until) {
      const availableUntil = new Date(effective.available_until);
      if (now > availableUntil) {
        return NextResponse.json(
          { error: `Quiz is no longer available. It closed on ${availableUntil.toLocaleString()}.`, available_until: effective.available_until },
          { status: 400 }
        );
      }
    }

    const { data: existingAttempts, error: attemptsError } = await supabase
      .from("quiz_attempts")
      .select("id, attempt_number")
      .eq("quiz_id", id)
      .eq("student_id", user.id);
    if (attemptsError) return serverError("Failed to check existing attempts", attemptsError);

    const attemptsAllowed = effective.attempts_allowed;
    const used = existingAttempts?.length ?? 0;
    if (used >= attemptsAllowed) {
      return NextResponse.json({ error: "No attempts left" }, { status: 400 });
    }

    const highest = (existingAttempts || []).reduce((m, a) => Math.max(m, Number(a.attempt_number ?? 0)), 0);
    const buildPayload = (attemptNumber: number) => ({
      quiz_id: id,
      course_id: courseId,
      student_id: user.id,
      attempt_number: attemptNumber,
      started_at: new Date().toISOString(),
      submitted_at: null,
      score: 0,
      max_score: 0,
      percentage: null,
      answers: [] as unknown[],
      time_taken: 0,
      status: "in_progress" as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Attempt-number race: two concurrent starts can compute the same number.
    // On unique violation, retry once with the next number.
    let attemptNumber = highest + 1;
    let { data: attempt, error: createError } = await supabase
      .from("quiz_attempts")
      .insert([buildPayload(attemptNumber)])
      .select("id")
      .single();

    if (createError?.code === "23505") {
      // Another request just created an attempt; re-check the allowance before retrying.
      if (used + 1 >= attemptsAllowed) {
        return NextResponse.json({ error: "No attempts left" }, { status: 400 });
      }
      attemptNumber += 1;
      ({ data: attempt, error: createError } = await supabase
        .from("quiz_attempts")
        .insert([buildPayload(attemptNumber)])
        .select("id")
        .single());
      if (createError?.code === "23505") return conflict("Could not start attempt, please retry");
    }

    if (createError || !attempt) return serverError("Failed to create quiz attempt", createError);

    return NextResponse.json({ id: attempt.id });
  } catch (e: any) {
    return serverError("Internal server error", e);
  }
}
