/**
 * Server-side text extraction for the "lesson from document" feature.
 *
 * Turns an uploaded PDF / DOCX / PPTX / TXT / MD file into an ordered list of
 * source sections. Each section keeps a human-readable locator (page, slide,
 * heading) so generated content and quiz questions can be traced back to the
 * exact part of the document they were derived from.
 */

export interface DocumentSection {
  /** Zero-based position in the document. Stable for the life of a job. */
  index: number;
  /** Human-readable locator, e.g. "Page 3", "Slide 7", "Heading: Photosynthesis". */
  locator: string;
  /** Optional heading text detected for this section. */
  heading?: string;
  /** Plain text content (whitespace-normalised). */
  text: string;
}

export interface ExtractedDocument {
  fileName: string;
  format: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md';
  sections: DocumentSection[];
  totalChars: number;
  /** Non-fatal notes surfaced to the instructor (e.g. pages with no text). */
  warnings: string[];
}

export class ExtractionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ExtractionError';
    this.status = status;
  }
}

/** Sections longer than this are split on paragraph boundaries. */
const MAX_SECTION_CHARS = 6000;
/** Sections shorter than this are merged into the following section. */
const MIN_SECTION_CHARS = 120;
/** Hard ceiling to keep prompts inside model context and keep costs sane. */
export const MAX_DOCUMENT_CHARS = 400_000;

const SUPPORTED: Record<string, ExtractedDocument['format']> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  txt: 'txt',
  md: 'md',
};

export function detectFormat(fileName: string): ExtractedDocument['format'] | null {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase() || '';
  return SUPPORTED[ext] ?? null;
}

