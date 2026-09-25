'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Button from '@/app/components/Button';
import RoleGuard from '@/app/components/RoleGuard';
import RichText from '@/app/components/RichText';
import { sanitizeHtml } from '@/lib/sanitize';
import type { ExtractedDocument, DocumentSection } from '@/lib/ai/document-extract';
import type { DocumentOutline, GeneratedLesson, GeneratedQuestion, OutlineLesson, QuestionType, Difficulty } from '@/lib/ai/lesson-generator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 'upload' | 'outline' | 'generating' | 'review' | 'saving' | 'saved';

interface Course {
  id: string;
  title: string;
}

interface GenState {
  status: 'pending' | 'running' | 'done' | 'error';
  lesson?: GeneratedLesson;
  error?: string;
}

interface SaveResult {
  title: string;
  lessonId?: string;
  quizId?: string;
  questionsSaved: number;
  error?: string;
}

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Multiple choice',
  true_false: 'True / false',
  short_answer: 'Short answer',
  essay: 'Essay',
};

const ROLES = ['instructor', 'curriculum_designer', 'admin', 'super_admin'];

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || fallback;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GenerateLessonsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-5xl px-4 py-8 text-sm text-gray-500">Loading…</div>}>
      <RoleGuard
        roles={ROLES}
        fallback={
          <div className="mx-auto max-w-2xl px-4 py-8">
            <p className="text-sm text-gray-700">You don&apos;t have permission to generate lessons.</p>
          </div>
        }
      >
        <GenerateLessonsWizard />
      </RoleGuard>
    </Suspense>
  );
}

