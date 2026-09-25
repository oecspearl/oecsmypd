/**
 * AI generation for the "lesson from document" feature.
 *
 * Every call uses OpenAI structured outputs (strict JSON schema) so nothing is
 * parsed from free text. Every lesson and question is grounded in the extracted
 * source sections, and quiz questions go through three independent checks
 * before they are returned:
 *
 *   1. Schema/shape validation (option counts, exactly one correct answer, ...)
 *   2. A verbatim source quote that must actually appear in the source text
 *   3. A second model pass that confirms the question is answerable from the
 *      source, the answer key is right, and the wording is unambiguous
 *
 * Lesson HTML is checked for unsupported claims and regenerated once if the
 * faithfulness score is below the threshold.
 */

import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { renderSourceText, type DocumentSection } from './document-extract';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'essay';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'mixed';

export interface OutlineLesson {
  title: string;
  description: string;
  learning_outcomes: string[];
  section_indexes: number[];
  estimated_minutes: number;
  /** 1 = beginner, 2 = intermediate, 3 = advanced (matches lessons.difficulty) */
  difficulty: number;
}

export interface DocumentOutline {
  document_title: string;
  summary: string;
  lessons: OutlineLesson[];
}

export interface GeneratedOption {
  id: string;
  text: string;
  is_correct: boolean;
}

export interface GeneratedQuestion {
  type: QuestionType;
  question_text: string;
  points: number;
  options: GeneratedOption[];
  /** Accepted answers for short_answer; null otherwise. */
  correct_answer: string[] | null;
  feedback_correct: string;
  feedback_incorrect: string;
  /** Verbatim excerpt from the source that supports the answer. */
  source_quote: string;
  source_index: number;
}

export interface RejectedQuestion {
  question_text: string;
  reason: string;
}

export interface LessonAccuracyReport {
  /** 0-100 faithfulness score for the lesson HTML from the verification pass. */
  faithfulness_score: number;
  unsupported_claims: { claim: string; reason: string }[];
  content_regenerated: boolean;
  questions_requested: number;
  questions_generated: number;
  questions_kept: number;
  rejected_questions: RejectedQuestion[];
  /** True when the instructor should look closely before publishing. */
  needs_review: boolean;
}

export interface GeneratedLesson {
  title: string;
  description: string;
  learning_outcomes: string[];
  html: string;
  key_terms: string[];
  estimated_minutes: number;
  difficulty: number;
  questions: GeneratedQuestion[];
  accuracy: LessonAccuracyReport;
  section_indexes: number[];
}

export interface Usage {
  calls: number;
  tokens: number;
}

export interface LessonGenerationOptions {
  questionCount: number;
  questionTypes: QuestionType[];
  difficulty: Difficulty;
  audience?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// OpenAI plumbing
// ---------------------------------------------------------------------------

export const FAITHFULNESS_THRESHOLD = 85;
const MODEL = process.env.OPENAI_LESSON_MODEL || 'gpt-4o';

export function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 2 });
}

type JsonSchema = Record<string, unknown>;

async function callJson<T>(
  name: string,
  schema: JsonSchema,
  system: string,
  user: string,
  opts: { maxTokens: number; temperature: number },
  usage: Usage
): Promise<T> {
  const completion = await client().chat.completions.create({
    model: MODEL,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name, strict: true, schema },
    },
  });

  usage.calls += 1;
  usage.tokens += completion.usage?.total_tokens || 0;

  const choice = completion.choices[0];
  if (choice?.finish_reason === 'length') {
    throw new Error(`AI response for "${name}" was cut off (max_tokens). Try fewer lessons or questions.`);
  }
  if (choice?.message?.refusal) {
    throw new Error(`AI declined the "${name}" request: ${choice.message.refusal}`);
  }
  const content = choice?.message?.content;
  if (!content) throw new Error(`Empty AI response for "${name}"`);
  return JSON.parse(content) as T;
}

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

