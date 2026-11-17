/**
 * PRODUCTION go-live runner. Imports the full catalog into the live Supabase
 * project. Guarded by RUN_GOLIVE + explicit prod credentials passed through the
 * environment (never hardcoded). Courses are created unpublished (persist's
 * default); a topic whose course already exists is skipped, so a re-run after
 * an interruption won't duplicate the catalog.
 *
 * Run (PowerShell/bash sets GOLIVE_* from .env.local):
 *   RUN_GOLIVE=1 GOLIVE_SUPABASE_URL=... GOLIVE_SERVICE_KEY=... \
 *     npx vitest run lib/moodle-import/go-live.integration.test.ts
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { groupBackupsByTopic } from "./course-grouping";
import { importCourseGroup } from "./batch-import";
import courseNames from "./__fixtures__/course-names.json";

const PROD_URL = process.env.GOLIVE_SUPABASE_URL ?? "";
const PROD_KEY = process.env.GOLIVE_SERVICE_KEY ?? "";

const backupsDir = fileURLToPath(new URL("../../MOODLESCRAPER/moodle_backups/", import.meta.url));
function loadArchive(shortname: string): MoodleArchive {
  const file = readdirSync(backupsDir).find(
    (f) => f.startsWith(`${shortname}__`) && f.endsWith(".mbz")
  );
  if (!file) throw new Error(`no backup found for ${shortname}`);
  return new MoodleArchive(readFileSync(join(backupsDir, file)));
}

const enabled = process.env.RUN_GOLIVE === "1" && !!PROD_URL && !!PROD_KEY && !/127\.0\.0\.1|localhost/.test(PROD_URL);
const suite = enabled ? describe : describe.skip;

suite("PRODUCTION go-live", () => {
  test(
    "imports the full catalog into live Supabase (unpublished, idempotent per topic)",
    async () => {
      const supabase = createClient(PROD_URL, PROD_KEY, { auth: { persistSession: false } });

      // Baseline — so we can prove we only added.
      const { count: before } = await supabase
        .from("courses")
        .select("*", { count: "exact", head: true });
      console.log(`[baseline] courses before: ${before}`);

      const groups = groupBackupsByTopic(courseNames);
      const failures: Array<{ topic: string; error: string }> = [];
      let okGroups = 0;
      let skipped = 0;
      // Optional cap on how many NEW topics to import this pass (canary runs).
      const limit = process.env.GOLIVE_LIMIT ? Number(process.env.GOLIVE_LIMIT) : Infinity;

      for (const group of groups) {
        if (okGroups >= limit) {
          console.log(`[limit] reached ${limit} new topics; stopping this pass`);
          break;
        }
        // Skip topics already imported (safe re-run).
        const { data: existing } = await supabase
          .from("courses")
          .select("id")
          .eq("title", group.topic)
          .limit(1);
        if (existing && existing.length > 0) {
          skipped++;
          console.log(`[skip] ${group.topic} (already present)`);
          continue;
        }
        try {
          const r = await importCourseGroup(supabase, group, loadArchive);
          okGroups++;
          console.log(`[ok] ${r.topic} (${r.classes.length} classes, ${r.conferences} conf, ${r.discussions} disc)`);
        } catch (e) {
          failures.push({ topic: group.topic, error: e instanceof Error ? e.message : String(e) });
          console.error(`[FAIL] ${group.topic}: ${e instanceof Error ? e.message : e}`);
        }
      }

      const counts: Record<string, number | null> = {};
      for (const t of ["courses", "classes", "enrollments", "course_instructors", "video_conferences", "course_discussions"]) {
        const { count } = await supabase.from(t).select("*", { count: "exact", head: true });
        counts[t] = count;
      }
      const { count: users } = await supabase.from("users").select("*", { count: "exact", head: true });
      const { count: published } = await supabase
        .from("courses")
        .select("*", { count: "exact", head: true })
        .eq("published", true);
      console.log("GOLIVE:", { before, okGroups, skipped, failures: failures.length, published, users, ...counts });
      if (failures.length) console.log("FAILURES:", JSON.stringify(failures, null, 2));

      // Everything that ran must have succeeded.
      expect(failures.length).toBe(0);
      // Migrated courses are unpublished: published count unchanged from the 10 baseline.
      expect(published).toBe(10);
    },
    3000000
  );
});
