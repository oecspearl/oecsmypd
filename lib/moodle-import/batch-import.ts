/**
 * Imports a whole topic group (per-facilitator copies) into ONE MyPD course:
 * course content once from a representative backup, then a class + its people
 * for each facilitator. People are deduped by email across the classes, so a
 * learner who appears in several facilitator copies becomes one account.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MoodleArchive } from "./archive";
import type { CourseGroup } from "./course-grouping";
import { importBackupToSupabase } from "./persist";
import { parseEnrolledUsers, type EnrolledUser } from "./people-parser";
import { importPeopleForCourse } from "./people-import";
import { parseFinalGrades } from "./grade-parser";
import { parseConferences, parseForums } from "./tails-parser";

export interface ClassImportResult {
  facilitator: string;
  usersCreated: number;
  usersExisting: number;
  enrollments: number;
  instructors: number;
  grades: number;
}

export interface GroupImportResult {
  topic: string;
  courseId: string;
  classes: ClassImportResult[];
  conferences: number;
  discussions: number;
  replies: number;
}

/** Import Google Meet sessions as video conferences (content, no author mapping). */
async function importConferences(
  supabase: SupabaseClient,
  courseId: string,
  archive: Parameters<typeof parseEnrolledUsers>[0]
): Promise<number> {
  let count = 0;
  for (const c of parseConferences(archive)) {
    const meetingId = c.url.split("/").filter(Boolean).pop() || c.url;
    const { error } = await supabase.from("video_conferences").insert({
      course_id: courseId,
      title: c.title || "Synchronous Session",
      description: c.intro,
      meeting_id: meetingId,
      meeting_url: c.url,
      google_meet_link: c.url,
      video_provider: "google_meet",
      status: "ended", // these sessions already happened
    });
    if (!error) count++;
  }
  return count;
}

/** Import forum threads as course discussions + replies, attributing authors. */
async function importForums(
  supabase: SupabaseClient,
  courseId: string,
  archive: Parameters<typeof parseEnrolledUsers>[0],
  repPeople: EnrolledUser[]
): Promise<{ discussions: number; replies: number }> {
  const emailByMoodle = new Map(
    repPeople.filter((p) => p.email).map((p) => [p.moodleId, p.email])
  );
  const userByEmail = new Map<string, string | null>();
  async function resolveAuthor(moodleId: string): Promise<string | null> {
    const email = emailByMoodle.get(moodleId);
    if (!email) return null;
    if (userByEmail.has(email)) return userByEmail.get(email)!;
    const { data } = await supabase.from("users").select("id").eq("email", email).maybeSingle();
    const id = (data?.id as string) ?? null;
    userByEmail.set(email, id);
    return id;
  }

  let discussions = 0;
  let replies = 0;
  for (const forum of parseForums(archive)) {
    for (const d of forum.discussions) {
      if (d.posts.length === 0) continue;
      const [opening, ...rest] = d.posts;
      const { data: disc, error } = await supabase
        .from("course_discussions")
        .insert({
          course_id: courseId,
          title: d.title || forum.name || "Discussion",
          content: opening.message,
          author_id: await resolveAuthor(opening.moodleUserId),
        })
        .select("id")
        .single();
      if (error || !disc) continue;
      discussions++;
      for (const p of rest) {
        const { error: rErr } = await supabase.from("discussion_replies").insert({
          discussion_id: disc.id,
          author_id: await resolveAuthor(p.moodleUserId),
          content: p.message,
        });
        if (!rErr) replies++;
      }
    }
  }
  return { discussions, replies };
}

export async function importCourseGroup(
  supabase: SupabaseClient,
  group: CourseGroup,
  loadArchive: (shortname: string) => MoodleArchive
): Promise<GroupImportResult> {
  // Content once, from the first facilitator's copy (copies share a syllabus).
  const rep = group.backups[0];
  const repArchive = loadArchive(rep.shortname);
  const content = await importBackupToSupabase(repArchive, supabase);
  const courseId = content.courseId;

  // The course is the shared topic — not "<topic> - <facilitator>", which is
  // the representative copy's name. The facilitator lives on the class.
  await supabase.from("courses").update({ title: group.topic }).eq("id", courseId);

  // Synchronous sessions (no author dependency).
  const conferences = await importConferences(supabase, courseId, repArchive);

  const classes: ClassImportResult[] = [];
  let gradeItemId: string | undefined;
  let repPeople: EnrolledUser[] = [];

  for (const backup of group.backups) {
    const archive = backup.shortname === rep.shortname ? repArchive : loadArchive(backup.shortname);
    const people = await parseEnrolledUsers(archive);
    if (backup.shortname === rep.shortname) repPeople = people;
    const gb = archive.readText("gradebook.xml");
    const finalGrades = gb ? parseFinalGrades(gb) : new Map();

    // Create the course's single "Final Grade" column the first time a
    // facilitator's copy actually has grades.
    if (finalGrades.size > 0 && !gradeItemId) {
      const gradeMax = [...finalGrades.values()][0].gradeMax;
      const { data: gi, error: giErr } = await supabase
        .from("course_grade_items")
        .insert({
          course_id: courseId,
          title: "Final Grade",
          type: "other",
          category: "Final Grade",
          points: Math.round(gradeMax) || 100,
          is_active: true,
        })
        .select("id")
        .single();
      if (giErr) throw new Error(`grade item insert failed: ${giErr.message}`);
      gradeItemId = gi?.id as string | undefined;
    }

    const summary = await importPeopleForCourse(
      supabase,
      courseId,
      backup.facilitator || backup.shortname,
      people,
      { finalGrades, gradeItemId }
    );
    classes.push({
      facilitator: backup.facilitator,
      usersCreated: summary.usersCreated,
      usersExisting: summary.usersExisting,
      enrollments: summary.enrollments,
      instructors: summary.instructors,
      grades: summary.grades,
    });
  }

  // Forum threads (authors resolved via the representative copy's people).
  const forum = await importForums(supabase, courseId, repArchive, repPeople);

  return {
    topic: group.topic,
    courseId,
    classes,
    conferences,
    discussions: forum.discussions,
    replies: forum.replies,
  };
}
