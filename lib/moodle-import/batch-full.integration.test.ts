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

suite("full catalog migration", () => {
  test(
    "imports all topic groups into the clean staging catalog",
    async () => {
      const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
        auth: { persistSession: false },
      });

      const groups = groupBackupsByTopic(courseNames);
      const failures: Array<{ topic: string; error: string }> = [];
      let okGroups = 0;

      for (const group of groups) {
        try {
          const r = await importCourseGroup(supabase, group, loadArchive);
          okGroups++;
          console.log(`[ok] ${r.topic}  (${r.classes.length} classes)`);
        } catch (e) {
          failures.push({ topic: group.topic, error: e instanceof Error ? e.message : String(e) });
          console.error(`[FAIL] ${group.topic}: ${e instanceof Error ? e.message : e}`);
        }
      }

      // Catalog counts from the DB.
      const counts: Record<string, number | null> = {};
      for (const t of ["courses", "classes", "enrollments", "course_instructors"]) {
        const { count } = await supabase.from(t).select("*", { count: "exact", head: true });
        counts[t] = count;
      }
      const { count: userCount } = await supabase
        .from("users")
        .select("*", { count: "exact", head: true });
      console.log("CATALOG:", { okGroups, failures: failures.length, ...counts, users: userCount });

      // Most groups import; the catalog collapses to one course per topic.
      expect(okGroups).toBeGreaterThanOrEqual(25);
      expect(counts.courses).toBeGreaterThanOrEqual(25);
      expect(counts.courses).toBeLessThanOrEqual(groups.length);
      // One class per facilitator backup (~98).
      expect(counts.classes).toBeGreaterThanOrEqual(90);
      // Distinct learners across the whole migration.
      expect(userCount).toBeGreaterThan(1500);
      expect(counts.enrollments).toBeGreaterThan(3000);
    },
    2400000
  );
});
