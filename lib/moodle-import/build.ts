/**
 * Orchestrator: reads a whole Moodle `.mbz` and assembles a MyPD course tree —
 * sections in order, each activity dispatched to the right parser/converter.
 *
 * Produces a pure in-memory structure (no DB, no uploads). File URLs are
 * resolved via an injected resolver so this stays testable offline; the
 * persistence layer supplies a real resolver after uploading files.
 */

import { parseStringPromise } from "xml2js";
import type { MoodleArchive } from "./archive";
import {
  parseBackupIndex,
  parseCourse,
  parseAssignment,
  parsePage,
  parseSection,
  rewritePluginFileRefs,
  type FileResolver,
  type MoodleAssignment,
} from "./parser";
import {
  convertImageHotspots,
  convertInteractiveVideo,
  type MyPdInteractiveContent,
} from "./h5p-converters";
import { parseQuestionBank, parseQuiz, type MoodleQuiz } from "./quiz-parser";

export type LessonKind = "page" | "assignment" | "interactive" | "quiz" | "folder" | "generic";

export interface LessonFile {
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface ImportedLesson {
  moduleId: string;
  modulename: string;
  title: string;
  /** Order within its section (0-based). */
  order: number;
  kind: LessonKind;
  /** HTML body for page/generic lessons. */
  html?: string;
  assignment?: MoodleAssignment;
  interactive?: MyPdInteractiveContent;
  quiz?: MoodleQuiz;
  /** Downloadable files for folder lessons. */
  files?: LessonFile[];
}

interface FolderFileMeta {
  name: string;
  mimetype: string;
  size: number;
}

/** Index mod_folder content files from files.xml by their folder's contextid. */
function parseFolderFiles(filesXml: string): Map<string, FolderFileMeta[]> {
  const map = new Map<string, FolderFileMeta[]>();
  for (const block of filesXml.match(/<file id="\d+">[\s\S]*?<\/file>/g) ?? []) {
    if (!/<component>mod_folder<\/component>/.test(block)) continue;
    if (!/<filearea>content<\/filearea>/.test(block)) continue;
    const name = /<filename>([\s\S]*?)<\/filename>/.exec(block)?.[1]?.trim();
    if (!name || name === ".") continue;
    const ctx = /<contextid>([\s\S]*?)<\/contextid>/.exec(block)?.[1]?.trim() ?? "";
    const mimetype =
      /<mimetype>([\s\S]*?)<\/mimetype>/.exec(block)?.[1]?.trim() || "application/octet-stream";
    const size = Number(/<filesize>([\s\S]*?)<\/filesize>/.exec(block)?.[1] ?? "0");
    const arr = map.get(ctx) ?? [];
    arr.push({ name, mimetype, size });
    map.set(ctx, arr);
  }
  return map;
}

export interface ImportedSection {
  number: number;
  title: string;
  summary: string;
  lessons: ImportedLesson[];
}

export interface ImportedCourse {
  shortname: string;
  title: string;
  description: string;
  sections: ImportedSection[];
}

/** First text value of an xml2js child, or "" for empty/absent nodes. */
function text(node: Record<string, unknown> | undefined, key: string): string {
  if (!node) return "";
  const v = node[key];
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null || typeof first === "object") return "";
  return String(first).trim();
}

/** Generic activity (forum, url, label, googlemeet, …): keep name + intro HTML. */
async function parseGeneric(
  xml: string,
  modulename: string,
  opts: FileResolver
): Promise<{ title: string; html: string }> {
  const parsed = await parseStringPromise(xml);
  const activity = parsed?.activity ?? {};
  const inner = activity[modulename]?.[0] ?? {};
  return {
    title: text(inner, "name"),
    html: rewritePluginFileRefs(text(inner, "intro"), opts.resolveFileUrl),
  };
}

/** Parse a folder activity into its intro + downloadable file list. */
async function parseFolder(
  xml: string,
  folderFiles: Map<string, FolderFileMeta[]>,
  opts: FileResolver
): Promise<{ title: string; intro: string; files: LessonFile[] }> {
  const parsed = await parseStringPromise(xml);
  const activity = parsed?.activity ?? {};
  const contextid = String(activity.$?.contextid ?? "");
  const folder = activity.folder?.[0] ?? {};
  const files: LessonFile[] = (folderFiles.get(contextid) ?? []).map((f) => ({
    name: f.name,
    url: opts.resolveFileUrl(f.name),
    type: f.name.split(".").pop()?.toLowerCase() ?? "",
    size: f.size,
  }));
  return {
    title: text(folder, "name"),
    intro: rewritePluginFileRefs(text(folder, "intro"), opts.resolveFileUrl),
    files,
  };
}

