/**
 * Rewrites dead internal Moodle links in imported content to their MyPD
 * destinations. The old platform (new-moodle.oecs.org) is gone, so any link
 * into it is dead; we point section/week links at the matching MyPD lesson and
 * everything else (googlemeet, generic) at the course page. External links
 * (Google Docs, etc.) are left untouched.
 */

export interface RemapMaps {
  /** /course/<id> — the fallback for anything we can't resolve precisely. */
  coursePath: string;
  /** Moodle section number -> that subject's first MyPD lesson URL. */
  lessonUrlBySectionNumber: Map<number, string>;
  /** Moodle section id -> section number (from the backup's section.xml). */
  sectionIdToNumber: Map<string, number>;
}

const MOODLE_HOST = "new-moodle.oecs.org";

export function remapContentLinks(content: string, maps: RemapMaps): string {
  const { coursePath, lessonUrlBySectionNumber, sectionIdToNumber } = maps;
  const lessonForNumber = (n: number) => lessonUrlBySectionNumber.get(n) ?? coursePath;

  return (
    content
      // course/view.php?id=<course>&section=<N>  (& may be HTML-escaped)
      .replace(
        new RegExp(
          `https?://${MOODLE_HOST}/course/view\\.php\\?id=\\d+(?:&|&amp;)section=(\\d+)`,
          "g"
        ),
        (_m, n: string) => lessonForNumber(Number(n))
      )
      // course/section.php?id=<sectionId>
      .replace(
        new RegExp(`https?://${MOODLE_HOST}/course/section\\.php\\?id=(\\d+)`, "g"),
        (_m, sid: string) => {
          const n = sectionIdToNumber.get(sid);
          return n != null ? lessonForNumber(n) : coursePath;
        }
      )
      // everything else that still points into the dead Moodle -> course page
      .replace(new RegExp(`https?://${MOODLE_HOST}/[^\\s"'<>\\\\)]*`, "g"), coursePath)
  );
}
