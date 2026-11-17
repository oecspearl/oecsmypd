import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MoodleArchive } from "./archive";
import { buildCourseFromArchive } from "./build";

const archive = new MoodleArchive(
  readFileSync(new URL("./__fixtures__/ssezl.mbz", import.meta.url))
);
const sqljr = new MoodleArchive(
  readFileSync(new URL("./__fixtures__/sqljr.mbz", import.meta.url))
);
const resolveFileUrl = (p: string) => `https://cdn.test/${p}`;

describe("buildCourseFromArchive", () => {
  test("assembles the full SSEZL course from a real .mbz", async () => {
    const course = await buildCourseFromArchive(archive, { resolveFileUrl });

    expect(course.shortname).toBe("SSEZL");
    expect(course.title).toBe(
      "Supporting Social and Emotional Well-being in Young Children - Zephirina Lansiquot"
    );

    // All eight sections, ordered by number.
    expect(course.sections).toHaveLength(8);
    expect(course.sections.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // The Welcome section (0) holds the H5P overview, converted to a native interactive.
    const welcome = course.sections[0];
    expect(welcome.title).toBe("Welcome");
    expect(welcome.lessons[0].kind).toBe("interactive");
    expect(welcome.lessons[0].interactive?.type).toBe("image-hotspot");
    expect(welcome.lessons[0].interactive?.data.hotspots).toHaveLength(8);

    // The assignment survives with its full brief (the legacy importer's worst failure).
    const allLessons = course.sections.flatMap((s) => s.lessons);
    const alp1 = allLessons.find((l) => l.title === "Applied Learning Product 1");
    expect(alp1?.kind).toBe("assignment");
    expect(alp1?.assignment?.description).toContain(
      "Observation of child-to-child interactions"
    );
    expect(alp1?.assignment?.maxPoints).toBe(100);

    // A page came through as real HTML content.
    const outline = allLessons.find((l) => l.title === "Module Outline");
    expect(outline?.kind).toBe("page");
    expect(outline?.html).toContain("docs.google.com");

    // Every lesson has a stable moduleId and an order.
    for (const lesson of allLessons) {
      expect(lesson.moduleId).toMatch(/^\d+$/);
      expect(typeof lesson.order).toBe("number");
    }
  });

  test("extracts folder file collections from SQLJR", async () => {
    const course = await buildCourseFromArchive(sqljr, { resolveFileUrl });
    const folders = course.sections
      .flatMap((s) => s.lessons)
      .filter((l) => l.kind === "folder");

    // All eight folders, 52 content files in total.
    expect(folders).toHaveLength(8);
    const totalFiles = folders.reduce((n, f) => n + (f.files?.length ?? 0), 0);
    expect(totalFiles).toBe(52);

    // The "Resources" folder carries its 8 files, each with a resolved URL.
    const resources = folders.find((f) => f.title === "Resources");
    expect(resources?.files).toHaveLength(8);
    expect(resources?.files?.some((f) => f.name.endsWith(".xlsx"))).toBe(true);
    expect(resources?.files?.[0].url).toContain("https://cdn.test/");
  });
});
