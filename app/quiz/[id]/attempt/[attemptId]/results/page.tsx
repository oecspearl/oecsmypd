import { redirect } from "next/navigation";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { resolveQuizAccess, stripQuestionsAnswerKey } from "@/lib/quiz-extensions";
import QuizResults from "@/app/components/QuizResults";
import Breadcrumb from "@/app/components/Breadcrumb";
import Link from "next/link";

// Force dynamic rendering to prevent Vercel from treating this as a static 404
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const { id, attemptId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/auth/signin?next=${encodeURIComponent(`/quiz/${id}/attempt/${attemptId}/results`)}`);
  }

  try {
    const supabase = createServiceSupabaseClient();

    const [quizResult, attemptResult, questionsResult] = await Promise.all([
      supabase.from("quizzes").select("*").eq("id", id).maybeSingle(),
      supabase.from("quiz_attempts").select("*").eq("id", attemptId).eq("quiz_id", id).maybeSingle(),
      supabase.from("questions").select("*").eq("quiz_id", id).order("order", { ascending: true }),
    ]);

    if (quizResult.error || attemptResult.error || !quizResult.data || !attemptResult.data) {
      console.error("Quiz results data error:", {
        quizError: quizResult.error,
        attemptError: attemptResult.error,
        questionsError: questionsResult.error,
        quizId: id,
        attemptId,
      });
      return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-md p-8 max-w-md text-center">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Unable to Load Results</h2>
            <p className="text-sm text-gray-600 mb-4">
              The quiz results could not be found. The quiz or attempt may no longer exist.
            </p>
            <Link href="/quizzes" className="text-blue-600 hover:text-blue-800 text-sm font-medium">
              Back to Quizzes
            </Link>
          </div>
        </div>
      );
    }

    const quiz = quizResult.data;
    const attempt = attemptResult.data;

    // Only the attempt owner or a manager of the quiz's course may view results.
    const isOwner = attempt.student_id === user.id;
    let canManage = false;
    if (!isOwner) {
      const access = await resolveQuizAccess(user.id, user.role, id);
      canManage = access.canManage;
      if (!canManage) redirect("/dashboard");
    }

    // Students only see the answer key when the quiz allows it.
    const rawQuestions = questionsResult.data || [];
    const questions = canManage || quiz.show_correct_answers ? rawQuestions : stripQuestionsAnswerKey(rawQuestions);

    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Quizzes", href: "/quizzes" },
              { label: quiz.title || "Quiz", href: `/quiz/${id}` },
              { label: "Results" },
            ]}
            className="mb-6"
          />
          <QuizResults quiz={quiz} attempt={attempt} questions={questions} />
        </div>
      </div>
    );
  } catch (error) {
    // next/navigation redirect() works by throwing; let it propagate.
    if (error && typeof error === "object" && "digest" in error && String((error as any).digest).startsWith("NEXT_REDIRECT")) {
      throw error;
    }
    console.error("Error loading quiz results:", error);
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow-md p-8 max-w-md text-center">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Error Loading Results</h2>
          <p className="text-sm text-gray-600 mb-4">
            Something went wrong while loading the results. Please try again.
          </p>
          <Link href="/quizzes" className="text-blue-600 hover:text-blue-800 text-sm font-medium">
            Back to Quizzes
          </Link>
        </div>
      </div>
    );
  }
}