/** Parse an H5P (hvp) activity into a native MyPD interactive, or null if unsupported. */
async function parseHvp(
  xml: string,
  title: string,
  opts: FileResolver
): Promise<MyPdInteractiveContent | null> {
  const parsed = await parseStringPromise(xml);
  const hvp = parsed?.activity?.hvp?.[0] ?? {};
  const machineName = text(hvp, "machine_name");
  const raw = text(hvp, "json_content");
  if (!raw) return null;

  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    return null;
  }

  if (machineName === "H5P.ImageHotspots") {
    return convertImageHotspots(content as never, { ...opts, title });
  }
  if (machineName === "H5P.InteractiveVideo") {
    return convertInteractiveVideo(content as never, { ...opts, title });
  }
  return null;
}

export async function buildCourseFromArchive(
  archive: MoodleArchive,
  opts: FileResolver
): Promise<ImportedCourse> {
  const backupXml = archive.readText("moodle_backup.xml");
  const courseXml = archive.readText("course/course.xml");
  if (!backupXml || !courseXml) {
    throw new Error("Not a Moodle backup: missing moodle_backup.xml or course.xml");
  }

  const index = await parseBackupIndex(backupXml);
  const course = await parseCourse(courseXml);

  // The question bank is a single root file shared by every quiz in the course.
  const questionsXml = archive.readText("questions.xml");
  const questionBank = questionsXml ? await parseQuestionBank(questionsXml) : new Map();

  // Folder content files, indexed by folder contextid.
  const filesXml = archive.readText("files.xml");
  const folderFiles = filesXml ? parseFolderFiles(filesXml) : new Map<string, FolderFileMeta[]>();

  // moduleId -> activity descriptor, for sequence lookups.
  const activityById = new Map(index.activities.map((a) => [a.moduleid, a]));

  const sections: ImportedSection[] = [];

  for (const sec of index.sections) {
    const sectionXml = archive.readText(`${sec.directory}/section.xml`);
    if (!sectionXml) continue;
    const parsedSection = await parseSection(sectionXml, opts);

    const lessons: ImportedLesson[] = [];
    let order = 0;

    for (const moduleId of parsedSection.sequence) {
      const activity = activityById.get(moduleId);
      if (!activity) continue;

      const activityXml = archive.readText(
        `${activity.directory}/${activity.modulename}.xml`
      );
      if (!activityXml) continue;

      const base = {
        moduleId: activity.moduleid,
        modulename: activity.modulename,
        order: order++,
      };

      if (activity.modulename === "page") {
        const page = await parsePage(activityXml, opts);
        lessons.push({ ...base, title: page.title, kind: "page", html: page.content });
      } else if (activity.modulename === "assign") {
        const assignment = await parseAssignment(activityXml);
        assignment.description = rewritePluginFileRefs(
          assignment.description,
          opts.resolveFileUrl
        );
        lessons.push({ ...base, title: assignment.title, kind: "assignment", assignment });
      } else if (activity.modulename === "quiz") {
        const quiz = await parseQuiz(activityXml, questionBank);
        lessons.push({ ...base, title: quiz.title || activity.title, kind: "quiz", quiz });
      } else if (activity.modulename === "folder") {
        const folder = await parseFolder(activityXml, folderFiles, opts);
        lessons.push({
          ...base,
          title: folder.title || activity.title,
          kind: "folder",
          html: folder.intro,
          files: folder.files,
        });
      } else if (activity.modulename === "hvp") {
        const interactive = await parseHvp(activityXml, activity.title, opts);
        if (interactive) {
          lessons.push({ ...base, title: interactive.title, kind: "interactive", interactive });
        } else {
          lessons.push({ ...base, title: activity.title, kind: "generic", html: "" });
        }
      } else {
        const generic = await parseGeneric(activityXml, activity.modulename, opts);
        lessons.push({
          ...base,
          title: generic.title || activity.title,
          kind: "generic",
          html: generic.html,
        });
      }
    }

    sections.push({
      number: parsedSection.number,
      title: parsedSection.title,
      summary: parsedSection.summary,
      lessons,
    });
  }

  sections.sort((a, b) => a.number - b.number);

  return {
    shortname: course.shortname,
    title: course.title,
    description: course.description,
    sections,
  };
}
