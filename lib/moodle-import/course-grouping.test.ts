import { describe, test, expect } from "vitest";
import { groupBackupsByTopic } from "./course-grouping";
import courseNames from "./__fixtures__/course-names.json";

describe("groupBackupsByTopic", () => {
  test("collapses per-facilitator course copies into one group per topic", () => {
    const groups = groupBackupsByTopic(courseNames);

    // 98 backups collapse to 27 distinct courses.
    expect(groups).toHaveLength(27);

    // The big multi-facilitator courses gather all their copies.
    const foqe = groups.find((g) => g.topic === "Foundations of Quality Education");
    expect(foqe?.backups).toHaveLength(21);
    // Each copy carries its facilitator (the part after " - ").
    expect(foqe?.backups.every((b) => b.facilitator.length > 0)).toBe(true);

    // A standalone course is its own group with no facilitator suffix.
    const dm = groups.find((g) => g.topic === "Digital Marketing 01");
    expect(dm?.backups).toHaveLength(1);
    expect(dm?.backups[0].facilitator).toBe("");

    // An "Introduction to…" variant stays a separate course, not merged in.
    expect(groups.some((g) => g.topic === "Introduction to Foundations of Quality Education")).toBe(
      true
    );

    // Every backup lands in exactly one group.
    const total = groups.reduce((n, g) => n + g.backups.length, 0);
    expect(total).toBe(courseNames.length);
  });
});
