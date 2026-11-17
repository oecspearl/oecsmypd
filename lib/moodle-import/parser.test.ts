import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseBackupIndex,
  parseCourse,
  parseAssignment,
  parsePage,
  parseSection,
} from "./parser";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/ssezl/${name}`, import.meta.url), "utf8");
}

describe("parseBackupIndex", () => {
  test("reads the course name, activities and sections from moodle_backup.xml", async () => {
    const index = await parseBackupIndex(fixture("moodle_backup.xml"));

    expect(index.fullname).toBe(
      "Supporting Social and Emotional Well-being in Young Children - Zephirina Lansiquot"
    );

    // Every activity and section in the backup is indexed.
    expect(index.activities).toHaveLength(10);
    expect(index.sections).toHaveLength(8);

    // The first activity is the H5P overview, with its on-disk directory.
    expect(index.activities[0]).toEqual({
      moduleid: "2334",
      sectionid: "721",
      modulename: "hvp",
      title: "Module 13 Overview",
      directory: "activities/hvp_2334",
    });

    // The first section carries its title and directory for later parsing.
    expect(index.sections[0]).toEqual({
      sectionid: "721",
      title: "Welcome",
      directory: "sections/section_721",
    });
  });
});

describe("parseCourse", () => {
  test("reads course metadata and decodes the HTML summary from course.xml", async () => {
    const course = await parseCourse(fixture("course.xml"));

    expect(course.moodleId).toBe("96");
    expect(course.shortname).toBe("SSEZL");
    expect(course.title).toBe(
      "Supporting Social and Emotional Well-being in Young Children - Zephirina Lansiquot"
    );

    // The summary is stored HTML-escaped in the backup; MyPD wants real HTML.
    expect(course.description).toContain("evidence-based practices");
    expect(course.description).toContain("<p");
    expect(course.description).not.toContain("&lt;");
  });
});

describe("parseAssignment", () => {
  test("extracts the full assignment brief that the legacy importer dropped", async () => {
    const assignment = await parseAssignment(fixture("activities/assign_2339.xml"));

    expect(assignment.moduleId).toBe("2339");
    expect(assignment.title).toBe("Applied Learning Product 1");

    // The brief is real, rich HTML — not the empty 129-byte stub the old importer produced.
    expect(assignment.description).toContain("Observation of child-to-child interactions");
    expect(assignment.description).toContain("Targeted Outcome");
    expect(assignment.description).toContain("<p>");
    expect(assignment.description.length).toBeGreaterThan(200);

    // duedate 0 means "no due date"; grade 100 is the max points.
    expect(assignment.dueDate).toBeNull();
    expect(assignment.maxPoints).toBe(100);
  });
});

describe("parsePage", () => {
  test("extracts page content, rewrites @@PLUGINFILE@@ refs, and keeps embeds", async () => {
    const page = await parsePage(fixture("activities/page_2336.xml"), {
      resolveFileUrl: (filename) => `https://cdn.test/${filename}`,
    });

    expect(page.moduleId).toBe("2336");
    expect(page.title).toBe("Module Outline");

    // The Moodle file placeholder is replaced with a resolved, decoded URL.
    expect(page.content).not.toContain("@@PLUGINFILE@@");
    expect(page.content).toContain("https://cdn.test/Module 13 Banner.png");

    // Real HTML, with external embeds (the Google Doc iframe) preserved.
    expect(page.content).toContain("<p>");
    expect(page.content).toContain("docs.google.com");
  });
});

describe("parseSection", () => {
  test("reads a section's number, title and ordered activity sequence", async () => {
    const section = await parseSection(fixture("sections/section_722.xml"), {
      resolveFileUrl: (filename) => `https://cdn.test/${filename}`,
    });

    expect(section.number).toBe(1);
    expect(section.title).toBe("Introduction");
    // The sequence is the ordered list of course-module ids in the section.
    expect(section.sequence).toEqual(["2335", "2336", "2343"]);
    expect(typeof section.summary).toBe("string");
  });
});
