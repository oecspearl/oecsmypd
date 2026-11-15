/**
 * Extracts course-level final grades from a Moodle backup's gradebook.xml.
 *
 * These PD courses graded at the course total (not per activity), so we read
 * the single `itemtype=course` grade item and each learner's finalgrade, keyed
 * by Moodle user id.
 */

export interface FinalGrade {
  finalGrade: number;
  gradeMax: number;
}

export function parseFinalGrades(xml: string): Map<string, FinalGrade> {
  const result = new Map<string, FinalGrade>();

  // The course total grade item.
  const courseItem = [...xml.matchAll(/<grade_item\b[\s\S]*?<\/grade_item>/g)]
    .map((m) => m[0])
    .find((block) => /<itemtype>course<\/itemtype>/.test(block));
  if (!courseItem) return result;

  const gradeMax = Number(/<grademax>([\d.]+)<\/grademax>/.exec(courseItem)?.[1] ?? "0");

  for (const gg of courseItem.matchAll(/<grade_grade\b[\s\S]*?<\/grade_grade>/g)) {
    const block = gg[0];
    const userId = /<userid>(\d+)<\/userid>/.exec(block)?.[1];
    const raw = /<finalgrade>([\s\S]*?)<\/finalgrade>/.exec(block)?.[1]?.trim();
    if (!userId || !raw || raw === "$@NULL@$") continue;
    const finalGrade = Number(raw);
    if (!Number.isFinite(finalGrade)) continue;
    result.set(userId, { finalGrade, gradeMax });
  }

  return result;
}
