import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseQuestionBank, parseQuiz } from "./quiz-parser";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/sqljr/${name}`, import.meta.url), "utf8");
}

describe("parseQuestionBank", () => {
  test("parses the Moodle 4.x question bank, taking the latest version per entry", async () => {
    const bank = await parseQuestionBank(fixture("questions.xml"));

    // Five bank entries, one resolved question each (latest version).
    expect(bank.size).toBe(5);

    const q = bank.get("113");
    expect(q).toBeDefined();
    expect(q!.type).toBe("multiple_choice");
    expect(q!.single).toBe(true);
    // Each question has three options, exactly one correct (fraction > 0).
    expect(q!.options).toHaveLength(3);
    expect(q!.correctAnswers).toHaveLength(1);
    expect(q!.points).toBe(1);
    expect(q!.questionText.length).toBeGreaterThan(0);
    // The correct answer is one of the options.
    expect(q!.options).toContain(q!.correctAnswers[0]);
  });
});

describe("parseQuiz", () => {
  test("parses quiz settings and resolves its slots against the bank", async () => {
    const bank = await parseQuestionBank(fixture("questions.xml"));
    const quiz = await parseQuiz(fixture("quiz.xml"), bank);

    expect(quiz.title).toBe("Micro Pilots");
    expect(quiz.timeLimitSeconds).toBe(600);
    expect(quiz.attempts).toBe(1);
    // Five slots, each resolved to a real question in slot order.
    expect(quiz.questions).toHaveLength(5);
    expect(quiz.questions[0].type).toBe("multiple_choice");
    expect(quiz.questions[0].options).toHaveLength(3);
  });
});
