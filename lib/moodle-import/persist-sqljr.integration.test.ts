import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { importBackupToSupabase } from "./persist";

const LOCAL_URL = "http://127.0.0.1:54421";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const suite = process.env.RUN_IMPORT ? describe : describe.skip;

suite("SQLJR import into staging", () => {
  test(
    "imports a quiz-bearing course with real quizzes and questions",
    async () => {
      const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
        auth: { persistSession: false },
      });
      const archive = new MoodleArchive(
        readFileSync(new URL("./__fixtures__/sqljr.mbz", import.meta.url))
      );

      const summary = await importBackupToSupabase(archive, supabase);
      console.log("SQLJR import summary:", summary);

      expect(summary.subjects).toBe(7);
      expect(summary.quizzes).toBe(1);
      expect(summary.questions).toBe(5);

      // The quiz landed as a real row.
      const { data: quizzes } = await supabase
        .from("quizzes")
        .select("id, title, attempts_allowed")
        .eq("course_id", summary.courseId);
      expect(quizzes?.some((q) => q.title === "Micro Pilots")).toBe(true);
      const quiz = quizzes!.find((q) => q.title === "Micro Pilots")!;

      // Its five questions are real multiple-choice rows with options + a correct answer.
      const { data: questions } = await supabase
        .from("questions")
        .select("type, options, correct_answer")
        .eq("quiz_id", quiz.id);
      expect(questions).toHaveLength(5);
      expect(questions!.every((q) => q.type === "multiple_choice")).toBe(true);
      expect(questions!.every((q) => Array.isArray(q.options) && q.options.length === 3)).toBe(true);
      expect(
        questions!.every((q) => Array.isArray(q.correct_answer) && q.correct_answer.length >= 1)
      ).toBe(true);

      // The quiz lesson's content block points at the created quiz.
      const { data: quizLessons } = await supabase
        .from("lessons")
        .select("content")
        .eq("course_id", summary.courseId)
        .eq("content_type", "quiz");
      expect(quizLessons?.[0]?.content?.[0]?.data?.quizId).toBe(quiz.id);
    },
    120000
  );
});
