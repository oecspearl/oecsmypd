/**
 * Merge a Moodle topic's history (cohorts, enrollments, grades, completion,
 * conferences, forum threads) into an EXISTING MyPD course, without creating or
 * changing course content. Used for the one topic whose title already matched a
 * live course. Guarded by RUN_MERGE + env-supplied prod credentials and target.
 *
 *   RUN_MERGE=1 GOLIVE_SUPABASE_URL=... GOLIVE_SERVICE_KEY=... \
 *     MERGE_TOPIC="..." MERGE_COURSE_ID="..." \
 *     npx vitest run lib/moodle-import/merge-into-course.integration.test.ts
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { groupBackupsByTopic } from "./course-grouping";
import { importGroupIntoCourse } from "./batch-import";
import courseNames from "./__fixtures__/course-names.json";

const PROD_URL = process.env.GOLIVE_SUPABASE_URL ?? "";
const PROD_KEY = process.env.GOLIVE_SERVICE_KEY ?? "";
const TOPIC = process.env.MERGE_TOPIC ?? "";
const COURSE_ID = process.env.MERGE_COURSE_ID ?? "";

const backupsDir = fileURLToPath(new URL("../../MOODLESCRAPER/moodle_backups/", import.meta.url));
function loadArchive(shortname: string): MoodleArchive {
  const file = readdirSync(backupsDir).find(
    (f) => f.startsWith(`${shortname}__`) && f.endsWith(".mbz")
  );
  if (!file) throw new Error(`no backup found for ${shortname}`);
  return new MoodleArchive(readFileSync(join(backupsDir, file)));
}

const enabled =
  process.env.RUN_MERGE === "1" && !!PROD_URL && !!PROD_KEY && !!TOPIC && !!COURSE_ID;
const suite = enabled ? describe : describe.skip;

suite("merge Moodle history into existing course", () => {
  test(
    "adds cohorts/enrollments/tails to the live course, content untouched",
    async () => {
      const supabase = createClient(PROD_URL, PROD_KEY, { auth: { persistSession: false } });

      const group = groupBackupsByTopic(courseNames).find((g) => g.topic === TOPIC);
      if (!group) throw new Error(`no backup group for topic ${JSON.stringify(TOPIC)}`);

      const lessonsBefore = (
        await supabase.from("lessons").select("*", { count: "exact", head: true }).eq("course_id", COURSE_ID)
      ).count;

      const result = await importGroupIntoCourse(supabase, COURSE_ID, group, loadArchive);
      console.log("MERGE:", { topic: TOPIC, courseId: COURSE_ID, ...result });

      const after = async (t: string) =>
        (await supabase.from(t).select("*", { count: "exact", head: true }).eq("course_id", COURSE_ID)).count;
      const lessonsAfter = await after("lessons");
      console.log("AFTER:", {
        classes: await after("classes"),
        enrollments: await after("enrollments"),
        conferences: await after("video_conferences"),
        discussions: await after("course_discussions"),
        lessonsBefore,
        lessonsAfter,
      });

      // Cohorts/enrollments were added.
      expect(result.classes.length).toBeGreaterThanOrEqual(1);
      // Content was NOT touched.
      expect(lessonsAfter).toBe(lessonsBefore);
    },
    600000
  );
});