const GROUNDING_RULES = `GROUNDING RULES (non-negotiable):
- Use ONLY facts, definitions, figures, names and examples that appear in the SOURCE text.
- Never introduce outside knowledge, invented statistics, dates, or examples. If the source does not say it, you do not say it.
- You may rephrase, reorganise, simplify and explain, but every statement must be traceable to the SOURCE.
- If the source is thin on a topic, keep that part short rather than padding it.`;

const HTML_COMPONENTS = `RICH HTML COMPONENTS (use inline styles only; no class attributes):

Callout box (variants: Info #eff6ff/#3b82f6/#1e40af, Example #f0fdf4/#22c55e/#166534, Caution #fffbeb/#f59e0b/#92400e, Important #fef2f2/#ef4444/#991b1b, Note #f5f3ff/#8b5cf6/#5b21b6):
<div style="background:#eff6ff; border-left:4px solid #3b82f6; padding:16px 20px; margin:16px 0; border-radius:0 8px 8px 0;"><strong style="color:#1e40af; display:block; margin-bottom:6px;">💡 KEY CONCEPT</strong><p style="margin:0; color:#1e3a5f;">...</p></div>

Highlighted term: <mark style="background:#fef08a; padding:2px 6px; border-radius:3px;">term</mark>

Numbered step card (one per step):
<div style="margin:14px 0; padding-left:44px;"><span style="display:inline-block; width:30px; height:30px; line-height:30px; text-align:center; background-color:#3b82f6; color:#ffffff; border-radius:50%; font-weight:700; margin-left:-44px; margin-right:14px; vertical-align:middle;">1</span><strong>Step title</strong><p style="margin:6px 0 0; color:#475569;">...</p></div>

Styled table:
<table style="width:100%; border-collapse:collapse; margin:16px 0;"><thead><tr style="background-color:#1e293b;"><th style="padding:12px 16px; text-align:left; color:#f1f5f9; font-size:13px;">Header</th></tr></thead><tbody><tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:12px 16px; color:#334155;">Cell</td></tr></tbody></table>

Key takeaways box:
<div style="background-color:#eef2ff; border:1px solid #c7d2fe; border-radius:8px; padding:20px; margin:20px 0;"><strong style="color:#312e81; display:block; margin-bottom:10px;">📌 Key Takeaways</strong><ul style="margin:0; padding-left:20px; color:#3730a3;"><li>...</li></ul></div>

Section divider:
<p style="text-align:center; margin:24px 0 16px; font-size:12px; font-weight:600; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; border-top:1px solid #e2e8f0; padding-top:12px;">Label</p>

STYLE CONSTRAINTS: use only these CSS properties: color, background-color, background (solid colours only, no gradients), font-size, font-weight, font-style, line-height, letter-spacing, text-align, text-transform, text-decoration, vertical-align, margin*, padding*, width, height, min-width, max-width, border*, border-radius, border-collapse, display (block or inline-block only), list-style. Never use flex, grid, gap, position, float or url().`;

