import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { groupBackupsByTopic } from "./course-grouping";
import { importCourseGroup } from "./batch-import";
import courseNames from "./__fixtures__/course-names.json";

const LOCAL_URL = "http://127.0.0.1:54421";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const backupsDir = fileURLToPath(new URL("../../MOODLESCRAPER/moodle_backups/", import.meta.url));
function loadArchive(shortname: string): MoodleArchive {
  const file = readdirSync(backupsDir).find(
    (f) => f.startsWith(`${shortname}__`) && f.endsWith(".mbz")
  );
  if (!file) throw new Error(`no backup found for ${shortname}`);
  return new MoodleArchive(readFileSync(join(backupsDir, file)));
}

const suite = process.env.RUN_IMPORT ? describe : describe.skip;

suite("dedup: import a topic group into one course + classes", () => {
  test(
    "a two-facilitator course becomes one course with two classes",
    async () => {
      const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
        auth: { persistSession: false },
      });

      const groups = groupBackupsByTopic(courseNames);
      const group = groups.find((g) => g.topic === "Continuous School and System Improvement")!;
      expect(group.backups).toHaveLength(2);

      const result = await importCourseGroup(supabase, group, loadArchive);
      console.log("Group import:", JSON.stringify(result, null, 2));

      // One course, one class per facilitator.
      expect(result.classes).toHaveLength(2);
      const facilitators = result.classes.map((c) => c.facilitator).sort();
      expect(facilitators).toEqual(["Kendra King-Snagg", "Stacey Mascall"]);

      // Exactly one course row and two class rows in the DB.
      const { data: courseRow } = await supabase
        .from("courses")
        .select("title")
        .eq("id", result.courseId)
        .single();
      // The course is the clean topic, not "<topic> - <facilitator>".
      expect(courseRow?.title).toBe("Continuous School and System Improvement");

      const { count: classCount } = await supabase
        .from("classes")
        .select("*", { count: "exact", head: true })
        .eq("course_id", result.courseId);
      expect(classCount).toBe(2);

      // Learners enrolled under the shared course across both classes.
      const { count: enrollCount } = await supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("course_id", result.courseId);
      expect(enrollCount).toBeGreaterThan(0);

      // Final grades: one "Final Grade" column, with per-learner grades.
      const { count: itemCount } = await supabase
        .from("course_grade_items")
        .select("*", { count: "exact", head: true })
        .eq("course_id", result.courseId);
      expect(itemCount).toBe(1);

      const { count: gradeCount } = await supabase
        .from("course_grades")
        .select("*", { count: "exact", head: true })
        .eq("course_id", result.courseId);
      expect(gradeCount).toBeGreaterThan(10);
      expect(result.classes.reduce((n, c) => n + c.grades, 0)).toBe(gradeCount);
    },
    180000
  );
});
