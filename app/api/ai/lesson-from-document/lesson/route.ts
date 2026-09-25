import { NextResponse } from 'next/server';
import type { DocumentSection } from '@/lib/ai/document-extract';
import { MAX_DOCUMENT_CHARS } from '@/lib/ai/document-extract';
import { buildLesson, type Difficulty, type OutlineLesson, type QuestionType, type Usage } from '@/lib/ai/lesson-generator';
import { authorizeLessonAi, errorResponse, recordUsage } from '@/lib/ai/lesson-route-shared';

export const runtime = 'nodejs';
// Up to ~7 model calls per lesson (content, check, retry, questions, verify, top-up).
export const maxDuration = 300;

const QUESTION_TYPES: QuestionType[] = ['multiple_choice', 'true_false', 'short_answer', 'essay'];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'mixed'];

interface LessonRequest {
  /** Only the sections this lesson draws from (by section_indexes). */
  sections: DocumentSection[];
  lesson: OutlineLesson;
  questionCount?: number;
  questionTypes?: QuestionType[];
  difficulty?: Difficulty;
  audience?: string;
  language?: string;
}

/**
 * POST { sections, lesson, questionCount, questionTypes, difficulty, audience?, language? }
 * → { lesson: GeneratedLesson, usage }
 */
export async function POST(request: Request) {
  const auth = await authorizeLessonAi({ requireOpenAI: true });
  if (auth.ok === false) return auth.response;

  const usage: Usage = { calls: 0, tokens: 0 };
  try {
    const body = (await request.json()) as LessonRequest;

    // --- Validate sections -------------------------------------------------
    if (!Array.isArray(body.sections) || body.sections.length === 0) {
      return NextResponse.json({ error: 'sections must be a non-empty array' }, { status: 400 });
    }
    const sections: DocumentSection[] = [];
    let total = 0;
    for (const raw of body.sections) {
      const s = raw as Partial<DocumentSection>;
      const text = String(s?.text ?? '').trim();
      const index = Number(s?.index);
      if (!text || !Number.isInteger(index) || index < 0) continue;
      total += text.length;
      sections.push({ index, locator: String(s.locator ?? `Section ${index}`).slice(0, 200), heading: s.heading ? String(s.heading).slice(0, 300) : undefined, text });
    }
    if (sections.length === 0) return NextResponse.json({ error: 'No usable sections supplied' }, { status: 400 });
    if (total > MAX_DOCUMENT_CHARS) {
      return NextResponse.json({ error: 'Too much source text for a single lesson' }, { status: 413 });
    }

    // --- Validate lesson ---------------------------------------------------
    const l = body.lesson;
    if (!l || typeof l !== 'object' || !String(l.title || '').trim()) {
      return NextResponse.json({ error: 'lesson.title is required' }, { status: 400 });
    }
    const lesson: OutlineLesson = {
      title: String(l.title).trim().slice(0, 200),
      description: String(l.description || '').trim().slice(0, 1000),
      learning_outcomes: Array.isArray(l.learning_outcomes) ? l.learning_outcomes.map((o) => String(o).trim()).filter(Boolean).slice(0, 8) : [],
      section_indexes: sections.map((s) => s.index),
      estimated_minutes: Math.min(120, Math.max(5, Math.round(Number(l.estimated_minutes) || 15))),
      difficulty: Math.min(3, Math.max(1, Math.round(Number(l.difficulty) || 1))),
    };

    // --- Validate options --------------------------------------------------
    const questionCount = Math.min(20, Math.max(0, Math.round(Number(body.questionCount ?? 5))));
    const requestedTypes: unknown[] = Array.isArray(body.questionTypes) ? body.questionTypes : ['multiple_choice'];
    const questionTypes = requestedTypes.filter((t): t is QuestionType => typeof t === 'string' && (QUESTION_TYPES as string[]).includes(t));
    if (questionCount > 0 && questionTypes.length === 0) {
      return NextResponse.json({ error: 'At least one valid question type is required' }, { status: 400 });
    }
    const difficulty: Difficulty = DIFFICULTIES.includes(body.difficulty as Difficulty) ? (body.difficulty as Difficulty) : 'medium';

    const generated = await buildLesson(
      sections,
      lesson,
      {
        questionCount,
        questionTypes: questionTypes.length ? questionTypes : ['multiple_choice'],
        difficulty,
        audience: body.audience?.slice(0, 300),
        language: body.language?.slice(0, 60),
      },
      usage
    );

    await recordUsage(auth.user.id, usage);
    return NextResponse.json({ lesson: generated, usage });
  } catch (e) {
    await recordUsage(auth.user.id, usage);
    return errorResponse(e, 'Failed to generate the lesson');
  }
}
