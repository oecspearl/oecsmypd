import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { MoodleArchive } from "./archive";
import { parseEnrolledUsers } from "./people-parser";
import { importPeopleForCourse } from "./people-import";

const LOCAL_URL = "http://127.0.0.1:54421";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const suite = process.env.RUN_IMPORT ? describe : describe.skip;

suite("people migration into staging", () => {
  test(
    "provisions accounts and enrollments for SSEZL's people",
    async () => {
      const supabase = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
        auth: { persistSession: false },
      });
      const archive = new MoodleArchive(
        readFileSync(new URL("./__fixtures__/ssezl.mbz", import.meta.url))
      );
      const people = await parseEnrolledUsers(archive);
      expect(people.length).toBe(48);

      // A fresh course to attach the facilitator's class to.
      const { data: course } = await supabase
        .from("courses")
        .insert({ title: `People Test ${Date.now()}`, difficulty: "beginner", published: false })
        .select("id")
        .single();

      const summary = await importPeopleForCourse(
        supabase,
        course!.id,
        "Zephirina Lansiquot",
        people
      );
      console.log("People summary:", summary);

      // Every person with an email has an account (created now or already there).
      const withEmail = people.filter((p) => p.email.includes("@")).length;
      expect(summary.usersCreated + summary.usersExisting).toBe(withEmail);
      expect(withEmail).toBeGreaterThan(40);

      // One facilitator class; facilitators recorded; learners enrolled.
      expect(summary.classesCreated).toBe(1);
      expect(summary.instructors).toBeGreaterThanOrEqual(1);
      expect(summary.enrollments).toBeGreaterThan(38);

      // Verify in the database.
      const { count: enrollCount } = await supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("course_id", course!.id)
        .eq("status", "active");
      expect(enrollCount).toBe(summary.enrollments);

      const { count: instrCount } = await supabase
        .from("course_instructors")
        .select("*", { count: "exact", head: true })
        .eq("course_id", course!.id);
      expect(instrCount).toBe(summary.instructors);

      // A real account is backed by a public.users row with the right role.
      const sampleStudent = people.find((p) => p.role === "student" && p.email.includes("@"))!;
      const { data: u } = await supabase
        .from("users")
        .select("role")
        .eq("email", sampleStudent.email)
        .maybeSingle();
      expect(u?.role).toBe("student");
    },
    180000
  );
});
