/**
 * Zoom link helpers. No Zoom API or LTI is involved: instructors paste a
 * normal Zoom join link, and the LMS wraps it in a tracked join flow.
 */

const ZOOM_HOST = /(^|\.)zoom\.(us|com|com\.cn)$/i;

export interface ParsedZoomLink {
  url: string;
  /** Numeric meeting ID when the link is a /j/<id> or /w/<id> link. */
  meetingId: string | null;
}

/**
 * Accepts https links on zoom.us / *.zoom.us (including vanity subdomains
 * and zoom.com). Rejects anything else so a "Zoom" conference can never point
 * at an arbitrary site.
 */
export function parseZoomLink(input: string | null | undefined): ParsedZoomLink | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ZOOM_HOST.test(url.hostname)) return null;

  const m = url.pathname.match(/\/(?:j|w|s|my)\/([A-Za-z0-9._-]+)/);
  const meetingId = m && /^\d{9,12}$/.test(m[1]) ? m[1] : null;
  return { url: url.toString(), meetingId };
}

/** Public, shareable LMS link that records access before sending to Zoom. */
export function trackedJoinPath(conferenceId: string): string {
  return `/conferences/${conferenceId}/join`;
}

/** Formats a Zoom meeting ID as Zoom shows it: 123 4567 8901. */
export function formatZoomMeetingId(id: string | null | undefined): string {
  const digits = String(id || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/(\d{3})(\d{4})(\d+)/, '$1 $2 $3');
}
