/**
 * Parses Moodle quizzes into MyPD quiz/question structures.
 *
 * Moodle 4.x keeps questions in a root `questions.xml` question bank
 * (question_bank_entry → question_version → question_versions → question),
 * and each quiz's `quiz.xml` references bank entries by id via its slots.
 */

import { parseStringPromise } from "xml2js";

export type MyPdQuestionType =
  | "multiple_choice"
  | "true_false"
  | "short_answer"
  | "essay";

export interface MoodleQuizQuestion {
  type: MyPdQuestionType;
  questionText: string;
  points: number;
  single: boolean;
  options: string[];
  correctAnswers: string[];
}

export interface MoodleQuiz {
  title: string;
  intro: string;
  timeLimitSeconds: number;
  attempts: number;
  questions: MoodleQuizQuestion[];
}

type XmlNode = Record<string, any>;

function first(node: XmlNode | undefined, key: string): string {
  const v = node?.[key];
  const f = Array.isArray(v) ? v[0] : v;
  if (f == null || typeof f === "object") return "";
  return String(f).trim();
}

function mapQtype(qtype: string): MyPdQuestionType {
  switch (qtype) {
    case "truefalse":
      return "true_false";
    case "shortanswer":
      return "short_answer";
    case "essay":
      return "essay";
    default:
      return "multiple_choice"; // multichoice and anything close
  }
}

/** Collect every value nested under `key`, at any depth. */
function deepCollect(node: unknown, key: string, out: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(node)) {
    for (const item of node) deepCollect(item, key, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) {
        for (const item of Array.isArray(v) ? v : [v]) out.push(item as XmlNode);
      }
      deepCollect(v, key, out);
    }
  }
  return out;
}

function questionFromNode(q: XmlNode): MoodleQuizQuestion {
  const qtype = first(q, "qtype");
  const mc = q.plugin_qtype_multichoice_question?.[0] ?? {};
  const answerNodes: XmlNode[] = mc.answers?.[0]?.answer ?? [];
  const options: string[] = [];
  const correctAnswers: string[] = [];
  for (const a of answerNodes) {
    const text = first(a, "answertext");
    options.push(text);
    if (Number(first(a, "fraction")) > 0) correctAnswers.push(text);
  }
  return {
    type: mapQtype(qtype),
    questionText: first(q, "questiontext"),
    points: Number(first(q, "defaultmark")) || 1,
    single: first(mc.multichoice?.[0], "single") === "1",
    options,
    correctAnswers,
  };
}

export async function parseQuestionBank(
  xml: string
): Promise<Map<string, MoodleQuizQuestion>> {
  const parsed = await parseStringPromise(xml);
  const bank = new Map<string, MoodleQuizQuestion>();
  const entries = deepCollect(parsed, "question_bank_entry");

  for (const entry of entries) {
    const id = entry.$?.id;
    if (!id) continue;
    // Each entry has several versions; take the question with the highest version.
    const versions = deepCollect(entry, "question_versions");
    let bestVersion = -1;
    let bestQuestion: XmlNode | undefined;
    for (const v of versions) {
      const num = Number(first(v, "version")) || 0;
      const q = v.questions?.[0]?.question?.[0];
      if (q && num >= bestVersion) {
        bestVersion = num;
        bestQuestion = q;
      }
    }
    if (bestQuestion) bank.set(String(id), questionFromNode(bestQuestion));
  }

  return bank;
}

export async function parseQuiz(
  quizXml: string,
  bank: Map<string, MoodleQuizQuestion>
): Promise<MoodleQuiz> {
  const parsed = await parseStringPromise(quizXml);
  const quiz = parsed?.activity?.quiz?.[0] ?? {};

  // Resolve slots in order via each instance's referenced bank entry.
  const instances = deepCollect(quiz, "question_instance");
  const ordered = instances
    .map((inst) => ({
      slot: Number(first(inst, "slot")) || 0,
      maxmark: Number(first(inst, "maxmark")) || 0,
      bankEntryId: deepCollect(inst, "questionbankentryid")
        .map((n) => (typeof n === "string" ? n : ""))
        .find(Boolean) ?? first(inst, "questionbankentryid"),
    }))
    .sort((a, b) => a.slot - b.slot);

  const questions: MoodleQuizQuestion[] = [];
  for (const slot of ordered) {
    const q = bank.get(String(slot.bankEntryId));
    if (!q) continue;
    questions.push(slot.maxmark > 0 ? { ...q, points: slot.maxmark } : q);
  }

  return {
    title: first(quiz, "name"),
    intro: first(quiz, "intro"),
    timeLimitSeconds: Number(first(quiz, "timelimit")) || 0,
    attempts: Number(first(quiz, "attempts_number")) || 0,
    questions,
  };
}
