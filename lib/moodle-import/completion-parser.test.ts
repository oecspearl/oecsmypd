import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MoodleArchive } from "./archive";
import { parseCompletions } from "./completion-parser";

const sqljr = new MoodleArchive(
  readFileSync(new URL("./__fixtures__/sqljr.mbz", import.meta.url))
);

describe("parseCompletions", () => {
  test("reads per-user activity completion from the backup", () => {
    const c = parseCompletions(sqljr);

    // Some activities track completion.
    expect(c.trackedActivities).toBeGreaterThan(0);
    // Real learners have completion records.
    expect(c.byUser.size).toBeGreaterThan(0);

    // Every recorded user completed between 1 and all tracked activities,
    // with a real timestamp.
    for (const v of c.byUser.values()) {
      expect(v.completed).toBeGreaterThanOrEqual(1);
      expect(v.completed).toBeLessThanOrEqual(c.trackedActivities);
      expect(v.lastAt).toBeGreaterThan(0);
    }

    // Completion is NOT uniform — not everyone finished every activity.
    const anyPartial = [...c.byUser.values()].some((v) => v.completed < c.trackedActivities);
    expect(anyPartial).toBe(true);
  });
});
