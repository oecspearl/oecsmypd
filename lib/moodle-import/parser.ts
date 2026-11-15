/**
 * High-fidelity parser for Moodle `.mbz` backups → MyPD structures.
 *
 * Built fresh (not adapted from the legacy text-only importer) and tested
 * against real OECS backup data. This module parses the XML layer; archive
 * reading and persistence live elsewhere.
 */

import { parseStringPromise } from "xml2js";

export interface BackupActivity {
  moduleid: string;
  sectionid: string;
  modulename: string;
  title: string;
  directory: string;
}

export interface BackupSection {
  sectionid: string;
  title: string;
  directory: string;
}

export interface BackupIndex {
  fullname: string;
  shortname: string;
  activities: BackupActivity[];
  sections: BackupSection[];
}

export interface BackupCourse {
  moodleId: string;
  shortname: string;
  title: string;
  description: string;
  format: string;
}

export interface MoodleAssignment {
  /** Course-module id, matching BackupActivity.moduleid. */
  moduleId: string;
  title: string;
  /** Assignment brief as HTML. May still contain @@PLUGINFILE@@ refs to rewire. */
  description: string;
  /** Unix seconds, or null when the backup records no due date (0). */
  dueDate: number | null;
  maxPoints: number | null;
}

export interface FileResolver {
  /** Maps a Moodle file name (decoded) to a stored URL in MyPD. */
  resolveFileUrl: (filename: string) => string;
}

export interface MoodlePage {
  moduleId: string;
  title: string;
  content: string;
}

export interface MoodleSectionContent {
  number: number;
  title: string;
  summary: string;
  /** Ordered course-module ids belonging to this section. */
  sequence: string[];
}

/**
 * Replace Moodle `@@PLUGINFILE@@/<url-encoded-name>` placeholders with resolved
 * URLs. Shared by pages, assignment briefs, and any HTML body with file refs.
 */
export function rewritePluginFileRefs(
  html: string,
  resolveFileUrl: (filename: string) => string
): string {
  return html.replace(/@@PLUGINFILE@@\/([^\s"'<>)]+)/g, (_match, encoded: string) => {
    let name = encoded;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      /* keep raw if it isn't valid percent-encoding */
    }
    return resolveFileUrl(name);
  });
}

/** First text value of an xml2js child element, or "" for empty/absent nodes. */
function text(node: Record<string, unknown> | undefined, key: string): string {
  if (!node) return "";
  const v = node[key];
  const first = Array.isArray(v) ? v[0] : v;
  if (first == null || typeof first === "object") return "";
  return String(first).trim();
}

export async function parseBackupIndex(xml: string): Promise<BackupIndex> {
  const parsed = await parseStringPromise(xml);
  const info = parsed?.moodle_backup?.information?.[0] ?? {};
  const contents = info.contents?.[0] ?? {};

  const activityNodes = contents.activities?.[0]?.activity ?? [];
  const activities: BackupActivity[] = activityNodes.map((a: Record<string, unknown>) => ({
    moduleid: text(a, "moduleid"),
    sectionid: text(a, "sectionid"),
    modulename: text(a, "modulename"),
    title: text(a, "title"),
    directory: text(a, "directory"),
  }));

  const sectionNodes = contents.sections?.[0]?.section ?? [];
  const sections: BackupSection[] = sectionNodes.map((s: Record<string, unknown>) => ({
    sectionid: text(s, "sectionid"),
    title: text(s, "title"),
    directory: text(s, "directory"),
  }));

  return {
    fullname: text(info, "original_course_fullname"),
    shortname: text(info, "original_course_shortname"),
    activities,
    sections,
  };
}

export async function parseCourse(xml: string): Promise<BackupCourse> {
  const parsed = await parseStringPromise(xml);
  const c = parsed?.course ?? {};
  // xml2js already decodes the XML-escaped HTML summary into real HTML.
  return {
    moodleId: String(c.$?.id ?? ""),
    shortname: text(c, "shortname"),
    title: text(c, "fullname"),
    description: text(c, "summary"),
    format: text(c, "format"),
  };
}

export async function parseAssignment(xml: string): Promise<MoodleAssignment> {
  const parsed = await parseStringPromise(xml);
  const activity = parsed?.activity ?? {};
  const assign = activity.assign?.[0] ?? {};

  const due = Number(text(assign, "duedate")) || 0;
  const gradeRaw = text(assign, "grade");
  const grade = Number(gradeRaw);

  return {
    moduleId: String(activity.$?.moduleid ?? ""),
    title: text(assign, "name"),
    description: text(assign, "intro"),
    dueDate: due > 0 ? due : null,
    maxPoints: gradeRaw && Number.isFinite(grade) && grade > 0 ? grade : null,
  };
}

export async function parsePage(xml: string, opts: FileResolver): Promise<MoodlePage> {
  const parsed = await parseStringPromise(xml);
  const activity = parsed?.activity ?? {};
  const page = activity.page?.[0] ?? {};
  return {
    moduleId: String(activity.$?.moduleid ?? ""),
    title: text(page, "name"),
    content: rewritePluginFileRefs(text(page, "content"), opts.resolveFileUrl),
  };
}

export async function parseSection(
  xml: string,
  opts: FileResolver
): Promise<MoodleSectionContent> {
  const parsed = await parseStringPromise(xml);
  const section = parsed?.section ?? {};
  const sequence = text(section, "sequence");
  return {
    number: Number(text(section, "number")) || 0,
    title: text(section, "name"),
    summary: rewritePluginFileRefs(text(section, "summary"), opts.resolveFileUrl),
    sequence: sequence
      ? sequence.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
}