function audienceLine(opts: { audience?: string; language?: string }): string {
  const parts: string[] = [];
  if (opts.audience?.trim()) parts.push(`Audience: ${opts.audience.trim()}.`);
  if (opts.language?.trim()) parts.push(`Write in ${opts.language.trim()}.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Stage 1: outline
// ---------------------------------------------------------------------------

const OUTLINE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['document_title', 'summary', 'lessons'],
  properties: {
    document_title: { type: 'string' },
    summary: { type: 'string' },
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'learning_outcomes', 'section_indexes', 'estimated_minutes', 'difficulty'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          learning_outcomes: { type: 'array', items: { type: 'string' } },
          section_indexes: { type: 'array', items: { type: 'integer' } },
          estimated_minutes: { type: 'integer' },
          difficulty: { type: 'integer' },
        },
      },
    },
  },
};

/** Total characters of section previews to send in the outline prompt. */
const OUTLINE_PREVIEW_BUDGET = 220_000;

export async function generateOutline(
  sections: DocumentSection[],
  opts: { lessonCount?: number; audience?: string; language?: string },
  usage: Usage
): Promise<DocumentOutline> {
  const perSection = Math.max(300, Math.min(2500, Math.floor(OUTLINE_PREVIEW_BUDGET / Math.max(1, sections.length))));
  const preview = sections
    .map((s) => {
      const text = s.text.length > perSection ? s.text.slice(0, perSection) + ' …' : s.text;
      return `[Source ${s.index} — ${s.locator}]\n${text}`;
    })
    .join('\n\n');

  const countRule =
    opts.lessonCount && opts.lessonCount > 0
      ? `Produce EXACTLY ${opts.lessonCount} lesson(s).`
      : `Choose the number of lessons that fits the material (usually 1 lesson per 10-20 minutes of study; minimum 1, maximum 12).`;

  const system = `You are an expert instructional designer. Split a source document into a sequence of coherent lessons for a learning management system.

RULES:
- ${countRule}
- Lessons follow the document's order and together cover all substantive content. Skip front matter, tables of contents, references and boilerplate.
- Each lesson lists the source section indexes it draws from (integers from the [Source N] labels). Every lesson needs at least one. Do not invent indexes.
- learning_outcomes: 2-5 measurable outcomes starting with a verb (Explain, Compare, Apply, ...), grounded only in what the source covers.
- estimated_minutes: realistic study time (5-60).
- difficulty: 1 = beginner, 2 = intermediate, 3 = advanced.
- document_title: a clean title for the document. summary: 1-2 sentences.
${audienceLine(opts)}`;

  const user = `SOURCE DOCUMENT (${sections.length} sections):\n\n${preview}`;

  const raw = await callJson<DocumentOutline>('lesson_outline', OUTLINE_SCHEMA, system, user, { maxTokens: 4000, temperature: 0.2 }, usage);

  // Defensive normalisation: the schema guarantees shape, not sense.
  const valid = new Set(sections.map((s) => s.index));
  const lessons: OutlineLesson[] = raw.lessons
    .map((l) => ({
      title: String(l.title || '').trim() || 'Untitled lesson',
      description: String(l.description || '').trim(),
      learning_outcomes: (l.learning_outcomes || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6),
      section_indexes: Array.from(new Set((l.section_indexes || []).filter((i) => valid.has(i)))).sort((a, b) => a - b),
      estimated_minutes: Math.min(120, Math.max(5, Math.round(Number(l.estimated_minutes) || 15))),
      difficulty: Math.min(3, Math.max(1, Math.round(Number(l.difficulty) || 1))),
    }))
    .filter((l) => l.section_indexes.length > 0);

  if (lessons.length === 0) {
    lessons.push({
      title: raw.document_title || 'Lesson 1',
      description: raw.summary || '',
      learning_outcomes: [],
      section_indexes: sections.map((s) => s.index),
      estimated_minutes: 20,
      difficulty: 1,
    });
  }

  return { document_title: raw.document_title || 'Untitled document', summary: raw.summary || '', lessons };
}

// ---------------------------------------------------------------------------
// Stage 2a: lesson HTML + faithfulness check
// ---------------------------------------------------------------------------

const LESSON_HTML_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'html', 'key_terms'],
  properties: {
    title: { type: 'string' },
    html: { type: 'string' },
    key_terms: { type: 'array', items: { type: 'string' } },
  },
};

const FAITHFULNESS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'unsupported_claims'],
  properties: {
    score: { type: 'integer' },
    unsupported_claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'reason'],
        properties: { claim: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateLessonHtml(
  source: string,
  lesson: OutlineLesson,
  opts: LessonGenerationOptions,
  usage: Usage,
  removeClaims?: { claim: string; reason: string }[]
): Promise<{ title: string; html: string; key_terms: string[] }> {
  const system = `You are an expert educational content designer for a learning management system. Write a complete, self-contained lesson page as rich HTML from the SOURCE text.

${GROUNDING_RULES}

OUTPUT RULES:
- Return the lesson body as HTML in the "html" field. No <html>, <head>, <body>, <h1>, <script>, <iframe>, class attributes, markdown or code fences.
- Allowed tags: h2 h3 h4 p br hr ul ol li strong em b i u s mark sub sup a blockquote pre code table thead tbody tr th td div span figure figcaption.
- Structure: short introduction, 2-6 sections with <h2> headings, and a Key Takeaways box at the end. Short paragraphs (2-3 sentences). Highlight key terms with <mark> on first use.
- Use at least three different visual components from the list below where they fit the content (callouts for definitions, step cards for processes, tables for comparisons). Never invent content to fill a component.
- Length: proportional to the source material for this lesson; typically 600-1500 words. Cover every learning outcome.
- key_terms: 3-10 important terms defined in the lesson.
${audienceLine(opts)}

${HTML_COMPONENTS}`;

  let user = `LESSON TO WRITE
Title: ${lesson.title}
Description: ${lesson.description}
Learning outcomes:
${lesson.learning_outcomes.map((o) => `- ${o}`).join('\n') || '- (derive from source)'}

SOURCE:
${source}`;

  if (removeClaims && removeClaims.length > 0) {
    user += `\n\nA previous draft contained statements NOT supported by the SOURCE. Rewrite so none of these appear, and add nothing else that is unsupported:\n${removeClaims
      .map((c) => `- "${c.claim}" (${c.reason})`)
      .join('\n')}`;
  }

  const out = await callJson<{ title: string; html: string; key_terms: string[] }>(
    'lesson_html',
    LESSON_HTML_SCHEMA,
    system,
    user,
    { maxTokens: 10_000, temperature: 0.3 },
    usage
  );
  const html = String(out.html || '')
    .replace(/^```html?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  if (htmlToText(html).length < 200) throw new Error('Generated lesson content was empty or too short.');
  return { title: out.title || lesson.title, html, key_terms: (out.key_terms || []).filter(Boolean).slice(0, 12) };
}

async function checkFaithfulness(
  source: string,
  html: string,
  usage: Usage
): Promise<{ score: number; unsupported_claims: { claim: string; reason: string }[] }> {
  const system = `You are a meticulous fact-checker for educational content. Compare a LESSON against its SOURCE.

Report every factual claim in the LESSON that is not supported by the SOURCE: invented facts, numbers, dates, names, examples or causal claims that the SOURCE does not state. Rephrasing, simplification, reasonable summarising, headings, transitions and generic study advice ("review this section") are NOT unsupported claims.

score: 0-100 where 100 = every factual statement is supported by the SOURCE. Deduct roughly 5-15 points per unsupported claim depending on how misleading it is.`;

  const user = `SOURCE:\n${source}\n\nLESSON (text only):\n${htmlToText(html)}`;
  const out = await callJson<{ score: number; unsupported_claims: { claim: string; reason: string }[] }>(
    'faithfulness_check',
    FAITHFULNESS_SCHEMA,
    system,
    user,
    { maxTokens: 2500, temperature: 0 },
    usage
  );
  return {
    score: Math.min(100, Math.max(0, Math.round(Number(out.score) || 0))),
    unsupported_claims: (out.unsupported_claims || []).slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Stage 2b: questions + grounding + verification
// ---------------------------------------------------------------------------

const QUESTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type',
          'question_text',
          'points',
          'options',
          'accepted_answers',
          'feedback_correct',
          'feedback_incorrect',
          'source_quote',
          'source_index',
        ],
        properties: {
          type: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer', 'essay'] },
          question_text: { type: 'string' },
          points: { type: 'integer' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'is_correct'],
              properties: { text: { type: 'string' }, is_correct: { type: 'boolean' } },
            },
          },
          accepted_answers: { type: 'array', items: { type: 'string' } },
          feedback_correct: { type: 'string' },
          feedback_incorrect: { type: 'string' },
          source_quote: { type: 'string' },
          source_index: { type: 'integer' },
        },
      },
    },
  },
};

