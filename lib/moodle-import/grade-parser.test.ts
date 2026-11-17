import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFinalGrades } from "./grade-parser";

const xml = readFileSync(
  new URL("./__fixtures__/gradebook-cssikks.xml", import.meta.url),
  "utf8"
);

describe("parseFinalGrades", () => {
  test("extracts each learner's course-level final grade", () => {
    const grades = parseFinalGrades(xml);

    // CSSIKKS has ~15 graded learners on a 0–4 scale.
    expect(grades.size).toBeGreaterThanOrEqual(14);

    // A known learner's final grade and the course max.
    expect(grades.get("1436")).toEqual({ finalGrade: 2, gradeMax: 4 });

    // Values are numeric and within range.
    for (const g of grades.values()) {
      expect(typeof g.finalGrade).toBe("number");
      expect(g.gradeMax).toBe(4);
      expect(g.finalGrade).toBeLessThanOrEqual(g.gradeMax);
    }
  });
});
