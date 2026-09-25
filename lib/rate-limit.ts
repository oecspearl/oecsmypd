import type { NextRequest } from "next/server";

/**
 * Rate limiter for API routes.
 *
 * Uses Upstash Redis (REST) when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * are configured, so limits hold across serverless instances. Falls back to an
 * in-memory window per instance otherwise (better than nothing, and correct in
 * local development).
 *
 * Usage:
 *   const limited = await rateLimit(request, { key: `ai:${user.id}`, limit: 20, windowSeconds: 60 });
 *   if (!limited.ok) return tooManyRequests(limited.retryAfter);
 */

export interface RateLimitOptions {
  /** Stable identifier for the bucket, e.g. `contact:${ip}` or `ai:${userId}`. */
  key: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const entry = memory.get(opts.key);
  if (!entry || entry.resetAt <= now) {
    memory.set(opts.key, { count: 1, resetAt: now + opts.windowSeconds * 1000 });
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return { ok: true, remaining: opts.limit - 1, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > opts.limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: opts.limit - entry.count, retryAfter: 0 };
}

async function upstashLimit(opts: RateLimitOptions): Promise<RateLimitResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const key = `rl:${opts.key}`;
    // INCR then set expiry only on first hit (pipeline).
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(opts.windowSeconds), "NX"],
        ["TTL", key],
      ]),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ result: number }>;
    const count = Number(data[0]?.result ?? 0);
    const ttl = Number(data[2]?.result ?? opts.windowSeconds);
    if (count > opts.limit) return { ok: false, remaining: 0, retryAfter: Math.max(1, ttl) };
    return { ok: true, remaining: Math.max(0, opts.limit - count), retryAfter: 0 };
  } catch {
    return null; // fall back to memory on any transport error
  }
}

export async function rateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const remote = await upstashLimit(opts);
  return remote ?? memoryLimit(opts);
}

/** Best-effort client IP for unauthenticated endpoints. */
export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
