'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseFetchJsonResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the request (e.g. from a Retry button). */
  reload: () => void;
}

/**
 * Small resilient JSON fetch hook for weak connections.
 *
 * - Aborts the in-flight request when the URL changes or the component unmounts.
 * - Sets `error` on network failure or non-2xx responses (using the JSON
 *   `error` field when present).
 * - Never leaves `loading` true after a failure.
 * - Pass `null` as the URL to skip fetching (e.g. while waiting on an id).
 */
export function useFetchJson<T = any>(
  url: string | null,
  deps: React.DependencyList = [],
  init?: RequestInit
): UseFetchJsonResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(url !== null);
  const [nonce, setNonce] = useState(0);
  const initRef = useRef(init);
  initRef.current = init;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          ...initRef.current,
          signal: controller.signal,
        });

        let body: any = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }

        if (!active) return;

        if (!res.ok) {
          const message =
            (body && (body.error || body.message)) ||
            `Request failed (${res.status})`;
          setError(String(message));
          setData(null);
        } else {
          setData(body as T);
        }
      } catch (err: any) {
        if (!active || err?.name === 'AbortError') return;
        setError(err?.message || 'Network error. Please check your connection.');
        setData(null);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, ...deps]);

  return { data, error, loading, reload };
}

export default useFetchJson;