export function normaliseWhitespace(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(html: string): string {
  return normaliseWhitespace(
    String(html || '')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

// ---------------------------------------------------------------------------
// Format-specific extractors. Each returns raw sections; post-processing below
// splits oversized ones, merges fragments and renumbers.
// ---------------------------------------------------------------------------

async function extractPdf(buffer: Buffer, warnings: string[]): Promise<Omit<DocumentSection, 'index'>[]> {
  const { extractText } = await import('unpdf');
  let result: { totalPages: number; text: string[] };
  try {
    result = await extractText(new Uint8Array(buffer), { mergePages: false });
  } catch (e: any) {
    throw new ExtractionError(`Could not read this PDF: ${e?.message || 'unknown error'}`);
  }

  const sections: Omit<DocumentSection, 'index'>[] = [];
  let emptyPages = 0;
  result.text.forEach((pageText, i) => {
    const text = normaliseWhitespace(pageText);
    if (text.length < 20) {
      emptyPages += 1;
      return;
    }
    sections.push({ locator: `Page ${i + 1}`, text });
  });

  if (sections.length === 0) {
    throw new ExtractionError(
      'This PDF contains no extractable text. It may be a scanned image; run OCR or export a text-based PDF and try again.'
    );
  }
  if (emptyPages > 0) {
    warnings.push(`${emptyPages} of ${result.totalPages} page(s) had no readable text and were skipped.`);
  }
  return sections;
}

async function extractDocx(buffer: Buffer): Promise<Omit<DocumentSection, 'index'>[]> {
  const mammoth = await import('mammoth');
  let html: string;
  try {
    const res = await mammoth.convertToHtml({ buffer });
    html = res.value || '';
  } catch (e: any) {
    throw new ExtractionError(`Could not read this Word document: ${e?.message || 'unknown error'}`);
  }

  // Split on headings so each section maps to an authored topic.
  const parts = html.split(/(?=<h[1-3][^>]*>)/i);
  const sections: Omit<DocumentSection, 'index'>[] = [];
  for (const part of parts) {
    const m = part.match(/^<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i);
    const heading = m ? stripHtml(m[2]) : undefined;
    const body = stripHtml(m ? part.slice(m[0].length) : part);
    const text = heading ? `${heading}\n${body}`.trim() : body;
    if (!text) continue;
    sections.push({ locator: heading ? `Heading: ${heading}` : 'Body text', heading, text });
  }
  if (sections.length === 0) throw new ExtractionError('This Word document contains no readable text.');
  return sections;
}

async function extractPptx(buffer: Buffer, warnings: string[]): Promise<Omit<DocumentSection, 'index'>[]> {
  const JSZip = (await import('jszip')).default;
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ExtractionError('Could not open this PowerPoint file.');
  }

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));

  if (slideFiles.length === 0) throw new ExtractionError('This PowerPoint file contains no slides.');

  const sections: Omit<DocumentSection, 'index'>[] = [];
  let emptySlides = 0;
  for (const name of slideFiles) {
    const slideNo = Number(name.match(/(\d+)\.xml$/)![1]);
    const xml = await zip.files[name].async('string');

    // Paragraph-aware: join runs inside <a:p>, newline between paragraphs.
    const paragraphs: string[] = [];
    const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(xml))) {
      const runs = Array.from(pm[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((r) => r[1]);
      const line = stripHtml(runs.join(''));
      if (line) paragraphs.push(line);
    }

    // Speaker notes are valuable teaching context; include when present.
    const notesName = `ppt/notesSlides/notesSlide${slideNo}.xml`;
    if (zip.files[notesName]) {
      const notesXml = await zip.files[notesName].async('string');
      const notes = Array.from(notesXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
        .map((r) => stripHtml(r[1]))
        .filter((t) => t && !/^\d+$/.test(t)) // drop slide-number placeholders
        .join(' ');
      if (notes) paragraphs.push(`Speaker notes: ${notes}`);
    }

    const text = normaliseWhitespace(paragraphs.join('\n'));
    if (text.length < 10) {
      emptySlides += 1;
      continue;
    }
    const heading = paragraphs[0] && paragraphs[0].length <= 120 ? paragraphs[0] : undefined;
    sections.push({ locator: `Slide ${slideNo}`, heading, text });
  }

  if (sections.length === 0) throw new ExtractionError('This PowerPoint file contains no readable text.');
  if (emptySlides > 0) warnings.push(`${emptySlides} slide(s) had no text and were skipped.`);
  return sections;
}

function extractPlainText(buffer: Buffer, isMarkdown: boolean): Omit<DocumentSection, 'index'>[] {
  const raw = normaliseWhitespace(buffer.toString('utf8').replace(/^﻿/, ''));
  if (!raw) throw new ExtractionError('This file is empty.');

  const sections: Omit<DocumentSection, 'index'>[] = [];
  if (isMarkdown && /^#{1,3}\s/m.test(raw)) {
    const parts = raw.split(/^(?=#{1,3}\s)/m);
    for (const part of parts) {
      const m = part.match(/^#{1,3}\s+(.+)$/m);
      const heading = m ? m[1].trim() : undefined;
      const text = normaliseWhitespace(part.replace(/^#{1,3}\s+.+$/m, heading ? heading : ''));
      if (text) sections.push({ locator: heading ? `Heading: ${heading}` : 'Body text', heading, text });
    }
  } else {
    // Group paragraphs into ~MAX_SECTION_CHARS chunks.
    let current = '';
    let n = 1;
    for (const para of raw.split(/\n\n+/)) {
      if (current && current.length + para.length > MAX_SECTION_CHARS) {
        sections.push({ locator: `Part ${n++}`, text: current.trim() });
        current = '';
      }
      current += para + '\n\n';
    }
    if (current.trim()) sections.push({ locator: `Part ${n}`, text: current.trim() });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function splitOversized(sections: Omit<DocumentSection, 'index'>[]): Omit<DocumentSection, 'index'>[] {
  const out: Omit<DocumentSection, 'index'>[] = [];
  for (const s of sections) {
    if (s.text.length <= MAX_SECTION_CHARS) {
      out.push(s);
      continue;
    }
    const paras = s.text.split(/\n\n+|\n(?=[A-Z0-9])/);
    let chunk = '';
    let part = 1;
    for (const p of paras) {
      if (chunk && chunk.length + p.length > MAX_SECTION_CHARS) {
        out.push({ locator: `${s.locator} (part ${part++})`, heading: part === 2 ? s.heading : undefined, text: chunk.trim() });
        chunk = '';
      }
      // A single monstrous paragraph: hard-wrap it.
      if (p.length > MAX_SECTION_CHARS) {
        for (let i = 0; i < p.length; i += MAX_SECTION_CHARS) {
          out.push({ locator: `${s.locator} (part ${part++})`, text: p.slice(i, i + MAX_SECTION_CHARS).trim() });
        }
        continue;
      }
      chunk += p + '\n\n';
    }
    if (chunk.trim()) out.push({ locator: `${s.locator} (part ${part})`, text: chunk.trim() });
  }
  return out;
}

function mergeFragments(sections: Omit<DocumentSection, 'index'>[]): Omit<DocumentSection, 'index'>[] {
  const out: Omit<DocumentSection, 'index'>[] = [];
  let pending: Omit<DocumentSection, 'index'> | null = null;
  for (const s of sections) {
    if (pending) {
      const merged: Omit<DocumentSection, 'index'> = {
        locator: `${pending.locator}; ${s.locator}`,
        heading: pending.heading ?? s.heading,
        text: `${pending.text}\n\n${s.text}`,
      };
      pending = null;
      if (merged.text.length < MIN_SECTION_CHARS) {
        pending = merged;
      } else {
        out.push(merged);
      }
      continue;
    }
    if (s.text.length < MIN_SECTION_CHARS) {
      pending = s;
    } else {
      out.push(s);
    }
  }
  if (pending) {
    if (out.length > 0) {
      const last = out[out.length - 1];
      last.text = `${last.text}\n\n${pending.text}`;
      last.locator = `${last.locator}; ${pending.locator}`;
    } else {
      out.push(pending);
    }
  }
  return out;
}

export async function extractDocument(file: { name: string; buffer: Buffer }): Promise<ExtractedDocument> {
  const format = detectFormat(file.name);
  if (!format) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'doc' || ext === 'ppt') {
      throw new ExtractionError(`Legacy .${ext} files are not supported. Save the file as .${ext}x and upload again.`);
    }
    throw new ExtractionError('Unsupported file type. Upload a PDF, Word (.docx), PowerPoint (.pptx), text or Markdown file.');
  }

  const warnings: string[] = [];
  let raw: Omit<DocumentSection, 'index'>[];
  switch (format) {
    case 'pdf':
      raw = await extractPdf(file.buffer, warnings);
      break;
    case 'docx':
      raw = await extractDocx(file.buffer);
      break;
    case 'pptx':
      raw = await extractPptx(file.buffer, warnings);
      break;
    case 'md':
      raw = extractPlainText(file.buffer, true);
      break;
    default:
      raw = extractPlainText(file.buffer, false);
  }

  const processed = mergeFragments(splitOversized(raw));
  const sections: DocumentSection[] = processed.map((s, index) => ({ index, ...s }));
  const totalChars = sections.reduce((n, s) => n + s.text.length, 0);

  if (totalChars < 200) {
    throw new ExtractionError('The document is too short to build a lesson from (fewer than 200 characters of text).');
  }
  if (totalChars > MAX_DOCUMENT_CHARS) {
    throw new ExtractionError(
      `The document is too long (${Math.round(totalChars / 1000)}k characters; the limit is ${MAX_DOCUMENT_CHARS / 1000}k). Split it into smaller files.`
    );
  }

  return { fileName: file.name, format, sections, totalChars, warnings };
}

/** Plain text of a subset of sections, with locators, for use as a grounding source. */
export function renderSourceText(sections: DocumentSection[]): string {
  return sections
    .map((s) => `[Source ${s.index} — ${s.locator}]\n${s.text}`)
    .join('\n\n');
}
