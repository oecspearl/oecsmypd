import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MoodleArchive } from "./archive";
import { parseEnrolledUsers } from "./people-parser";

const archive = new MoodleArchive(
  readFileSync(new URL("./__fixtures__/ssezl.mbz", import.meta.url))
);

describe("parseEnrolledUsers", () => {
  test("extracts enrolled people with names, emails and mapped roles", async () => {
    const users = await parseEnrolledUsers(archive);

    // SSEZL has 48 people with a role in the course.
    expect(users.length).toBe(48);

    // Roles map from Moodle: Manager/Teacher -> instructor, Student -> student.
    const instructors = users.filter((u) => u.role === "instructor");
    const students = users.filter((u) => u.role === "student");
    expect(instructors.length).toBe(4);
    expect(students.length).toBe(44);

    // Every person carries a stable Moodle id and name fields.
    for (const u of users) {
      expect(u.moodleId).toMatch(/^\d+$/);
      expect(typeof u.firstName).toBe("string");
      expect(typeof u.email).toBe("string");
    }

    // The vast majority have real emails (the key to account creation + dedup).
    const withEmail = users.filter((u) => u.email.includes("@"));
    expect(withEmail.length).toBeGreaterThan(40);
  });
});
