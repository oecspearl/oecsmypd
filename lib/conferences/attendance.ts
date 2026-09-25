import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Conference session-window helpers.
 *
 * Problem this solves: a conference is only marked `ended` when the host
 * explicitly leaves while it is `live`. If the host closes the tab, the row
 * stays `live` forever, every participant without a `left_at` looks "in
 * session", and their duration grows without bound. Even for ended
 * conferences the old report measured stragglers up to "now".
 *
 * Rules:
 *  - A conference is OVER when its status is ended/completed/cancelled, or
 *    when now is past `scheduled_at + duration_minutes + STALE_GRACE`.
 *  - The effective END TIME of an over conference is the latest of: the
 *    planned end, the last recorded participant `left_at`, and (for rows
 *    already marked ended) `updated_at`; never later than now.
 *  - Participants of an over conference who never left are backfilled with
 *    `left_at = end time`, and a stale `live`/`scheduled` row is marked `ended`.
 */

export const STALE_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours past planned end
const DEFAULT_DURATION_MIN = 60;
const FINISHED_STATUSES = new Set(["ended", "completed", "cancelled"]);

export interface ConferenceRow {
  id: string;
  status: string | null;
  scheduled_at: string | null;
  duration_minutes?: number | null;
  updated_at?: string | null;
}

export interface ParticipantRow {
  id: string;
  joined_at: string | null;
  left_at: string | null;
}

export function plannedEnd(c: ConferenceRow): Date | null {
  if (!c.scheduled_at) return null;
  const start = new Date(c.scheduled_at).getTime();
  if (Number.isNaN(start)) return null;
  const mins = Number(c.duration_minutes) > 0 ? Number(c.duration_minutes) : DEFAULT_DURATION_MIN;
  return new Date(start + mins * 60_000);
}

export function isConferenceOver(c: ConferenceRow, participants: ParticipantRow[] = [], now = new Date()): boolean {
  if (FINISHED_STATUSES.has(String(c.status))) return true;
  const end = plannedEnd(c);
  if (end) return now.getTime() > end.getTime() + STALE_GRACE_MS;
  // No schedule to go by: treat as over if nobody has joined in the last 24h.
  const lastJoin = participants.reduce((m, p) => {
    const t = p.joined_at ? new Date(p.joined_at).getTime() : 0;
    return t > m ? t : m;
  }, 0);
  return lastJoin > 0 && now.getTime() - lastJoin > 24 * 60 * 60 * 1000;
}

export function effectiveEndTime(c: ConferenceRow, participants: ParticipantRow[] = [], now = new Date()): Date {
  const candidates: number[] = [];
  const end = plannedEnd(c);
  if (end) candidates.push(end.getTime());
  for (const p of participants) {
    // A recorded leave time, or a join time (someone joining proves the
    // meeting was still running then), both bound the end from below.
    for (const ts of [p.left_at, p.joined_at]) {
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (!Number.isNaN(t)) candidates.push(t);
    }
  }
  if (FINISHED_STATUSES.has(String(c.status)) && c.updated_at) {
    const t = new Date(c.updated_at).getTime();
    if (!Number.isNaN(t)) candidates.push(t);
  }
  const best = candidates.length ? Math.max(...candidates) : now.getTime();
  return new Date(Math.min(best, now.getTime()));
}

/** Minutes between join and leave (or the effective end), never negative. */
export function participantDurationMinutes(
  p: ParticipantRow,
  endIfStillIn: Date
): number {
  if (!p.joined_at) return 0;
  const joined = new Date(p.joined_at).getTime();
  const left = p.left_at ? new Date(p.left_at).getTime() : endIfStillIn.getTime();
  return Math.max(0, Math.round((left - joined) / 60_000));
}

/**
 * If the conference is over, persist the correction: backfill `left_at` for
 * participants still marked in-session and mark a stale live row as ended.
 * Returns the participants with the backfilled values applied.
 */
export async function finalizeIfOver<T extends ParticipantRow>(
  service: SupabaseClient,
  conference: ConferenceRow,
  participants: T[],
  now = new Date()
): Promise<{ over: boolean; endTime: Date | null; participants: T[] }> {
  if (!isConferenceOver(conference, participants, now)) {
    return { over: false, endTime: null, participants };
  }

  const endTime = effectiveEndTime(conference, participants, now);
  const endIso = endTime.toISOString();

  const stragglers = participants.filter((p) => !p.left_at);
  if (stragglers.length > 0) {
    const { error } = await service
      .from("conference_participants")
      .update({ left_at: endIso })
      .eq("conference_id", conference.id)
      .is("left_at", null);
    if (error) console.error("finalizeIfOver: left_at backfill failed", error.code);
  }

  if (!FINISHED_STATUSES.has(String(conference.status))) {
    const { error } = await service
      .from("video_conferences")
      .update({ status: "ended" })
      .eq("id", conference.id)
      .in("status", ["live", "in_progress", "scheduled"]);
    if (error) console.error("finalizeIfOver: status update failed", error.code);
    conference.status = "ended";
  }

  const patched = participants.map((p) =>
    p.left_at ? p : ({ ...p, left_at: p.joined_at && new Date(p.joined_at) > endTime ? p.joined_at : endIso } as T)
  );

  return { over: true, endTime, participants: patched };
}

/**
 * For list endpoints: mark stale live/scheduled conferences as ended (in the
 * DB and in the returned rows) so the UI stops showing "Live" for meetings
 * that finished long ago. Participants are finalized lazily by the
 * attendance/leave routes.
 */
export async function autoEndStaleConferences<T extends ConferenceRow>(
  service: SupabaseClient,
  rows: T[],
  now = new Date()
): Promise<T[]> {
  const stale = rows.filter(
    (r) => !FINISHED_STATUSES.has(String(r.status)) && isConferenceOver(r, [], now)
  );
  if (stale.length === 0) return rows;

  const ids = stale.map((r) => r.id);
  const { error } = await service
    .from("video_conferences")
    .update({ status: "ended" })
    .in("id", ids);
  if (error) {
    console.error("autoEndStaleConferences: update failed", error.code);
    return rows;
  }
  const staleSet = new Set(ids);
  return rows.map((r) => (staleSet.has(r.id) ? { ...r, status: "ended" } : r));
}
