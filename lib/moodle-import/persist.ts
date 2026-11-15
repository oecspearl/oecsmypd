/**
 * Persists a parsed Moodle backup into MyPD's Supabase schema.
 *
 * Flow: collect the file references the course needs → upload just those files
 * to Storage → build the course with a resolver that points at the stored URLs
 * → insert course → subjects (sections) → lessons (+ assignments rows).
 *
 * Interactives are stored natively as an `interactive` content block inside the
 * lesson's `content` jsonb (no separate table needed to display imported H5P).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MoodleArchive } from "./archive";
import { buildCourseFromArchive, type ImportedLesson } from "./build";

const BUCKET = "course-materials";

export interface ImportSummary {
  courseId: string;
  subjects: number;
  lessons: number;
  assignments: number;
  interactives: number;
  filesUploaded: number;
}

interface FileEntry {
  contenthash: string;
  mimetype: string;
}

/** Build basename → {contenthash, mimetype} from files.xml. */
function parseFilesXml(xml: string): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const block of xml.match(/<file\b[\s\S]*?<\/file>/g) ?? []) {
    const filename = /<filename>([\s\S]*?)<\/filename>/.exec(block)?.[1]?.trim();
    const contenthash = /<contenthash>([\s\S]*?)<\/contenthash>/.exec(block)?.[1]?.trim();
    const mimetype =
      /<mimetype>([\s\S]*?)<\/mimetype>/.exec(block)?.[1]?.trim() || "application/octet-stream";
    if (!filename || filename === "." || !contenthash) continue;
    map.set(basename(filename), { contenthash, mimetype });
  }
  return map;
}

function basename(ref: string): string {
  let s = ref;
  try {
    s = decodeURIComponent(ref);
  } catch {
    /* keep raw */
  }
  return s.split(/[\\/]/).pop() ?? s;
}

function storageKey(courseId: string, hash: string, name: string): string {
  const safe = name.replace(/[^\w.\-]+/g, "_");
  return `${courseId}/${hash}-${safe}`;
}

async function ensureBucket(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    await supabase.storage.createBucket(BUCKET, { public: true });
  }
}

function lessonContentBlocks(lesson: ImportedLesson): unknown[] {
  switch (lesson.kind) {
    case "interactive":
      return [{ type: "interactive", title: lesson.title, data: lesson.interactive }];
    case "assignment":
      return [
        {
          type: "assignment",
          title: lesson.title,
          data: {
            description: lesson.assignment?.description ?? "",
            dueDate: lesson.assignment?.dueDate ?? null,
            points: lesson.assignment?.maxPoints ?? null,
          },
        },
      ];
    default:
      return [{ type: "text", title: lesson.title, data: { html: lesson.html ?? "" } }];
  }
}

function contentTypeFor(kind: ImportedLesson["kind"]): string {
  if (kind === "interactive") return "interactive";
  if (kind === "assignment") return "assignment";
  return "rich_text";
}

export async function importBackupToSupabase(
  archive: MoodleArchive,
  supabase: SupabaseClient
): Promise<ImportSummary> {
  await ensureBucket(supabase);

  // 1. Create the course first (we need its id for storage keys).
  const buildOnce = (resolveFileUrl: (p: string) => string) =>
    buildCourseFromArchive(archive, { resolveFileUrl });

  // Pass A: record which file refs the content actually needs.
  const requested = new Set<string>();
  await buildOnce((ref) => {
    requested.add(ref);
    return ref;
  });
  const meta = (await buildOnce(() => "")) as Awaited<ReturnType<typeof buildOnce>>;

  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .insert({
      title: meta.title,
      description: meta.description,
      grade_level: "Professional Development",
      subject_area: meta.shortname,
      difficulty: "beginner",
      modality: "self_paced",
      published: false,
    })
    .select("id")
    .single();
  if (courseErr || !course) throw new Error(`course insert failed: ${courseErr?.message}`);
  const courseId = course.id as string;

  // 2. Upload the referenced files and build the ref → URL map.
  const filesXml = archive.readText("files.xml") ?? "";
  const fileMap = parseFilesXml(filesXml);
  const urlMap = new Map<string, string>();
  let filesUploaded = 0;

  for (const ref of requested) {
    const entry = fileMap.get(basename(ref));
    if (!entry) continue;
    const blob = archive.readBuffer(`files/${entry.contenthash.slice(0, 2)}/${entry.contenthash}`);
    if (!blob) continue;
    const key = storageKey(courseId, entry.contenthash, basename(ref));
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(key, blob, { contentType: entry.mimetype, upsert: true });
    if (upErr) continue;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(key);
    urlMap.set(ref, pub.publicUrl);
    filesUploaded++;
  }

  // 3. Rebuild the course with real URLs.
  const built = await buildOnce((ref) => urlMap.get(ref) ?? ref);

  // 4. Insert subjects → lessons (+ assignments).
  let lessonCount = 0;
  let assignmentCount = 0;
  let interactiveCount = 0;

  for (const section of built.sections) {
    const { data: subject, error: subjErr } = await supabase
      .from("subjects")
      .insert({
        course_id: courseId,
        title: section.title,
        description: section.summary,
        order: section.number,
        published: true,
      })
      .select("id")
      .single();
    if (subjErr || !subject) throw new Error(`subject insert failed: ${subjErr?.message}`);

    for (const lesson of section.lessons) {
      const { data: lessonRow, error: lessonErr } = await supabase
        .from("lessons")
        .insert({
          course_id: courseId,
          subject_id: subject.id,
          title: lesson.title,
          content: lessonContentBlocks(lesson),
          content_type: contentTypeFor(lesson.kind),
          order: lesson.order,
          published: false,
        })
        .select("id")
        .single();
      if (lessonErr || !lessonRow) throw new Error(`lesson insert failed: ${lessonErr?.message}`);
      lessonCount++;
      if (lesson.kind === "interactive") interactiveCount++;

      if (lesson.kind === "assignment" && lesson.assignment) {
        const { error: aErr } = await supabase.from("assignments").insert({
          course_id: courseId,
          lesson_id: lessonRow.id,
          title: lesson.assignment.title,
          description: lesson.assignment.description,
          due_date: lesson.assignment.dueDate
            ? new Date(lesson.assignment.dueDate * 1000).toISOString()
            : null,
          points: lesson.assignment.maxPoints,
          published: false,
        });
        if (aErr) throw new Error(`assignment insert failed: ${aErr.message}`);
        assignmentCount++;
      }
    }
  }

  return {
    courseId,
    subjects: built.sections.length,
    lessons: lessonCount,
    assignments: assignmentCount,
    interactives: interactiveCount,
    filesUploaded,
  };
}
