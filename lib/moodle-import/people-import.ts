/**
 * Provisions MyPD accounts and enrollments for the people in one Moodle course
 * backup (one facilitator's instance → one class).
 *
 * - Accounts: a confirmed Supabase Auth user (no email sent) + a public.users
 *   row, deduped by email, idempotent across re-runs and across courses.
 * - Enrollment: students enrolled into the facilitator's class as `completed`
 *   (the Moodle courses have ended); facilitators recorded as course instructors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { EnrolledUser } from "./people-parser";
import type { FinalGrade } from "./grade-parser";
import type { CourseCompletion } from "./completion-parser";

export interface PeopleSummary {
  usersCreated: number;
  usersExisting: number;
  skippedNoEmail: number;
  classesCreated: number;
  enrollments: number;
  instructors: number;
  grades: number;
}

export interface PeopleOptions {
  /** Course-level final grades by Moodle user id, for this backup's class. */
  finalGrades?: Map<string, FinalGrade>;
  /** The course's "Final Grade" grade item to attach grades to. */
  gradeItemId?: string;
  /** Real per-user activity completion for this backup, for true progress. */
  completion?: CourseCompletion;
}

/**
 * Derive a learner's enrollment progress + completion date from real activity
 * completion. No tracking data (course never used completion) -> assume done.
 */
function completionFor(
  completion: CourseCompletion | undefined,
  moodleId: string,
  now: string
): { progress: number; completedAt: string | null } {
  if (!completion || completion.trackedActivities === 0) {
    return { progress: 100, completedAt: now };
  }
  const rec = completion.byUser.get(moodleId);
  const completed = rec?.completed ?? 0;
  const progress = Math.round((completed / completion.trackedActivities) * 100);
  const completedAt =
    progress >= 100 && rec?.lastAt ? new Date(rec.lastAt * 1000).toISOString() : null;
  return { progress, completedAt };
}

export async function importPeopleForCourse(
  supabase: SupabaseClient,
  courseId: string,
  className: string,
  people: EnrolledUser[],
  opts: PeopleOptions = {}
): Promise<PeopleSummary> {
  const idByEmail = new Map<string, string>();
  let usersCreated = 0;
  let usersExisting = 0;
  let skippedNoEmail = 0;

  // 1. Resolve or create one account per distinct email.
  for (const p of people) {
    if (!p.email) {
      skippedNoEmail++;
      continue;
    }
    if (idByEmail.has(p.email)) continue;

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", p.email)
      .maybeSingle();
    if (existing) {
      idByEmail.set(p.email, existing.id as string);
      usersExisting++;
      continue;
    }

    const name = `${p.firstName} ${p.lastName}`.trim() || p.email;
    const { data: created, error: authErr } = await supabase.auth.admin.createUser({
      email: p.email,
      email_confirm: true, // confirmed, but no email is sent
      password: `${randomUUID()}Aa1!`,
      user_metadata: { full_name: name },
    });
    if (authErr || !created?.user) continue; // e.g. already in auth; skip edge case

    const { error: uErr } = await supabase
      .from("users")
      .insert({ id: created.user.id, email: p.email, name, role: p.role });
    if (uErr) continue;

    idByEmail.set(p.email, created.user.id);
    usersCreated++;
  }

  // 2. The facilitator's class.
  const { data: cls, error: clsErr } = await supabase
    .from("classes")
    .insert({ course_id: courseId, name: className, active: true })
    .select("id")
    .single();
  if (clsErr || !cls) throw new Error(`class insert failed: ${clsErr?.message}`);
  const classId = cls.id as string;

  // 3. Enroll students; record instructors.
  let enrollments = 0;
  let instructors = 0;
  const now = new Date().toISOString();

  for (const p of people) {
    const uid = p.email ? idByEmail.get(p.email) : undefined;
    if (!uid) continue;

    if (p.role === "instructor") {
      const { data: ex } = await supabase
        .from("course_instructors")
        .select("id")
        .eq("course_id", courseId)
        .eq("instructor_id", uid)
        .maybeSingle();
      if (!ex) {
        await supabase.from("course_instructors").insert({ course_id: courseId, instructor_id: uid });
        instructors++;
      }
    } else {
      const { data: ex } = await supabase
        .from("enrollments")
        .select("id")
        .eq("course_id", courseId)
        .eq("student_id", uid)
        .maybeSingle();
      if (!ex) {
        // Historical learners: 'active' so they appear in the app's views
        // (gradebook, roster — all filter status='active'). Progress and the
        // completion date come from the learner's real Moodle activity
        // completion; with no tracking data we fall back to 100%. Not
        // re-certified.
        const { progress, completedAt } = completionFor(opts.completion, p.moodleId, now);
        await supabase.from("enrollments").insert({
          course_id: courseId,
          class_id: classId,
          student_id: uid,
          status: "active",
          enrolled_at: now,
          updated_at: now,
          completed_at: completedAt,
          progress_percentage: progress,
        });
        enrollments++;
      }
    }
  }

  // 4. Course-level final grades (one "Final Grade" column), mapped from
  //    Moodle user id -> this class's account.
  let grades = 0;
  if (opts.finalGrades && opts.finalGrades.size > 0 && opts.gradeItemId) {
    const userByMoodle = new Map<string, string>();
    for (const p of people) {
      const uid = p.email ? idByEmail.get(p.email) : undefined;
      if (uid) userByMoodle.set(p.moodleId, uid);
    }
    for (const [moodleId, g] of opts.finalGrades) {
      const uid = userByMoodle.get(moodleId);
      if (!uid) continue;
      const { data: ex } = await supabase
        .from("course_grades")
        .select("id")
        .eq("course_id", courseId)
        .eq("student_id", uid)
        .eq("grade_item_id", opts.gradeItemId)
        .maybeSingle();
      if (ex) continue;
      const percentage = g.gradeMax > 0 ? Math.round((g.finalGrade / g.gradeMax) * 10000) / 100 : 0;
      await supabase.from("course_grades").insert({
        course_id: courseId,
        student_id: uid,
        grade_item_id: opts.gradeItemId,
        score: Math.round(g.finalGrade),
        max_score: Math.round(g.gradeMax),
        percentage,
      });
      grades++;
    }
  }

  return {
    usersCreated,
    usersExisting,
    skippedNoEmail,
    classesCreated: 1,
    enrollments,
    instructors,
    grades,
  };
}
