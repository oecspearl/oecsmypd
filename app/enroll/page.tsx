"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

type Course = {
  id: string;
  title?: string | null;
  description?: string | null;
  difficulty?: string | null;
  subject_area?: string | null;
  grade_level?: string | null;
  published?: boolean | null;
};

type Notice = { kind: "success" | "error"; text: string } | null;

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return (data && typeof data.error === "string" && data.error) || fallback;
  } catch {
    return fallback;
  }
}

export default function EnrollPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>("");
  const [q, setQ] = useState("");
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [enrollingId, setEnrollingId] = useState<string | null>(null);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/courses`, { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res, "Failed to load courses"));
        setCourses([]);
        return;
      }
      const data = await res.json();
      const list: Course[] = Array.isArray(data?.courses) ? data.courses : [];
      setCourses(list.filter((c) => c && c.id && c.published !== false));
    } catch {
      setLoadError("Failed to load courses");
      setCourses([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return courses;
    return courses.filter((c) =>
      [c.title, c.description, c.subject_area, c.grade_level]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term))
    );
  }, [courses, q]);

  async function enroll(courseId: string) {
    if (enrollingId) return;
    setEnrollingId(courseId);
    setNotice(null);
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/enroll`, { method: "POST" });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setEnrolledIds((prev) => new Set(prev).add(courseId));
        setNotice({ kind: "success", text: data?.message || "Enrolled" });
      } else {
        if (res.status === 409) setEnrolledIds((prev) => new Set(prev).add(courseId));
        setNotice({ kind: "error", text: await readError(res, "Failed to enroll") });
      }
    } catch {
      setNotice({ kind: "error", text: "Failed to enroll" });
    } finally {
      setEnrollingId(null);
    }
  }

  async function enrollWithCode() {
    const trimmed = code.trim();
    if (!trimmed || joining) return;
    setJoining(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/enrollments/by-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setNotice({ kind: "success", text: data?.message || "Enrolled with code" });
        setCode("");
      } else {
        setNotice({ kind: "error", text: await readError(res, "Invalid code") });
      }
    } catch {
      setNotice({ kind: "error", text: "Failed to enroll with code" });
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-sm">
      <h1 className="text-2xl font-medium text-gray-900 mb-4">Enroll</h1>
      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search courses"
          aria-label="Search courses"
          className="border rounded px-3 py-2 flex-1"
        />
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            enrollWithCode();
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enrollment code"
            aria-label="Enrollment code"
            className="border rounded px-3 py-2"
          />
          <button
            type="submit"
            disabled={joining || !code.trim()}
            className="px-3 py-2 rounded bg-blue-500 text-white disabled:opacity-50"
          >
            {joining ? "Joining..." : "Join"}
          </button>
        </form>
      </div>

      {notice && (
        <p
          role="status"
          className={`text-xs mb-3 ${notice.kind === "success" ? "text-green-600" : "text-red-600"}`}
        >
          {notice.text}
        </p>
      )}

      {loading ? (
        <p className="text-gray-500">Loading courses...</p>
      ) : loadError ? (
        <div className="flex items-center gap-3">
          <p className="text-red-600">{loadError}</p>
          <button onClick={load} className="text-blue-600 underline">
            Retry
          </button>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-gray-500">{q ? "No courses match your search." : "No courses are open for enrollment."}</p>
      ) : (
        <div className="space-y-2">
          {visible.map((c) => {
            const isEnrolled = enrolledIds.has(c.id);
            const isBusy = enrollingId === c.id;
            return (
              <div key={c.id} className="rounded-lg border bg-white/70 p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-gray-900 text-sm truncate">{c.title || "Course"}</p>
                  <p className="text-gray-500 text-xs">
                    {[c.subject_area, c.grade_level, c.difficulty].filter(Boolean).join(" · ")}
                  </p>
                  {c.description && (
                    <p className="text-gray-600 text-xs mt-1 line-clamp-2">{c.description}</p>
                  )}
                </div>
                <button
                  disabled={isBusy || isEnrolled || !!enrollingId}
                  onClick={() => enroll(c.id)}
                  className="text-sm px-3 py-1.5 rounded bg-blue-500 text-white disabled:opacity-50 shrink-0"
                >
                  {isEnrolled ? "Enrolled" : isBusy ? "Enrolling..." : "Enroll"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
