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
import { parseEnrolledUsers } from "./people-parser";
import { importPeopleForCourse } from "./people-import";

export interface ClassImportResult {
  facilitator: string;
  usersCreated: number;
  usersExisting: number;
  enrollments: number;
  instructors: number;
}

export interface GroupImportResult {
  topic: string;
  courseId: string;
  classes: ClassImportResult[];
}

export async function importCourseGroup(
  supabase: SupabaseClient,
  group: CourseGroup,
  loadArchive: (shortname: string) => MoodleArchive
): Promise<GroupImportResult> {
  // Content once, from the first facilitator's copy (copies share a syllabus).
  const rep = group.backups[0];
  const content = await importBackupToSupabase(loadArchive(rep.shortname), supabase);
  const courseId = content.courseId;

  // The course is the shared topic — not "<topic> - <facilitator>", which is
  // the representative copy's name. The facilitator lives on the class.
  await supabase.from("courses").update({ title: group.topic }).eq("id", courseId);

  const classes: ClassImportResult[] = [];
  for (const backup of group.backups) {
    const people = await parseEnrolledUsers(loadArchive(backup.shortname));
    const summary = await importPeopleForCourse(
      supabase,
      courseId,
      backup.facilitator || backup.shortname,
      people
    );
    classes.push({
      facilitator: backup.facilitator,
      usersCreated: summary.usersCreated,
      usersExisting: summary.usersExisting,
      enrollments: summary.enrollments,
      instructors: summary.instructors,
    });
  }

  return { topic: group.topic, courseId, classes };
}
