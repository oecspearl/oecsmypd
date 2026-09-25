'use client';

import React, { useState } from 'react';
import { Mail, X, Send } from 'lucide-react';

interface EmailStudentsModalProps {
  courseId: string;
  courseTitle?: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Lets instructors and admins email everyone enrolled in a course.
 * Uses POST /api/courses/[id]/email-students.
 */
export default function EmailStudentsModal({ courseId, courseTitle, isOpen, onClose }: EmailStudentsModalProps) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number; skipped: number; total: number; errors?: string[] } | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setSubject('');
    setMessage('');
    setIncludeCompleted(false);
    setError(null);
    setResult(null);
  };

  const send = async () => {
    setError(null);
    if (!subject.trim() || !message.trim()) {
      setError('Subject and message are required.');
      return;
    }
    if (!window.confirm(`Send this email to every student enrolled in ${courseTitle || 'this course'}?`)) return;
    setSending(true);
    try {
      const res = await fetch(`/api/courses/${courseId}/email-students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), message: message.trim(), include_inactive: includeCompleted }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed to send (${res.status})`);
      setResult(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4">
          <div className="flex items-center gap-3">
            <Mail className="h-6 w-6 text-white" />
            <div>
              <h2 className="text-lg font-bold text-white">Email Students</h2>
              {courseTitle && <p className="text-sm text-blue-100">{courseTitle}</p>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 hover:bg-white/20" aria-label="Close">
            <X className="h-5 w-5 text-white" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {result ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                <p className="font-medium">
                  Sent to {result.sent} of {result.total} enrolled student{result.total === 1 ? '' : 's'}.
                </p>
                {result.skipped > 0 && <p className="mt-1">{result.skipped} skipped (no email address or email notifications turned off).</p>}
                {result.failed > 0 && <p className="mt-1 text-red-700">{result.failed} failed to send.</p>}
                {result.errors && result.errors.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
                    {result.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={reset} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  Send another
                </button>
                <button type="button" onClick={onClose} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                This sends one email to every student with an active enrolment. Students who turned off email notifications are skipped. The message is sent from the platform address, so ask students to reply through course messages.
              </p>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Subject *</span>
                <input
                  type="text"
                  value={subject}
                  maxLength={200}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Reminder: assignment 2 due Friday"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Message *</span>
                <textarea
                  value={message}
                  maxLength={10000}
                  rows={8}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={'Hello everyone,\n\n…'}
                />
                <span className="mt-1 block text-xs text-gray-500">Plain text. Line breaks are kept. Each email starts with “Hello &lt;student name&gt;,”.</span>
              </label>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={includeCompleted} onChange={(e) => setIncludeCompleted(e.target.checked)} />
                Also include students who have completed the course
              </label>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={sending || !subject.trim() || !message.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  {sending ? 'Sending…' : 'Send email'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