const VERIFY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'answerable_from_source', 'answer_key_correct', 'unambiguous', 'issue'],
        properties: {
          index: { type: 'integer' },
          answerable_from_source: { type: 'boolean' },
          answer_key_correct: { type: 'boolean' },
          unambiguous: { type: 'boolean' },
          issue: { type: 'string' },
        },
      },
    },
  },
};

interface RawQuestion {
  type: QuestionType;
  question_text: string;
  points: number;
  options: { text: string; is_correct: boolean }[];
  accepted_answers: string[];
  feedback_correct: string;
  feedback_incorrect: string;
  source_quote: string;
  source_index: number;
}

function normaliseForMatch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when the quote (or a 6-word run of it) appears verbatim in the source
 * after punctuation/case normalisation. Guards against fabricated citations.
 */
export function quoteAppearsInSource(quote: string, source: string): boolean {
  const q = normaliseForMatch(quote);
  const s = normaliseForMatch(source);
  if (!q || !s) return false;
  if (s.includes(q)) return true;
  const words = q.split(' ').filter(Boolean);
  if (words.length < 6) return false;
  for (let i = 0; i + 6 <= words.length; i++) {
    if (s.includes(words.slice(i, i + 6).join(' '))) return true;
  }
  return false;
}

const POINTS_BY_DIFFICULTY: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3, mixed: 2 };

