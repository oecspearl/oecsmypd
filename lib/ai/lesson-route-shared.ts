/**
 * Shared auth, rate limiting and usage tracking for the
 * /api/ai/lesson-from-document/* routes.
 */

import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { tooManyRequests } from '@/lib/api-errors';
import { getCurrentUser } from '@/lib/database-helpers';
import { hasRole, type UserRole } from '@/lib/rbac';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { hasOpenAIKey, type Usage } from './lesson-generator';

export const LESSON_AI_ROLES: UserRole[] = ['instructor', 'curriculum_designer', 'admin', 'super_admin'];

type AuthOk = { ok: true; user: { id: string; role: string } };
type AuthFail = { ok: false; response: NextResponse };

export async function authorizeLessonAi(opts: { requireOpenAI: boolean }): Promise<AuthOk | AuthFail> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!hasRole(user.role, LESSON_AI_ROLES)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const limit = await rateLimit({ key: `ai:${user.id}`, limit: 30, windowSeconds: 60 });
  if (!limit.ok) return { ok: false, response: tooManyRequests(limit.retryAfter) };

  if (opts.requireOpenAI && !hasOpenAIKey()) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'AI generation is not configured on this server (OPENAI_API_KEY missing).' }, { status: 503 }),
    };
  }
  return { ok: true, user: { id: user.id, role: user.role } };
}

/** Best-effort usage accounting; never fails the request. */
export async function recordUsage(userId: string, usage: Usage): Promise<void> {
  if (usage.calls === 0) return;
  try {
    const supabase = await createServerSupabaseClient();
    // gpt-4o blended estimate; the dashboard treats this as approximate.
    const estimatedCost = (usage.tokens / 1000) * 0.005;
    await supabase.rpc('update_ai_usage', {
      user_uuid: userId,
      additional_calls: usage.calls,
      additional_tokens: usage.tokens,
      additional_cost: estimatedCost,
    });
  } catch (e) {
    console.error('[lesson-from-document] usage tracking failed:', e);
  }
}

/** Map thrown errors to a safe client message and status. */
export function errorResponse(e: unknown, fallback: string): NextResponse {
  const err = e as { message?: string; status?: number; name?: string; code?: string };
  console.error(`[lesson-from-document] ${fallback}:`, e);

  if (err?.name === 'ExtractionError') {
    return NextResponse.json({ error: err.message }, { status: err.status || 400 });
  }
  const msg = String(err?.message || '');
  if (/cut off|declined|too short|empty ai response/i.test(msg)) {
    return NextResponse.json({ error: msg }, { status: 422 });
  }
  if (/rate limit|quota|429/i.test(msg)) {
    return NextResponse.json({ error: 'The AI service is busy. Wait a moment and try again.' }, { status: 429 });
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    return NextResponse.json({ error: 'The AI service took too long to respond. Try again, or reduce the document size.' }, { status: 504 });
  }
  if (/api key|OPENAI_API_KEY|401/i.test(msg)) {
    return NextResponse.json({ error: 'AI service configuration error.' }, { status: 503 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}
