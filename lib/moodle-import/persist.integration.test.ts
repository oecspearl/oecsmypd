import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { importBackupToSupabase } from "./persist";

// Standard Supabase local-dev credentials (public, not secrets).
const LOCAL_URL = "http://127.0.0.1:54421";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// Only runs when RUN_IMPORT=1 (it writes to the local staging DB).
const suite = process.env.RUN_IMPORT ? describe : describe.skip;

suite("SSEZL import into staging", () => {
  test(
    "imports the full course and verifies it in the database",
    async () => {
      const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
        auth: { persistSession: false },
      });
      const archive = new MoodleArchive(
        readFileSync(new URL("./__fixtures__/ssezl.mbz", import.meta.url))
      );

      const summary = await importBackupToSupabase(archive, supabase);
      console.log("Import summary:", summary);

      expect(summary.subjects).toBe(8);
      expect(summary.lessons).toBeGreaterThanOrEqual(8);
      expect(summary.interactives).toBeGreaterThanOrEqual(1);
      expect(summary.assignments).toBeGreaterThanOrEqual(1);
      expect(summary.filesUploaded).toBeGreaterThan(0);

      // Verify course row.
      const { data: course } = await supabase
        .from("courses")
        .select("title, published")
        .eq("id", summary.courseId)
        .single();
      expect(course?.title).toContain("Supporting Social and Emotional");
      expect(course?.published).toBe(false);

      // Verify 8 subjects.
      const { count: subjCount } = await supabase
        .from("subjects")
        .select("*", { count: "exact", head: true })
        .eq("course_id", summary.courseId);
      expect(subjCount).toBe(8);

      // Verify the assignment brief survived (the legacy importer's worst failure).
      const { data: assignments } = await supabase
        .from("assignments")
        .select("title, description, points")
        .eq("course_id", summary.courseId);
      expect(assignments?.some((a) => a.description?.includes("Observation of child"))).toBe(true);

      // Verify an interactive lesson carries 8 hotspots in its content block.
      const { data: lessons } = await supabase
        .from("lessons")
        .select("content, content_type")
        .eq("course_id", summary.courseId)
        .eq("content_type", "interactive");
      const interactive = lessons?.[0]?.content?.[0];
      expect(interactive?.type).toBe("interactive");
      expect(interactive?.data?.data?.hotspots?.length).toBe(8);
    },
    120000
  );
});
