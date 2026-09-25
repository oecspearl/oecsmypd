import { NextResponse } from 'next/server';
import type { DocumentSection } from '@/lib/ai/document-extract';
import { MAX_DOCUMENT_CHARS } from '@/lib/ai/document-extract';
import { generateOutline, type Usage } from '@/lib/ai/lesson-generator';
import { authorizeLessonAi, errorResponse, recordUsage } from '@/lib/ai/lesson-route-shared';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface OutlineRequest {
  sections: DocumentSection[];
  lessonCount?: number | null;
  audience?: string;
  language?: string;
}

function sanitiseSections(input: unknown): DocumentSection[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: DocumentSection[] = [];
  let total = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Partial<DocumentSection>;
    const text = String(s.text ?? '').trim();
    if (!text) continue;
    const index = Number(s.index);
    if (!Number.isInteger(index) || index < 0) return null;
    total += text.length;
    if (total > MAX_DOCUMENT_CHARS) return null;
    out.push({ index, locator: String(s.locator ?? `Section ${index}`).slice(0, 200), heading: s.heading ? String(s.heading).slice(0, 300) : undefined, text });
  }
  return out.length > 0 ? out : null;
}

/**
 * POST { sections, lessonCount?, audience?, language? }
 * → { outline: DocumentOutline, usage }
 */
export async function POST(request: Request) {
  const auth = await authorizeLessonAi({ requireOpenAI: true });
  if (auth.ok === false) return auth.response;

  const usage: Usage = { calls: 0, tokens: 0 };
  try {
    const body = (await request.json()) as OutlineRequest;
    const sections = sanitiseSections(body.sections);
    if (!sections) {
      return NextResponse.json({ error: 'sections must be a non-empty array within the size limit' }, { status: 400 });
    }

    let lessonCount: number | undefined;
    if (body.lessonCount !== null && body.lessonCount !== undefined) {
      const n = Number(body.lessonCount);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        return NextResponse.json({ error: 'lessonCount must be between 1 and 12' }, { status: 400 });
      }
      lessonCount = n;
    }

    const outline = await generateOutline(
      sections,
      { lessonCount, audience: body.audience?.slice(0, 300), language: body.language?.slice(0, 60) },
      usage
    );

    await recordUsage(auth.user.id, usage);
    return NextResponse.json({ outline, usage });
  } catch (e) {
    await recordUsage(auth.user.id, usage);
    return errorResponse(e, 'Failed to build the lesson outline');
  }
}
