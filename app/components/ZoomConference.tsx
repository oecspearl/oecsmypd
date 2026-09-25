'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTimeInTimezone } from '@/lib/timezone-utils';
import { formatZoomMeetingId, trackedJoinPath } from '@/lib/conferences/zoom';

/**
 * Zoom join panel with attendance tracking and no LTI.
 *
 * Flow: page_view (logged) → "Join Zoom Meeting" (logged with IP/device,
 * participant marked joined, link revealed and opened) → heartbeats every
 * 60s while this tab stays open → leave on button or tab close.
 */

interface ConferenceInfo {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  scheduled_at?: string | null;
  timezone?: string | null;
  duration_minutes?: number | null;
  meeting_id?: string | null;
  course_id?: string | null;
}

interface ZoomConferenceProps {
  conferenceId: string;
  /** Optional data already on hand (from the course page); refreshed from the API. */
  initial?: Partial<ConferenceInfo> | null;
  isHost?: boolean;
  onLeave?: () => void;
  /** 'panel' inside the course page; 'page' on the standalone lobby. */
  variant?: 'panel' | 'page';
}

const HEARTBEAT_MS = 60_000;

export default function ZoomConference({ conferenceId, initial, isHost: isHostProp, onLeave, variant = 'panel' }: ZoomConferenceProps) {
  const [info, setInfo] = useState<ConferenceInfo | null>(initial ? ({ id: conferenceId, title: initial.title || 'Zoom meeting', ...initial } as ConferenceInfo) : null);
  const [canManage, setCanManage] = useState<boolean>(Boolean(isHostProp));
  const [isHost, setIsHost] = useState<boolean>(Boolean(isHostProp));
  const [accessError, setAccessError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState<{ url: string; passcode: string | null; meeting_id: string | null; log_id: string | null; tracked: boolean } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIdRef = useRef<string | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/conferences/${conferenceId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      return data;
    },
    [conferenceId]
  );

  // Log the visit and load the authoritative conference details.
  useEffect(() => {
    let cancelled = false;
    post({ event: 'page_view' })
      .then((data) => {
        if (cancelled) return;
        if (data?.conference) setInfo(data.conference);
        setCanManage(Boolean(data?.can_manage));
        setIsHost(Boolean(data?.is_host));
      })
      .catch((e: Error) => {
        if (!cancelled) setAccessError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [post]);

  const stopTimers = () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    heartbeatRef.current = null;
    timerRef.current = null;
  };

  const sendLeaveBeacon = useCallback(() => {
    if (!logIdRef.current) return;
    try {
      const blob = new Blob([JSON.stringify({ event: 'leave', log_id: logIdRef.current })], { type: 'application/json' });
      navigator.sendBeacon(`/api/conferences/${conferenceId}/access`, blob);
    } catch {
      /* best effort */
    }
  }, [conferenceId]);

  // Close the session if the tab is closed while "in meeting".
  useEffect(() => {
    const onPageHide = () => sendLeaveBeacon();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      stopTimers();
    };
  }, [sendLeaveBeacon]);

  const join = async () => {
    setJoining(true);
    setAccessError(null);
    try {
      const data = await post({ event: 'join_click' });
      if (!data?.url) throw new Error('No meeting link is configured for this conference.');
      logIdRef.current = data.log_id || null;
      setJoined({ url: data.url, passcode: data.passcode || null, meeting_id: data.meeting_id || null, log_id: data.log_id || null, tracked: Boolean(data.tracked) });
      setElapsed(0);
      stopTimers();
      if (data.log_id) {
        heartbeatRef.current = setInterval(() => {
          post({ event: 'heartbeat', log_id: data.log_id }).catch(() => {});
        }, HEARTBEAT_MS);
      }
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      setAccessError(e?.message || 'Could not join the meeting.');
    } finally {
      setJoining(false);
    }
  };

  const leave = async () => {
    stopTimers();
    const logId = logIdRef.current;
    logIdRef.current = null;
    try {
      await post({ event: 'leave', log_id: logId || undefined });
    } catch {
      /* best effort */
    }
    setJoined(null);
    onLeave?.();
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt('Copy this link', text);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const lobbyUrl = `${origin}${trackedJoinPath(conferenceId)}`;
  const redirectUrl = `${origin}/api/conferences/${conferenceId}/zoom`;
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const isOver = info?.status === 'ended' || info?.status === 'cancelled';

  const wrapper = variant === 'page' ? 'w-full' : 'relative w-full h-full bg-gradient-to-br from-blue-50 to-sky-100 rounded-lg overflow-auto flex items-start sm:items-center justify-center py-6';

  return (
    <div className={wrapper}>
      <div className="bg-white rounded-xl shadow-xl p-6 sm:p-8 max-w-lg w-full mx-4">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-[#2D8CFF] rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 17.5v-11Zm13.5 3.2 3.2-2.1a.8.8 0 0 1 1.3.7v7.4a.8.8 0 0 1-1.3.7l-3.2-2.1V9.7Z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900">Zoom Meeting</h2>
          <p className="text-gray-600 mt-1">{info?.title || 'Loading…'}</p>
          {info?.description && <p className="text-sm text-gray-500 mt-2">{info.description}</p>}
        </div>

        <div className="space-y-2 mb-6 text-sm text-gray-600">
          {info?.scheduled_at && (
            <p>
              <span className="font-medium text-gray-700">When:</span> {formatDateTimeInTimezone(info.scheduled_at, info.timezone || 'UTC')}
              {info.duration_minutes ? ` · ${info.duration_minutes} min` : ''}
            </p>
          )}
          {info?.meeting_id && info.meeting_id.startsWith('zoom-') && (
            <p>
              <span className="font-medium text-gray-700">Meeting ID:</span> {formatZoomMeetingId(info.meeting_id.split('-')[1])}
            </p>
          )}
          {isHost && <p className="text-blue-700 font-medium">You are the host</p>}
        </div>

        {accessError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{accessError}</div>
        )}

        {!joined ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={join}
              disabled={joining || Boolean(accessError) || isOver || !info}
              className="w-full bg-[#2D8CFF] hover:bg-[#1f7ae6] disabled:bg-blue-300 text-white font-semibold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {joining ? (
                <>
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Recording attendance…
                </>
              ) : isOver ? (
                'This meeting has ended'
              ) : (
                'Join Zoom Meeting'
              )}
            </button>
            <p className="text-xs text-gray-500 text-center">
              Zoom opens in a new tab. Your join time and device are recorded for attendance.
            </p>
            {onLeave && variant === 'panel' && (
              <button type="button" onClick={onLeave} className="w-full text-gray-500 hover:text-gray-700 text-sm py-2">
                Go back
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-medium text-green-800">You&apos;re checked in · {elapsedLabel}</p>
              <p className="text-xs text-green-700 mt-1">
                Keep this tab open while you are in Zoom so your time in the meeting is recorded. Click “I&apos;ve left the meeting” when you are done.
              </p>
              {!joined.tracked && <p className="text-xs text-amber-700 mt-1">Detailed access logging is not enabled on this server yet; only your join time was recorded.</p>}
            </div>

            <div className="rounded-lg border border-gray-200 p-4 text-sm space-y-2">
              <p className="text-gray-700">
                Zoom didn&apos;t open?{' '}
                <a href={joined.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                  Open it again
                </a>
              </p>
              {joined.meeting_id?.startsWith('zoom-') && (
                <p className="text-gray-700">
                  Meeting ID: <span className="font-mono">{formatZoomMeetingId(joined.meeting_id.split('-')[1])}</span>
                </p>
              )}
              {joined.passcode && (
                <p className="text-gray-700">
                  Passcode: <span className="font-mono font-semibold">{joined.passcode}</span>
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={leave}
              className="w-full bg-gray-800 hover:bg-gray-900 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
            >
              I&apos;ve left the meeting
            </button>
          </div>
        )}

        {canManage && (
          <div className="mt-6 border-t border-gray-100 pt-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Share with students</p>
            <p className="text-xs text-gray-600">
              Share these LMS links instead of the raw Zoom link. Every click is recorded with the student&apos;s name, time, device and IP before they are sent to Zoom.
            </p>
            <div className="flex items-center gap-2">
              <input readOnly value={lobbyUrl} className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50" />
              <button type="button" onClick={() => copy('lobby', lobbyUrl)} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                {copied === 'lobby' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-gray-500">Lobby page: shows meeting details and tracks time in meeting.</p>
            <div className="flex items-center gap-2">
              <input readOnly value={redirectUrl} className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50" />
              <button type="button" onClick={() => copy('redirect', redirectUrl)} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
                {copied === 'redirect' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-gray-500">One-click link for calendar invites and emails: records the click, then goes straight to Zoom.</p>
          </div>
        )}
      </div>
    </div>
  );
}