function GenerateLessonsWizard() {
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = React.useState<Step>('upload');
  const [error, setError] = React.useState<string | null>(null);

  // Upload step
  const [courses, setCourses] = React.useState<Course[]>([]);
  const [courseId, setCourseId] = React.useState<string>(params.get('course_id') || '');
  const [file, setFile] = React.useState<File | null>(null);
  const [lessonCount, setLessonCount] = React.useState<string>('auto');
  const [questionCount, setQuestionCount] = React.useState<number>(5);
  const [questionTypes, setQuestionTypes] = React.useState<QuestionType[]>(['multiple_choice', 'true_false']);
  const [difficulty, setDifficulty] = React.useState<Difficulty>('medium');
  const [audience, setAudience] = React.useState<string>('');
  const [busy, setBusy] = React.useState<string | null>(null);

  // Outline step
  const [doc, setDoc] = React.useState<ExtractedDocument | null>(null);
  const [outline, setOutline] = React.useState<DocumentOutline | null>(null);

  // Generation / review
  const [gen, setGen] = React.useState<GenState[]>([]);
  const abortRef = React.useRef<boolean>(false);

  // Save
  const [saveResults, setSaveResults] = React.useState<SaveResult[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/courses');
        if (!res.ok) throw new Error(await readError(res, 'Failed to load courses'));
        const data = await res.json();
        if (!cancelled) {
          const list: Course[] = (data.courses || []).map((c: any) => ({ id: c.id, title: c.title }));
          setCourses(list);
          if (list.length === 0) setError('No courses available. Create a course before generating lessons.');
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load courses');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sectionsById = React.useMemo(() => {
    const map = new Map<number, DocumentSection>();
    doc?.sections.forEach((s) => map.set(s.index, s));
    return map;
  }, [doc]);

  // ---------------------------------------------------------------------
  // Step 1 → 2: extract + outline
  // ---------------------------------------------------------------------
  const analyse = async () => {
    setError(null);
    if (!courseId) return setError('Select a course.');
    if (!file) return setError('Choose a document to upload.');
    if (questionCount > 0 && questionTypes.length === 0) return setError('Select at least one question type, or set questions per lesson to 0.');

    try {
      setBusy('Reading document…');
      const form = new FormData();
      form.append('file', file);
      const exRes = await fetch('/api/ai/lesson-from-document/extract', { method: 'POST', body: form });
      if (!exRes.ok) throw new Error(await readError(exRes, 'Failed to read the document'));
      const extracted: ExtractedDocument = await exRes.json();
      setDoc(extracted);

      setBusy('Building lesson outline…');
      const olRes = await fetch('/api/ai/lesson-from-document/outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sections: extracted.sections,
          lessonCount: lessonCount === 'auto' ? null : Number(lessonCount),
          audience: audience || undefined,
        }),
      });
      if (!olRes.ok) throw new Error(await readError(olRes, 'Failed to build the outline'));
      const { outline: ol } = await olRes.json();
      setOutline(ol);
      setStep('outline');
    } catch (e: any) {
      setError(e?.message || 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  // ---------------------------------------------------------------------
  // Outline editing
  // ---------------------------------------------------------------------
  const updateOutlineLesson = (i: number, patch: Partial<OutlineLesson>) => {
    setOutline((o) => (o ? { ...o, lessons: o.lessons.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) } : o));
  };
  const removeOutlineLesson = (i: number) => {
    setOutline((o) => (o ? { ...o, lessons: o.lessons.filter((_, idx) => idx !== i) } : o));
  };
  const moveOutlineLesson = (i: number, dir: -1 | 1) => {
    setOutline((o) => {
      if (!o) return o;
      const j = i + dir;
      if (j < 0 || j >= o.lessons.length) return o;
      const arr = [...o.lessons];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...o, lessons: arr };
    });
  };

  // ---------------------------------------------------------------------
  // Step 2 → 3: generate each lesson sequentially
  // ---------------------------------------------------------------------
  const generateOne = async (i: number, l: OutlineLesson): Promise<GenState> => {
    const sections = l.section_indexes.map((idx) => sectionsById.get(idx)).filter(Boolean) as DocumentSection[];
    const res = await fetch('/api/ai/lesson-from-document/lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sections,
        lesson: l,
        questionCount,
        questionTypes,
        difficulty,
        audience: audience || undefined,
      }),
    });
    if (!res.ok) return { status: 'error', error: await readError(res, 'Generation failed') };
    const { lesson } = await res.json();
    return { status: 'done', lesson };
  };

  const generateAll = async () => {
    if (!outline || outline.lessons.length === 0) return setError('The outline has no lessons.');
    setError(null);
    abortRef.current = false;
    setStep('generating');
    const initial: GenState[] = outline.lessons.map(() => ({ status: 'pending' }));
    setGen(initial);

    for (let i = 0; i < outline.lessons.length; i++) {
      if (abortRef.current) break;
      setGen((g) => g.map((s, idx) => (idx === i ? { status: 'running' } : s)));
      let result: GenState;
      try {
        result = await generateOne(i, outline.lessons[i]);
      } catch (e: any) {
        result = { status: 'error', error: e?.message || 'Network error' };
      }
      setGen((g) => g.map((s, idx) => (idx === i ? result : s)));
    }
    setStep('review');
  };

  const regenerate = async (i: number) => {
    if (!outline) return;
    setGen((g) => g.map((s, idx) => (idx === i ? { status: 'running' } : s)));
    let result: GenState;
    try {
      result = await generateOne(i, outline.lessons[i]);
    } catch (e: any) {
      result = { status: 'error', error: e?.message || 'Network error' };
    }
    setGen((g) => g.map((s, idx) => (idx === i ? result : s)));
  };

  // ---------------------------------------------------------------------
  // Review editing
  // ---------------------------------------------------------------------
  const patchLesson = (i: number, patch: Partial<GeneratedLesson>) => {
    setGen((g) => g.map((s, idx) => (idx === i && s.lesson ? { ...s, lesson: { ...s.lesson, ...patch } } : s)));
  };
  const removeQuestion = (i: number, qi: number) => {
    setGen((g) =>
      g.map((s, idx) => (idx === i && s.lesson ? { ...s, lesson: { ...s.lesson, questions: s.lesson.questions.filter((_, q) => q !== qi) } } : s))
    );
  };
  const dropLesson = (i: number) => {
    setGen((g) => g.filter((_, idx) => idx !== i));
    setOutline((o) => (o ? { ...o, lessons: o.lessons.filter((_, idx) => idx !== i) } : o));
  };

  // ---------------------------------------------------------------------
  // Step 4: save through the existing lesson / quiz / question APIs
  // ---------------------------------------------------------------------
  const saveAll = async () => {
    const ready = gen.filter((g) => g.status === 'done' && g.lesson);
    if (ready.length === 0) return setError('Nothing to save.');
    setError(null);
    setStep('saving');

    // Continue numbering after existing lessons in the course.
    let nextOrder = 0;
    try {
      const res = await fetch(`/api/lessons?course_id=${encodeURIComponent(courseId)}`);
      if (res.ok) {
        const data = await res.json();
        const orders = (data.lessons || []).map((l: any) => Number(l.order) || 0);
        nextOrder = orders.length ? Math.max(...orders) + 1 : 0;
      }
    } catch {
      /* fall back to 0 */
    }

    const results: SaveResult[] = [];
    for (const g of ready) {
      const L = g.lesson!;
      const result: SaveResult = { title: L.title, questionsSaved: 0 };
      try {
        const html = sanitizeHtml(L.html);
        const contentBlock = { type: 'text', title: L.title, data: html, id: `text-${Date.now()}-${Math.floor(Math.random() * 1e6)}` };
        const lessonRes = await fetch('/api/lessons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            course_id: courseId,
            title: L.title,
            description: L.description,
            order: nextOrder++,
            learning_outcomes: L.learning_outcomes,
            lesson_instructions: '',
            content: [contentBlock],
            resources: [],
            estimated_time: L.estimated_minutes,
            difficulty: L.difficulty,
            published: false,
          }),
        });
        if (!lessonRes.ok) throw new Error(await readError(lessonRes, 'Failed to create lesson'));
        const lesson = await lessonRes.json();
        result.lessonId = lesson.id;

        if (L.questions.length > 0) {
          const totalPoints = L.questions.reduce((n, q) => n + q.points, 0);
          const quizRes = await fetch('/api/quizzes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lesson_id: lesson.id,
              course_id: courseId,
              title: `${L.title} — Quiz`,
              description: `Checks understanding of "${L.title}".`,
              instructions: 'Answer every question. You can review the lesson before you begin.',
              attempts_allowed: 2,
              show_correct_answers: true,
              show_feedback: 'after_submit',
              randomize_questions: false,
              randomize_answers: true,
              passing_score: 70,
              points: totalPoints,
              published: false,
            }),
          });
          if (!quizRes.ok) throw new Error(await readError(quizRes, 'Lesson saved but the quiz could not be created'));
          const { id: quizId } = await quizRes.json();
          result.quizId = quizId;

          for (let qi = 0; qi < L.questions.length; qi++) {
            const q = L.questions[qi];
            const qRes = await fetch(`/api/quizzes/${quizId}/questions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: q.type,
                question_text: q.question_text,
                points: q.points,
                order: qi,
                options: q.options.length ? q.options : null,
                correct_answer: q.correct_answer,
                case_sensitive: false,
                feedback_correct: q.feedback_correct,
                feedback_incorrect: q.feedback_incorrect,
              }),
            });
            if (!qRes.ok) throw new Error(await readError(qRes, `Question ${qi + 1} could not be saved`));
            result.questionsSaved += 1;
          }
        }
      } catch (e: any) {
        result.error = e?.message || 'Save failed';
      }
      results.push(result);
      setSaveResults([...results]);
    }
    setStep('saved');
  };

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const stepIndex: Record<Step, number> = { upload: 0, outline: 1, generating: 2, review: 3, saving: 4, saved: 4 };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-gray-900">Generate Lessons from a Document</h1>
          <p className="mt-1 text-sm text-gray-600">
            Upload a PDF, Word, PowerPoint, text or Markdown file. The AI drafts lessons, rich-text content and quizzes grounded in the document, checks them, and lets you review everything before saving.
          </p>
        </div>
        <Link href={courseId ? `/manage-lessons?course_id=${courseId}` : '/manage-lessons'} className="text-sm text-blue-600 hover:underline whitespace-nowrap">
          Back to lessons
        </Link>
      </div>

      <ol className="mb-6 flex flex-wrap gap-2 text-xs">
        {['Upload', 'Outline', 'Generate', 'Review', 'Save'].map((label, i) => (
          <li key={label} className={`rounded-full px-3 py-1 ${i === stepIndex[step] ? 'bg-blue-600 text-white' : i < stepIndex[step] ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {step === 'upload' && (
        <div className="card space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Course *</span>
              <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">Select a course…</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Document *</span>
              <input
                type="file"
                accept=".pdf,.docx,.pptx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown"
                className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <span className="mt-1 block text-xs text-gray-500">PDF, .docx, .pptx, .txt or .md up to 4 MB. Scanned PDFs need OCR first.</span>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Number of lessons</span>
              <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={lessonCount} onChange={(e) => setLessonCount(e.target.value)}>
                <option value="auto">Let the AI decide</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Quiz questions per lesson</span>
              <input type="number" min={0} max={20} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={questionCount} onChange={(e) => setQuestionCount(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
              <span className="mt-1 block text-xs text-gray-500">Set to 0 to skip quizzes.</span>
            </label>

            <div>
              <span className="text-sm font-medium text-gray-700">Question types</span>
              <div className="mt-2 flex flex-wrap gap-3">
                {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
                  <label key={t} className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={questionTypes.includes(t)}
                      onChange={(e) => setQuestionTypes((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))}
                    />
                    {QUESTION_TYPE_LABELS[t]}
                  </label>
                ))}
              </div>
              <span className="mt-1 block text-xs text-gray-500">Multiple choice, true/false and short answer are auto-graded. Essays need manual grading.</span>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Difficulty</span>
              <select className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="mixed">Mixed</option>
              </select>
            </label>

            <label className="block md:col-span-2">
              <span className="text-sm font-medium text-gray-700">Audience (optional)</span>
              <input
                type="text"
                maxLength={300}
                placeholder="e.g. Primary school teachers new to the topic; Grade 10 students"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={analyse} disabled={Boolean(busy) || !courseId || !file}>
              {busy || 'Analyse document'}
            </Button>
            {busy && <span className="text-xs text-gray-500">This usually takes 10–40 seconds.</span>}
          </div>
        </div>
      )}

      {step === 'outline' && outline && doc && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-lg font-medium text-gray-900">{outline.document_title}</h2>
            <p className="mt-1 text-sm text-gray-600">{outline.summary}</p>
            <p className="mt-2 text-xs text-gray-500">
              {doc.fileName} · {doc.sections.length} sections · {Math.round(doc.totalChars / 1000)}k characters
            </p>
            {doc.warnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-700">
                {doc.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-sm text-gray-600">Review the proposed lessons. Edit titles, descriptions and outcomes, reorder or remove lessons, then generate.</p>

          {outline.lessons.map((l, i) => (
            <div key={i} className="card space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 space-y-2">
                  <input className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-medium" value={l.title} onChange={(e) => updateOutlineLesson(i, { title: e.target.value })} />
                  <textarea className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" rows={2} value={l.description} onChange={(e) => updateOutlineLesson(i, { description: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                  <button type="button" className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50" onClick={() => moveOutlineLesson(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button type="button" className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50" onClick={() => moveOutlineLesson(i, 1)} disabled={i === outline.lessons.length - 1}>
                    ↓
                  </button>
                  <button type="button" className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => removeOutlineLesson(i)}>
                    Remove
                  </button>
                </div>
              </div>

              <div>
                <span className="text-xs font-medium text-gray-700">Learning outcomes (one per line)</span>
                <textarea
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  rows={Math.max(2, l.learning_outcomes.length)}
                  value={l.learning_outcomes.join('\n')}
                  onChange={(e) => updateOutlineLesson(i, { learning_outcomes: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
                />
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                <span>Sources: {l.section_indexes.map((idx) => sectionsById.get(idx)?.locator || `#${idx}`).join(', ')}</span>
                <span>~{l.estimated_minutes} min</span>
                <span>Difficulty {l.difficulty}/3</span>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button onClick={generateAll} disabled={outline.lessons.length === 0}>
              Generate {outline.lessons.length} lesson{outline.lessons.length === 1 ? '' : 's'}
            </Button>
            <Button variant="secondary" onClick={() => setStep('upload')}>
              Back
            </Button>
            <span className="text-xs text-gray-500">Roughly 1–2 minutes per lesson. Each lesson is fact-checked and its questions verified against the document.</span>
          </div>
        </div>
      )}

      {(step === 'generating' || step === 'review') && outline && (
        <div className="space-y-4">
          {step === 'generating' && (
            <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm text-blue-800">
                Generating lesson {Math.min(gen.filter((g) => g.status !== 'pending').length, gen.length)} of {gen.length}… Keep this tab open.
              </p>
              <button type="button" className="text-xs text-blue-700 underline" onClick={() => (abortRef.current = true)}>
                Stop after current lesson
              </button>
            </div>
          )}

          {gen.map((g, i) => (
            <LessonReviewCard
              key={i}
              index={i}
              outline={outline.lessons[i]}
              state={g}
              editable={step === 'review'}
              onRegenerate={() => regenerate(i)}
              onRemoveQuestion={(qi) => removeQuestion(i, qi)}
              onPatch={(patch) => patchLesson(i, patch)}
              onDrop={() => dropLesson(i)}
            />
          ))}

          {step === 'review' && (
            <div className="card flex flex-wrap items-center gap-3">
              <Button onClick={saveAll} disabled={gen.every((g) => g.status !== 'done')}>
                Save {gen.filter((g) => g.status === 'done').length} lesson{gen.filter((g) => g.status === 'done').length === 1 ? '' : 's'} to course
              </Button>
              <Button variant="secondary" onClick={() => setStep('outline')}>
                Back to outline
              </Button>
              <span className="text-xs text-gray-500">Lessons and quizzes are saved unpublished so you can make final edits before students see them.</span>
            </div>
          )}
        </div>
      )}

      {step === 'saving' && (
        <div className="card">
          <p className="text-sm text-gray-700">Saving… {saveResults.length} of {gen.filter((g) => g.status === 'done').length} lessons done.</p>
        </div>
      )}

      {step === 'saved' && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-lg font-medium text-gray-900">Done</h2>
            <ul className="mt-3 divide-y divide-gray-100">
              {saveResults.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{r.title}</p>
                    {r.error ? (
                      <p className="text-xs text-red-600">{r.error}</p>
                    ) : (
                      <p className="text-xs text-gray-500">
                        Lesson created{r.quizId ? ` · quiz with ${r.questionsSaved} question${r.questionsSaved === 1 ? '' : 's'}` : ' · no quiz'} · unpublished
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {r.lessonId && (
                      <Link href={`/lessons/${r.lessonId}/edit`} className="rounded-md border px-3 py-1 text-xs text-blue-700 hover:bg-blue-50">
                        Edit lesson
                      </Link>
                    )}
                    {r.quizId && (
                      <Link href={`/quizzes/${r.quizId}/edit`} className="rounded-md border px-3 py-1 text-xs text-blue-700 hover:bg-blue-50">
                        Edit quiz
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex gap-3">
            <Button onClick={() => router.push(`/manage-lessons?course_id=${courseId}`)}>Go to lessons</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setStep('upload');
                setFile(null);
                setDoc(null);
                setOutline(null);
                setGen([]);
                setSaveResults([]);
                setError(null);
              }}
            >
              Generate from another document
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lesson card (generation progress + review)
// ---------------------------------------------------------------------------

function LessonReviewCard(props: {
  index: number;
  outline: OutlineLesson;
  state: GenState;
  editable: boolean;
  onRegenerate: () => void;
  onRemoveQuestion: (qi: number) => void;
  onPatch: (patch: Partial<GeneratedLesson>) => void;
  onDrop: () => void;
}) {
  const { index, outline, state, editable, onRegenerate, onRemoveQuestion, onPatch, onDrop } = props;
  const [open, setOpen] = React.useState<'content' | 'questions' | 'checks' | null>(null);
  const L = state.lesson;

  const badge =
    state.status === 'pending' ? (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">Waiting</span>
    ) : state.status === 'running' ? (
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">Generating…</span>
    ) : state.status === 'error' ? (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Failed</span>
    ) : L?.accuracy.needs_review ? (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Needs review</span>
    ) : (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Verified</span>
    );

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editable && L ? (
            <input className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium" value={L.title} onChange={(e) => onPatch({ title: e.target.value })} />
          ) : (
            <p className="text-sm font-medium text-gray-900">
              {index + 1}. {L?.title || outline.title}
            </p>
          )}
          {state.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
          {L && (
            <p className="mt-1 text-xs text-gray-500">
              Faithfulness {L.accuracy.faithfulness_score}/100
              {L.accuracy.content_regenerated ? ' (regenerated after fact-check)' : ''} · {L.accuracy.questions_kept}/{L.accuracy.questions_requested} questions passed verification
              {L.accuracy.rejected_questions.length > 0 ? ` · ${L.accuracy.rejected_questions.length} rejected` : ''} · ~{L.estimated_minutes} min
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {badge}
          {editable && (state.status === 'done' || state.status === 'error') && (
            <>
              <button type="button" className="rounded border px-2 py-1 text-xs text-gray-700 hover:bg-gray-50" onClick={onRegenerate}>
                Regenerate
              </button>
              <button type="button" className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={onDrop}>
                Drop
              </button>
            </>
          )}
        </div>
      </div>

      {L && (
        <>
          <div className="flex gap-2 text-xs">
            {(['content', 'questions', 'checks'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`rounded-md px-3 py-1 ${open === tab ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                onClick={() => setOpen(open === tab ? null : tab)}
              >
                {tab === 'content' ? 'Content' : tab === 'questions' ? `Questions (${L.questions.length})` : 'Accuracy checks'}
              </button>
            ))}
          </div>

          {open === 'content' && (
            <div className="rounded-lg border border-gray-200 p-4">
              {L.learning_outcomes.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Learning outcomes</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-gray-700">
                    {L.learning_outcomes.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                </div>
              )}
              <RichText html={L.html} />
            </div>
          )}

          {open === 'questions' && (
            <div className="space-y-3">
              {L.questions.length === 0 && <p className="text-sm text-gray-500">No questions passed verification for this lesson. Regenerate to try again.</p>}
              {L.questions.map((q, qi) => (
                <QuestionPreview key={qi} q={q} n={qi + 1} onRemove={editable ? () => onRemoveQuestion(qi) : undefined} />
              ))}
            </div>
          )}

          {open === 'checks' && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-medium text-gray-900">Content fact-check</p>
                <p className="text-gray-600">
                  Score {L.accuracy.faithfulness_score}/100.{' '}
                  {L.accuracy.unsupported_claims.length === 0 ? 'No unsupported claims found.' : `${L.accuracy.unsupported_claims.length} claim(s) flagged as not supported by the document:`}
                </p>
                {L.accuracy.unsupported_claims.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-amber-800">
                    {L.accuracy.unsupported_claims.map((c, i) => (
                      <li key={i}>
                        “{c.claim}” — {c.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="font-medium text-gray-900">Question verification</p>
                <p className="text-gray-600">
                  {L.accuracy.questions_generated} generated, {L.accuracy.questions_kept} kept. Each kept question cites a verbatim passage from the document and passed an independent check of answerability, answer key and clarity.
                </p>
                {L.accuracy.rejected_questions.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-gray-600">
                    {L.accuracy.rejected_questions.map((r, i) => (
                      <li key={i}>
                        <span className="text-gray-800">{r.question_text}</span> — <span className="text-red-700">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QuestionPreview({ q, n, onRemove }: { q: GeneratedQuestion; n: number; onRemove?: () => void }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-900">
          <span className="mr-2 text-xs font-semibold text-gray-500">Q{n}</span>
          {q.question_text}
          <span className="ml-2 text-xs text-gray-500">
            ({QUESTION_TYPE_LABELS[q.type]}, {q.points} pt{q.points === 1 ? '' : 's'})
          </span>
        </p>
        {onRemove && (
          <button type="button" className="text-xs text-red-600 hover:underline" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {q.options.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {q.options.map((o) => (
            <li key={o.id} className={o.is_correct ? 'font-medium text-green-700' : 'text-gray-700'}>
              {o.is_correct ? '✓' : '○'} {o.text}
            </li>
          ))}
        </ul>
      )}
      {q.type === 'short_answer' && q.correct_answer && <p className="mt-2 text-sm text-green-700">Accepted: {q.correct_answer.join(' · ')}</p>}
      <p className="mt-2 text-xs text-gray-500">
        Source: “{q.source_quote}”
      </p>
    </div>
  );
}
