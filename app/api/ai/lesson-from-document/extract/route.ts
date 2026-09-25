import { NextResponse } from 'next/server';
import { extractDocument, ExtractionError } from '@/lib/ai/document-extract';
import { authorizeLessonAi, errorResponse } from '@/lib/ai/lesson-route-shared';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Vercel functions reject bodies above 4.5 MB, so cap slightly under that and
 * give a clear message instead of a platform error.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * POST multipart/form-data { file }
 * → { fileName, format, sections, totalChars, warnings }
 *
 * Text extraction only; no AI call. The client keeps the sections in memory
 * and sends the relevant ones back for the outline and lesson stages, so no
 * document content is persisted on the server.
 */
export async function POST(request: Request) {
  const auth = await authorizeLessonAi({ requireOpenAI: false });
  if (auth.ok === false) return auth.response;

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'File is empty' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: 'File too large. The maximum size is 4 MB. Export a text-only PDF or split the document.' },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const doc = await extractDocument({ name: file.name, buffer });

    return NextResponse.json(doc);
  } catch (e) {
    if (e instanceof ExtractionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return errorResponse(e, 'Failed to read the document');
  }
}