/** Shape validation: returns a rejection reason or null. Mutates nothing. */
function validateShape(q: RawQuestion, allowedTypes: QuestionType[]): string | null {
  if (!q.question_text || q.question_text.trim().length < 10) return 'Question text is empty or too short';
  if (!allowedTypes.includes(q.type)) return `Question type "${q.type}" was not requested`;
  if (q.type === 'multiple_choice') {
    const opts = (q.options || []).filter((o) => o.text && o.text.trim());
    if (opts.length < 3) return 'Multiple choice needs at least 3 options';
    const correct = opts.filter((o) => o.is_correct).length;
    if (correct !== 1) return `Multiple choice must have exactly one correct option (found ${correct})`;
    const texts = new Set(opts.map((o) => normaliseForMatch(o.text)));
    if (texts.size !== opts.length) return 'Duplicate options';
  } else if (q.type === 'true_false') {
    const opts = (q.options || []).map((o) => ({ ...o, text: o.text.trim() }));
    const labels = opts.map((o) => o.text.toLowerCase()).sort().join('|');
    if (opts.length !== 2 || labels !== 'false|true') return 'True/false must have exactly the options True and False';
    if (opts.filter((o) => o.is_correct).length !== 1) return 'True/false must have exactly one correct option';
  } else if (q.type === 'short_answer') {
    const answers = (q.accepted_answers || []).map((a) => a.trim()).filter(Boolean);
    if (answers.length === 0) return 'Short answer needs at least one accepted answer';
    if (answers.some((a) => a.split(/\s+/).length > 6)) return 'Short answer accepted answers must be a few words (auto-graded by exact match)';
  }
  if (!q.source_quote || q.source_quote.trim().length < 15) return 'Missing source quote';
  return null;
}

function toGenerated(q: RawQuestion, difficulty: Difficulty): GeneratedQuestion {
  const basePoints = POINTS_BY_DIFFICULTY[difficulty];
  const points = Number.isFinite(q.points) && q.points > 0 ? Math.min(10, q.points) : basePoints;
  let options: GeneratedOption[] = [];
  if (q.type === 'multiple_choice') {
    options = q.options.filter((o) => o.text && o.text.trim()).map((o) => ({ id: randomUUID(), text: o.text.trim(), is_correct: Boolean(o.is_correct) }));
  } else if (q.type === 'true_false') {
    // Canonical order: True then False.
    const t = q.options.find((o) => o.text.trim().toLowerCase() === 'true');
    options = [
      { id: randomUUID(), text: 'True', is_correct: Boolean(t?.is_correct) },
      { id: randomUUID(), text: 'False', is_correct: !t?.is_correct },
    ];
  }
  return {
    type: q.type,
    question_text: q.question_text.trim(),
    points: q.type === 'essay' ? points + 2 : q.type === 'short_answer' ? points + 1 : points,
    options,
    correct_answer: q.type === 'short_answer' ? Array.from(new Set(q.accepted_answers.map((a) => a.trim()).filter(Boolean))) : null,
    feedback_correct: q.feedback_correct?.trim() || 'Correct.',
    feedback_incorrect: q.feedback_incorrect?.trim() || 'Not quite. Review the lesson and try again.',
    source_quote: q.source_quote.trim(),
    source_index: Number(q.source_index) || 0,
  };
}

