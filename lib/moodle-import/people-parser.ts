/**
 * Extracts the people enrolled in a Moodle course backup — their profile and
 * mapped MyPD role — from users.xml (profiles) + course/roles.xml (who has
 * which role in this course). One backup = one facilitator's course instance,
 * so these are that instance's facilitators + learners.
 */

import { parseStringPromise } from "xml2js";
import type { MoodleArchive } from "./archive";

export type MyPdRole = "instructor" | "student";

export interface EnrolledUser {
  moodleId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: MyPdRole;
}

function first(node: Record<string, unknown> | undefined, key: string): string {
  const v = node?.[key];
  const f = Array.isArray(v) ? v[0] : v;
  if (f == null || typeof f === "object") return "";
  const s = String(f).trim();
  return s === "$@NULL@$" ? "" : s;
}

/** Moodle roleid → MyPD role. 1 Manager, 2 Course creator, 3/4 Teacher → instructor; 5 Student → student. */
function mapRole(roleId: string): MyPdRole {
  return ["1", "2", "3", "4"].includes(roleId) ? "instructor" : "student";
}

export async function parseEnrolledUsers(archive: MoodleArchive): Promise<EnrolledUser[]> {
  const usersXml = archive.readText("users.xml");
  const rolesXml = archive.readText("course/roles.xml");
  if (!usersXml || !rolesXml) return [];

  // 1. Profiles: moodle user id → {firstName, lastName, email}.
  const usersDoc = await parseStringPromise(usersXml);
  const profiles = new Map<string, { firstName: string; lastName: string; email: string }>();
  for (const u of usersDoc?.users?.user ?? []) {
    const id = String(u.$?.id ?? first(u, "id"));
    if (!id) continue;
    profiles.set(id, {
      firstName: first(u, "firstname"),
      lastName: first(u, "lastname"),
      email: first(u, "email").toLowerCase(),
    });
  }

  // 2. Role assignments in this course. Keep the strongest role per user
  //    (instructor wins over student if someone has both).
  const rolesDoc = await parseStringPromise(rolesXml);
  const assignments: Array<{ userId: string; roleId: string }> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "assignment") {
          for (const a of Array.isArray(v) ? v : [v]) {
            assignments.push({ userId: first(a, "userid"), roleId: first(a, "roleid") });
          }
        }
        collect(v);
      }
    }
  };
  collect(rolesDoc);

  const roleByUser = new Map<string, MyPdRole>();
  for (const { userId, roleId } of assignments) {
    if (!userId) continue;
    const role = mapRole(roleId);
    if (role === "instructor" || !roleByUser.has(userId)) roleByUser.set(userId, role);
  }

  // 3. Combine: only people with a role in this course.
  const result: EnrolledUser[] = [];
  for (const [userId, role] of roleByUser) {
    const p = profiles.get(userId) ?? { firstName: "", lastName: "", email: "" };
    result.push({ moodleId: userId, ...p, role });
  }
  return result;
}
