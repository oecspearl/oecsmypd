/**
 * Reads real per-user completion from a Moodle backup. Each activity carries a
 * completion.xml listing users and their completionstate (0 = not complete,
 * >=1 = complete). We count, per learner, how many completion-tracked
 * activities they finished and when they last did so — enough to derive a true
 * progress percentage and completion date instead of a blanket 100%.
 */

import type { MoodleArchive } from "./archive";

export interface CourseCompletion {
  /** Activities that actually track completion (the progress denominator). */
  trackedActivities: number;
  /** Per Moodle user id: completed activity count + latest completion time. */
  byUser: Map<string, { completed: number; lastAt: number }>;
}

export function parseCompletions(archive: MoodleArchive): CourseCompletion {
  const byUser = new Map<string, { completed: number; lastAt: number }>();
  let trackedActivities = 0;

  for (const path of archive.list()) {
    if (!/activities\/[^/]+\/completion\.xml$/.test(path)) continue;
    const xml = archive.readText(path);
    if (!xml) continue;

    const entries = xml.match(/<completion\b[\s\S]*?<\/completion>/g);
    if (!entries || entries.length === 0) continue; // activity doesn't track completion
    trackedActivities++;

    for (const block of entries) {
      const userid = /<userid>(\d+)<\/userid>/.exec(block)?.[1];
      const state = Number(/<completionstate>(\d+)<\/completionstate>/.exec(block)?.[1] ?? "0");
      if (!userid || state < 1) continue; // not completed
      const at = Number(/<timemodified>(\d+)<\/timemodified>/.exec(block)?.[1] ?? "0");
      const cur = byUser.get(userid) ?? { completed: 0, lastAt: 0 };
      cur.completed++;
      if (at > cur.lastAt) cur.lastAt = at;
      byUser.set(userid, cur);
    }
  }

  return { trackedActivities, byUser };
}
