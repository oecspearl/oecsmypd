'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import ZoomConference from '@/app/components/ZoomConference';

/**
 * Standalone lobby for a conference. This is the link instructors share:
 * it requires sign-in (middleware), records the visit and the join, and keeps
 * presence heartbeats while the student is in Zoom.
 */

const ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This conference could not be found.',
  forbidden: 'You do not have access to this conference. You must be enrolled in its course.',
  ended: 'This meeting has already ended.',
  server: 'Something went wrong while opening the meeting. Please try again.',
};

export default function ConferenceJoinPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-2xl px-4 py-12 text-sm text-gray-500">Loading…</div>}>
      <ConferenceJoinInner />
    </Suspense>
  );
}

function ConferenceJoinInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const errorKey = params.get('error');
  const errorMessage = errorKey ? ERROR_MESSAGES[errorKey] || ERROR_MESSAGES.server : null;
  const [courseId, setCourseId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/conferences/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.conference?.course_id) setCourseId(data.conference.course_id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="min-h-[70vh] bg-gradient-to-br from-blue-50 to-sky-100">
      <div className="mx-auto max-w-2xl px-4 py-10">
        {errorMessage && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{errorMessage}</div>
        )}
        <ZoomConference conferenceId={id} variant="page" />
        <div className="mt-6 text-center text-sm">
          {courseId ? (
            <Link href={`/course/${courseId}`} className="text-blue-700 hover:underline">
              Back to course
            </Link>
          ) : (
            <Link href="/my-courses" className="text-blue-700 hover:underline">
              Back to my courses
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
