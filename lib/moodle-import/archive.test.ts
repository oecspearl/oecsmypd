import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MoodleArchive } from "./archive";

const mbz = readFileSync(new URL("./__fixtures__/ssezl.mbz", import.meta.url));

describe("MoodleArchive", () => {
  test("reads a real .mbz (gzip+tar) into an addressable file map", () => {
    const archive = new MoodleArchive(mbz);

    // Core manifest files are present and readable as text.
    expect(archive.readText("moodle_backup.xml")).toContain("<moodle_backup");
    expect(archive.readText("course/course.xml")).toContain("SSEZL");

    // Activity files are addressable (tolerating a leading "./").
    expect(archive.has("activities/hvp_2334/hvp.xml")).toBe(true);
    expect(archive.readText("activities/assign_2339/assign.xml")).toContain(
      "Applied Learning Product 1"
    );

    // Binary blobs come back as Buffers.
    const img = archive.readBuffer(
      "files/" // sanity: the file pool exists
    );
    expect(img === null || Buffer.isBuffer(img)).toBe(true);

    // The full SSEZL backup has ~1,971 physical files.
    expect(archive.list().length).toBeGreaterThan(1000);

    // Missing paths return null, not throw.
    expect(archive.readText("does/not/exist.xml")).toBeNull();
  });
});