async function generateQuestionBatch(
  source: string,
  lesson: OutlineLesson,
  count: number,
  opts: LessonGenerationOptions,
  usage: Usage,
  avoid: string[]
): Promise<RawQuestion[]> {
  const system = `You are an expert assessment writer. Write quiz questions that test whether a student LEARNED the subject matter in the SOURCE.

${GROUNDING_RULES}

QUESTION RULES:
- Write EXACTLY ${count} question(s). Types allowed: ${opts.questionTypes.join(', ')}. Spread across the allowed types.
- Difficulty: ${opts.difficulty}. points: easy 1, medium 2, hard 3.
- Test understanding of the content, never the document itself (no "What does this section cover?").
- Each question must be answerable from the SOURCE alone, with one defensible answer.
- multiple_choice: 4 options, exactly one is_correct, distractors plausible but clearly wrong per the SOURCE. Never use "All of the above" / "None of the above".
- true_false: options exactly "True" and "False", one is_correct. Statements must be unambiguous.
- short_answer: options empty; accepted_answers lists 1-4 short exact answers (a term, name or number; max 6 words each) including common variants.
- essay: options empty, accepted_answers empty; feedback_correct describes what a strong answer includes.
- source_quote: copy 1-2 sentences VERBATIM from the SOURCE that contain the answer. Do not paraphrase. source_index: the [Source N] number the quote comes from.
- feedback_incorrect must explain the correct answer using the SOURCE.
${avoid.length > 0 ? `- Do NOT repeat or closely paraphrase these existing questions:\n${avoid.map((a) => `  • ${a}`).join('\n')}` : ''}
${audienceLine(opts)}`;

  const user = `LESSON: ${lesson.title}\n${lesson.description}\nLearning outcomes:\n${lesson.learning_outcomes.map((o) => `- ${o}`).join('\n')}\n\nSOURCE:\n${source}`;

  const out = await callJson<{ questions: RawQuestion[] }>('quiz_questions', QUESTIONS_SCHEMA, system, user, { maxTokens: 6000, temperature: 0.4 }, usage);
  return out.questions || [];
}

