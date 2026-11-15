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
import { parseFinalGrades } from "./grade-parser";

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
  let gradeItemId: string | undefined;

  for (const backup of group.backups) {
    const archive = loadArchive(backup.shortname);
    const people = await parseEnrolledUsers(archive);
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

  return { topic: group.topic, courseId, classes };
}
