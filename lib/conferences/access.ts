/**
 * Who may join / manage a conference. Mirrors the checks in the existing
 * join route so the Zoom flow and the legacy flow agree.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ConferenceAccessRow {
  id: string;
  title: string;
  description: string | null;
  course_id: string | null;
  lesson_id: string | null;
  instructor_id: string | null;
  status: string | null;
  meeting_id: string;
  meeting_url: string;
  meeting_password: string | null;
  video_provider: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  duration_minutes: number | null;
}

export type ConferenceAccessResult =
  | { ok: false; status: 404 | 403; error: string }
  | { ok: true; conference: ConferenceAccessRow; role: string; canManage: boolean; isHost: boolean };

const MANAGER_ROLES = new Set(['admin', 'super_admin', 'curriculum_designer']);
const STAFF_ROLES = new Set(['instructor', ...MANAGER_ROLES]);

export async function resolveConferenceAccess(
  service: SupabaseClient,
  userId: string,
  conferenceId: string
): Promise<ConferenceAccessResult> {
  const { data: conference, error } = await service
    .from('video_conferences')
    .select('id, title, description, course_id, lesson_id, instructor_id, status, meeting_id, meeting_url, meeting_password, video_provider, scheduled_at, timezone, duration_minutes')
    .eq('id', conferenceId)
    .single();
  if (error || !conference) return { ok: false, status: 404, error: 'Conference not found' };

  const { data: userRow } = await service.from('users').select('role').eq('id', userId).single();
  const role = String(userRow?.role || 'student');
  const isHost = conference.instructor_id === userId;

  let canManage = isHost || MANAGER_ROLES.has(role);
  if (!canManage && STAFF_ROLES.has(role) && conference.course_id) {
    const { data: ci } = await service
      .from('course_instructors')
      .select('id')
      .eq('course_id', conference.course_id)
      .eq('instructor_id', userId)
      .maybeSingle();
    canManage = Boolean(ci);
  }

  if (!canManage) {
    if (!conference.course_id) return { ok: false, status: 403, error: 'Access denied' };
    const { data: enrollment } = await service
      .from('enrollments')
      .select('id')
      .eq('student_id', userId)
      .eq('course_id', conference.course_id)
      .in('status', ['active', 'completed'])
      .maybeSingle();
    if (!enrollment) {
      return { ok: false, status: 403, error: 'Access denied. You must be enrolled in this course to join the conference.' };
    }
  }

  return { ok: true, conference: conference as ConferenceAccessRow, role, canManage, isHost };
}

/**
 * For list/detail responses: hide the raw Zoom link and passcode from anyone
 * who cannot manage the conference, so students always go through the
 * tracked join flow. Other providers are returned unchanged.
 */
export function redactExternalLinks<T extends { video_provider?: string | null }>(row: T, canManage: boolean): T {
  if (canManage || row.video_provider !== 'zoom') return row;
  const copy = { ...row } as T & { meeting_url?: string; meeting_password?: string | null; link_redacted?: boolean };
  copy.meeting_url = '';
  copy.meeting_password = null;
  copy.link_redacted = true;
  return copy;
}
