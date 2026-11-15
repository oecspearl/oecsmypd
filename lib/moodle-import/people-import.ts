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

export interface PeopleSummary {
  usersCreated: number;
  usersExisting: number;
  skippedNoEmail: number;
  classesCreated: number;
  enrollments: number;
  instructors: number;
}

export async function importPeopleForCourse(
  supabase: SupabaseClient,
  courseId: string,
  className: string,
  people: EnrolledUser[]
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
        await supabase.from("enrollments").insert({
          course_id: courseId,
          class_id: classId,
          student_id: uid,
          status: "completed",
          enrolled_at: now,
          updated_at: now,
          completed_at: now,
        });
        enrollments++;
      }
    }
  }

  return { usersCreated, usersExisting, skippedNoEmail, classesCreated: 1, enrollments, instructors };
}
