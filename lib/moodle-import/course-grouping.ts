/**
 * Groups Moodle course backups by topic so per-facilitator copies collapse into
 * one MyPD course + a class per facilitator.
 *
 * OECS course names follow "<Topic> - <Facilitator>" (e.g. "Foundations of
 * Quality Education - Aldia Gumbs-Dyer"). The topic is everything before the
 * first " - "; the facilitator is the remainder. Courses with no " - " suffix
 * (e.g. "Digital Marketing 01") are standalone groups of one.
 */

export interface BackupRef {
  shortname: string;
  fullname: string;
  /** The facilitator (text after " - "), or "" for standalone courses. */
  facilitator: string;
}

export interface CourseGroup {
  topic: string;
  backups: BackupRef[];
}

export function groupBackupsByTopic(
  courses: Array<{ shortname: string; fullname: string }>
): CourseGroup[] {
  const groups = new Map<string, CourseGroup>();

  for (const c of courses) {
    const parts = c.fullname.split(" - ");
    const topic = parts[0].trim();
    const facilitator = parts.length > 1 ? parts.slice(1).join(" - ").trim() : "";

    let group = groups.get(topic);
    if (!group) {
      group = { topic, backups: [] };
      groups.set(topic, group);
    }
    group.backups.push({ shortname: c.shortname, fullname: c.fullname, facilitator });
  }

  return [...groups.values()];
}
