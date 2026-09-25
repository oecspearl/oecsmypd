'use client';

import React from 'react';
import SubjectSelector from '@/app/components/SubjectSelector';
import Link from 'next/link';

export default function MySubjectsPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = React.useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [courses, setCourses] = React.useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [subjects, setSubjects] = React.useState<any[]>([]);
  const [courseFilter, setCourseFilter] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const opts: RequestInit = { cache: 'no-store', signal: controller.signal };
        const pRes = await fetch('/api/auth/profile', opts);
        if (!pRes.ok) throw new Error(`Failed to load profile (${pRes.status})`);
        const prof = await pRes.json();
        if (!active) return;
        setProfile(prof);

        const eRes = await fetch('/api/enrollments?me=1', opts);
        if (!eRes.ok) throw new Error(`Failed to load enrollments (${eRes.status})`);
        const eData = await eRes.json();
        const enrollments: any[] = Array.isArray(eData.enrollments) ? eData.enrollments : [];
        const courseIds = Array.from(new Set(enrollments.map((e) => e.course_id).filter(Boolean)));

        // Fetch course + subjects for every enrollment in parallel (was serial N+1).
        const safeJson = async (url: string) => {
          try {
            const r = await fetch(url, opts);
            return r.ok ? await r.json() : null;
          } catch (err: any) {
            if (err?.name === 'AbortError') throw err;
            return null;
          }
        };
        const [courseRows, subjectRows] = await Promise.all([
          Promise.all(courseIds.map((id) => safeJson(`/api/courses/${id}`))),
          Promise.all(courseIds.map((id) => safeJson(`/api/courses/${id}/subjects`))),
        ]);
        if (!active) return;

        setCourses(courseRows.filter((c) => c && c.id));
        setSubjects(subjectRows.flatMap((sData) => (sData && Array.isArray(sData.subjects) ? sData.subjects : [])));
      } catch (err: any) {
        if (!active || err?.name === 'AbortError') return;
        console.error('Failed to load subjects:', err);
        setError(err?.message || 'Network error. Please check your connection.');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; controller.abort(); };
  }, [attempt]);

  const options = courses.map((c)=> ({ id: c.id, title: c.title }));
  const filtered = courseFilter ? subjects.filter((s)=> s.course_id === courseFilter) : subjects;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-medium text-gray-900"><span>My Subjects</span></h1>
        <div className="w-64">
          <SubjectSelector subjects={options} value={courseFilter} onChange={setCourseFilter} />
        </div>
      </div>

      {loading && (
        <p className="mt-6 text-sm text-gray-500">Loading your subjects...</p>
      )}
      {!loading && error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between gap-4">
          <span>{error}</span>
          <button onClick={() => setAttempt((n) => n + 1)} className="rounded-md border border-red-300 bg-white px-3 py-1 text-red-700 hover:bg-red-100">Retry</button>
        </div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <p className="mt-6 text-sm text-gray-500">No subjects found for your enrolled courses.</p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {filtered.map((s:any)=> (
          <div key={s.id} className="rounded-xl border bg-white p-4">
            <h3 className="text-sm text-gray-900">{s.title}</h3>
            <p className="mt-1 text-xs text-gray-600">{s.description}</p>
            <Link href={`/course/${s.course_id}`} className="mt-2 inline-block text-xs text-[#3B82F6] underline"><span>View Course</span></Link>
          </div>
        ))}
      </div>
    </div>
  );
}
