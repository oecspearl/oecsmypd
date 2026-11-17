import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { importCourseGroup } from "./batch-import";

const LOCAL_URL = "http://127.0.0.1:54421";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const backupsDir = fileURLToPath(new URL("../../MOODLESCRAPER/moodle_backups/", import.meta.url));
function loadArchive(shortname: string): MoodleArchive {
  const file = readdirSync(backupsDir).find(
    (f) => f.startsWith(`${shortname}__`) && f.endsWith(".mbz")
  );
  if (!file) throw new Error(`no backup for ${shortname}`);
  return new MoodleArchive(readFileSync(join(backupsDir, file)));
}

const suite = process.env.RUN_IMPORT ? describe : describe.skip;

suite("conferences + forums tail", () => {
  test("imports SQLJR's Google Meet session and forum threads with authors", async () => {
    const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    const group = {
      topic: `Tails Test ${Date.now()}`,
      backups: [{ shortname: "SQLJR", fullname: "x - Janelle Ross", facilitator: "Janelle Ross" }],
    };

    const result = await importCourseGroup(supabase, group, loadArchive);
    console.log("Tails:", {
      conferences: result.conferences,
      discussions: result.discussions,
      replies: result.replies,
      linksRemapped: result.linksRemapped,
    });

    expect(result.conferences).toBeGreaterThanOrEqual(1);
    expect(result.discussions).toBeGreaterThanOrEqual(1);

    // Conference carries the real Google Meet link.
    const { data: conf } = await supabase
      .from("video_conferences")
      .select("title, meeting_url, video_provider")
      .eq("course_id", result.courseId)
      .limit(1)
      .single();
    expect(conf?.video_provider).toBe("google_meet");
    expect(conf?.meeting_url).toContain("meet.google.com");

    // Discussions exist with content, and at least one post is attributed to a real account.
    const { data: discs } = await supabase
      .from("course_discussions")
      .select("content, author_id")
      .eq("course_id", result.courseId);
    expect((discs ?? []).length).toBeGreaterThanOrEqual(1);
    expect(discs?.some((d) => d.author_id)).toBe(true);

    // No lesson still links into the dead Moodle; remapped links point at MyPD.
    const { data: lessons } = await supabase
      .from("lessons")
      .select("content")
      .eq("course_id", result.courseId);
    const allContent = JSON.stringify(lessons ?? []);
    expect(allContent).not.toContain("new-moodle.oecs.org");
    if (result.linksRemapped > 0) {
      expect(allContent).toContain(`/course/${result.courseId}`);
    }
  }, 180000);
});