async function verifyQuestions(
  source: string,
  questions: GeneratedQuestion[],
  usage: Usage
): Promise<Map<number, { ok: boolean; issue: string }>> {
  const listing = questions
    .map((q, i) => {
      let answer = '';
      if (q.type === 'multiple_choice' || q.type === 'true_false') {
        answer = `Options: ${q.options.map((o) => `${o.is_correct ? '[CORRECT] ' : ''}${o.text}`).join(' | ')}`;
      } else if (q.type === 'short_answer') {
        answer = `Accepted answers: ${q.correct_answer?.join(' | ')}`;
      } else {
        answer = `Essay. Model answer guidance: ${q.feedback_correct}`;
      }
      return `#${i} (${q.type}) ${q.question_text}\n${answer}`;
    })
    .join('\n\n');

  const system = `You are an independent examiner auditing quiz questions against their SOURCE text. For EVERY question index, judge strictly:
- answerable_from_source: the SOURCE contains the information needed to answer it (for essays: to write a reasonable answer).
- answer_key_correct: the marked correct option / accepted answers are actually correct according to the SOURCE, and for multiple choice no distractor is also correct.
- unambiguous: a careful student would not reasonably argue for a different answer; wording is clear and not a trick.
- issue: empty string if all three are true, otherwise one sentence explaining the problem.
Return one result per question index, in order.`;

  const user = `SOURCE:\n${source}\n\nQUESTIONS:\n${listing}`;
  const out = await callJson<{ results: { index: number; answerable_from_source: boolean; answer_key_correct: boolean; unambiguous: boolean; issue: string }[] }>(
    'question_verification',
    VERIFY_SCHEMA,
    system,
    user,
    { maxTokens: 3000, temperature: 0 },
    usage
  );

  const map = new Map<number, { ok: boolean; issue: string }>();
  for (const r of out.results || []) {
    const ok = Boolean(r.answerable_from_source && r.answer_key_correct && r.unambiguous);
    map.set(r.index, { ok, issue: ok ? '' : r.issue || 'Failed verification' });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Stage 2 orchestrator
// ---------------------------------------------------------------------------

export async function buildLesson(
  sections: DocumentSection[],
  lesson: OutlineLesson,
  opts: LessonGenerationOptions,
  usage: Usage
): Promise<GeneratedLesson> {
  const source = renderSourceText(sections);

  // --- Content ------------------------------------------------------------
  let content = await generateLessonHtml(source, lesson, opts, usage);
  let faith = await checkFaithfulness(source, content.html, usage);
  let regenerated = false;

  if (faith.score < FAITHFULNESS_THRESHOLD || faith.unsupported_claims.length > 0) {
    const retry = await generateLessonHtml(source, lesson, opts, usage, faith.unsupported_claims);
    const retryFaith = await checkFaithfulness(source, retry.html, usage);
    if (retryFaith.score >= faith.score) {
      content = retry;
      faith = retryFaith;
      regenerated = true;
    }
  }

  // --- Questions ----------------------------------------------------------
  const requested = Math.max(0, Math.min(20, Math.round(opts.questionCount)));
  const kept: GeneratedQuestion[] = [];
  const rejected: RejectedQuestion[] = [];
  let generatedTotal = 0;

  if (requested > 0 && opts.questionTypes.length > 0) {
    const seen = new Set<string>();
    for (let round = 0; round < 3 && kept.length < requested; round++) {
      const need = requested - kept.length;
      // Ask for a little extra on the first round so rejections rarely force a second call.
      const ask = round === 0 ? Math.min(20, need + Math.ceil(need * 0.5)) : need;
      const batch = await generateQuestionBatch(source, lesson, ask, opts, usage, kept.map((k) => k.question_text));
      generatedTotal += batch.length;

      const candidates: GeneratedQuestion[] = [];
      for (const raw of batch) {
        const key = normaliseForMatch(raw.question_text);
        if (seen.has(key)) {
          rejected.push({ question_text: raw.question_text, reason: 'Duplicate question' });
          continue;
        }
        const shapeIssue = validateShape(raw, opts.questionTypes);
        if (shapeIssue) {
          rejected.push({ question_text: raw.question_text, reason: shapeIssue });
          continue;
        }
        if (!quoteAppearsInSource(raw.source_quote, source)) {
          rejected.push({ question_text: raw.question_text, reason: 'Cited source quote does not appear in the document' });
          continue;
        }
        seen.add(key);
        candidates.push(toGenerated(raw, opts.difficulty));
      }

      if (candidates.length === 0) continue;

      const verdicts = await verifyQuestions(source, candidates, usage);
      candidates.forEach((q, i) => {
        const v = verdicts.get(i);
        if (!v) {
          rejected.push({ question_text: q.question_text, reason: 'Verifier returned no verdict' });
          return;
        }
        if (!v.ok) {
          rejected.push({ question_text: q.question_text, reason: v.issue });
          return;
        }
        if (kept.length < requested) kept.push(q);
      });
    }
  }

  const needsReview = faith.score < FAITHFULNESS_THRESHOLD || (requested > 0 && kept.length < Math.ceil(requested * 0.6));

  return {
    title: content.title,
    description: lesson.description,
    learning_outcomes: lesson.learning_outcomes,
    html: content.html,
    key_terms: content.key_terms,
    estimated_minutes: lesson.estimated_minutes,
    difficulty: lesson.difficulty,
    questions: kept,
    section_indexes: lesson.section_indexes,
    accuracy: {
      faithfulness_score: faith.score,
      unsupported_claims: faith.unsupported_claims,
      content_regenerated: regenerated,
      questions_requested: requested,
      questions_generated: generatedTotal,
      questions_kept: kept.length,
      rejected_questions: rejected,
      needs_review: needsReview,
    },
  };
}
