import { NextResponse } from "next/server";

/**
 * Central API error responder.
 *
 * Never leaks database error messages, hints, or stack traces to clients.
 * Details are logged server-side with a short reference id so support can
 * correlate a user report with the log line.
 */

const isDev = process.env.NODE_ENV !== "production";

function refId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function apiError(
  status: number,
  message: string,
  internal?: unknown,
  extra?: Record<string, unknown>
) {
  const ref = refId();
  if (internal !== undefined) {
    const detail =
      internal instanceof Error
        ? { name: internal.name, message: internal.message }
        : typeof internal === "object" && internal !== null
          ? {
              message: (internal as any).message,
              code: (internal as any).code,
              details: (internal as any).details,
              hint: (internal as any).hint,
            }
          : { message: String(internal) };
    console.error(`[api:${ref}] ${status} ${message}`, detail);
  }
  return NextResponse.json(
    {
      error: message,
      ref,
      ...(isDev && internal !== undefined
        ? { debug: internal instanceof Error ? internal.message : (internal as any)?.message }
        : {}),
      ...(extra || {}),
    },
    { status }
  );
}

export const unauthorized = (msg = "Authentication required") => apiError(401, msg);
export const forbidden = (msg = "Forbidden") => apiError(403, msg);
export const notFound = (msg = "Not found") => apiError(404, msg);
export const badRequest = (msg = "Invalid request", internal?: unknown) => apiError(400, msg, internal);
export const conflict = (msg = "Conflict") => apiError(409, msg);
export const tooManyRequests = (retryAfterSeconds = 60) =>
  NextResponse.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );

/** For catch blocks: `return serverError("Failed to load course", e)` */
export const serverError = (msg = "Internal server error", internal?: unknown) =>
  apiError(500, msg, internal);

/**
 * Map a Supabase/PostgREST error to a sensible status without exposing it.
 * Unique violation -> 409, row-not-found -> 404, RLS/permission -> 403, else 500.
 */
export function fromDbError(e: any, fallbackMsg = "Database error") {
  const code: string | undefined = e?.code;
  if (code === "23505") return conflict("Already exists");
  if (code === "PGRST116") return notFound();
  if (code === "42501") return forbidden();
  return serverError(fallbackMsg, e);
}
