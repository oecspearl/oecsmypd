/**
 * Access logging for external-provider conferences (Zoom).
 *
 * Every join action writes one row to `conference_access_logs` with the
 * requester's IP, device, browser and OS. The lobby page then keeps that row
 * alive with heartbeats (last_seen_at) and closes it on leave (ended_at), so
 * an approximate time-in-meeting is available without any Zoom integration.
 *
 * All writes are best-effort: if the table does not exist yet (migration not
 * applied) the join still succeeds and the error is logged once.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConferenceAccessLog } from '@/types/conference';

export type AccessEvent = ConferenceAccessLog['event'];

export interface ClientInfo {
  ip: string | null;
  user_agent: string | null;
  device_type: string;
  browser: string;
  os: string;
  referrer: string | null;
}

let warnedMissingTable = false;

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /conference_access_logs.*does not exist|relation .* does not exist/i.test(error.message || '');
}

function noteMissingTable() {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.warn(
    '[conference-access] conference_access_logs table is missing. Run supabase/migrations/20260924120000_zoom_conference_access_logs.sql to enable access logging.'
  );
}

/** Lightweight user-agent classification; no external dependency. */
export function parseUserAgent(ua: string | null | undefined): Pick<ClientInfo, 'device_type' | 'browser' | 'os'> {
  const s = String(ua || '');
  const lower = s.toLowerCase();

  let device_type = 'desktop';
  if (/ipad|tablet|kindle|silk|playbook/.test(lower) || (/android/.test(lower) && !/mobile/.test(lower))) device_type = 'tablet';
  else if (/mobi|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/.test(lower)) device_type = 'mobile';
  if (/zoom/i.test(s) && /zoomclient|ZoomWebKit/i.test(s)) device_type = 'zoom-client';

  let os = 'Other';
  if (/windows nt/.test(lower)) os = 'Windows';
  else if (/iphone|ipad|ipod/.test(lower)) os = 'iOS';
  else if (/mac os x|macintosh/.test(lower)) os = 'macOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/cros/.test(lower)) os = 'ChromeOS';
  else if (/linux/.test(lower)) os = 'Linux';

  let browser = 'Other';
  if (/edg\//.test(lower)) browser = 'Edge';
  else if (/opr\/|opera/.test(lower)) browser = 'Opera';
  else if (/samsungbrowser/.test(lower)) browser = 'Samsung Internet';
  else if (/firefox|fxios/.test(lower)) browser = 'Firefox';
  else if (/chrome|crios/.test(lower)) browser = 'Chrome';
  else if (/safari/.test(lower)) browser = 'Safari';

  return { device_type, browser, os };
}

export function clientInfoFromRequest(request: Request): ClientInfo {
  const h = request.headers;
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
  const user_agent = h.get('user-agent');
  const referrer = h.get('referer');
  return {
    ip: ip ? ip.slice(0, 64) : null,
    user_agent: user_agent ? user_agent.slice(0, 1000) : null,
    referrer: referrer ? referrer.slice(0, 1000) : null,
    ...parseUserAgent(user_agent),
  };
}

export interface RecordAccessInput {
  conference_id: string;
  user_id: string;
  course_id?: string | null;
  event: AccessEvent;
  role?: string | null;
  client: ClientInfo;
  metadata?: Record<string, unknown>;
}

/** Inserts one access-log row. Returns the row id, or null when logging is unavailable. */
export async function recordAccess(service: SupabaseClient, input: RecordAccessInput): Promise<string | null> {
  const now = new Date().toISOString();
  const { data, error } = await service
    .from('conference_access_logs')
    .insert([
      {
        conference_id: input.conference_id,
        user_id: input.user_id,
        course_id: input.course_id ?? null,
        event: input.event,
        role: input.role ?? null,
        occurred_at: now,
        last_seen_at: input.event === 'join_click' || input.event === 'join_redirect' ? now : null,
        ip: input.client.ip,
        user_agent: input.client.user_agent,
        device_type: input.client.device_type,
        browser: input.client.browser,
        os: input.client.os,
        referrer: input.client.referrer,
        metadata: input.metadata ?? {},
      },
    ])
    .select('id')
    .single();

  if (error) {
    if (isMissingTable(error)) noteMissingTable();
    else console.error('[conference-access] insert failed:', error.code, error.message);
    return null;
  }
  return data?.id ?? null;
}

/** Heartbeat: bump last_seen_at on the caller's own join row. */
export async function touchAccess(service: SupabaseClient, logId: string, userId: string): Promise<boolean> {
  const { error } = await service
    .from('conference_access_logs')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', logId)
    .eq('user_id', userId)
    .is('ended_at', null);
  if (error) {
    if (isMissingTable(error)) noteMissingTable();
    return false;
  }
  return true;
}

/** Leave: close the caller's own join row. */
export async function endAccess(service: SupabaseClient, logId: string, userId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await service
    .from('conference_access_logs')
    .update({ ended_at: now, last_seen_at: now })
    .eq('id', logId)
    .eq('user_id', userId)
    .is('ended_at', null);
  if (error) {
    if (isMissingTable(error)) noteMissingTable();
    return false;
  }
  return true;
}

/** All log rows for a conference, oldest first. Empty when logging is unavailable. */
export async function listAccessLogs(service: SupabaseClient, conferenceId: string): Promise<ConferenceAccessLog[]> {
  const { data, error } = await service
    .from('conference_access_logs')
    .select('*')
    .eq('conference_id', conferenceId)
    .order('occurred_at', { ascending: true })
    .limit(5000);
  if (error) {
    if (isMissingTable(error)) noteMissingTable();
    else console.error('[conference-access] list failed:', error.code, error.message);
    return [];
  }
  return (data || []) as ConferenceAccessLog[];
}

export interface AccessSummary {
  join_count: number;
  first_join_at: string | null;
  last_seen_at: string | null;
  /** Latest explicit leave (ended_at) across the user's join rows. */
  ended_at: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  ip: string | null;
  /** Approximate minutes derived from heartbeats, summed across join rows. */
  tracked_minutes: number;
}

/** Aggregates a conference's log rows per user for the attendance report. */
export function summariseAccessByUser(logs: ConferenceAccessLog[]): Map<string, AccessSummary> {
  const out = new Map<string, AccessSummary>();
  for (const row of logs) {
    if (!row.user_id) continue;
    const isJoin = row.event === 'join_click' || row.event === 'join_redirect';
    const s = out.get(row.user_id) || {
      join_count: 0,
      first_join_at: null,
      last_seen_at: null,
      ended_at: null,
      device_type: null,
      browser: null,
      os: null,
      ip: null,
      tracked_minutes: 0,
    };
    if (isJoin) {
      s.join_count += 1;
      if (!s.first_join_at || row.occurred_at < s.first_join_at) s.first_join_at = row.occurred_at;
      const end = row.ended_at || row.last_seen_at;
      if (end) {
        const mins = (new Date(end).getTime() - new Date(row.occurred_at).getTime()) / 60_000;
        if (Number.isFinite(mins) && mins > 0) s.tracked_minutes += mins;
      }
    }
    if (row.last_seen_at && (!s.last_seen_at || row.last_seen_at > s.last_seen_at)) s.last_seen_at = row.last_seen_at;
    if (row.ended_at && (!s.ended_at || row.ended_at > s.ended_at)) s.ended_at = row.ended_at;
    // Most recent device wins.
    if (row.device_type) s.device_type = row.device_type;
    if (row.browser) s.browser = row.browser;
    if (row.os) s.os = row.os;
    if (row.ip) s.ip = row.ip;
    out.set(row.user_id, s);
  }
  for (const s of out.values()) s.tracked_minutes = Math.round(s.tracked_minutes);
  return out;
}
