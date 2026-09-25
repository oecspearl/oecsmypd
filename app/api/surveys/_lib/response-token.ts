import type { NextRequest } from 'next/server';
import { verifyOpaqueToken } from '@/lib/security';
import { authenticateUser } from '@/lib/api-auth';

export const SURVEY_RESPONSE_TOKEN_PURPOSE = 'survey-response';

export function surveyResponseCookieName(responseId: string): string {
  return `svr_${responseId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/**
 * Decide whether the caller may modify a survey response.
 *
 * - A response with a respondent_id belongs to that authenticated user only.
 * - An anonymous response (respondent_id null) must be accompanied by the
 *   token issued when it was started: the HttpOnly cookie set by
 *   POST /responses, an `X-Response-Token` header, or `response_token` in the body.
 */
export async function callerOwnsSurveyResponse(
  request: NextRequest,
  response: { id: string; respondent_id: string | null },
  body?: any
): Promise<boolean> {
  if (response.respondent_id) {
    const auth = await authenticateUser(request);
    return !!(auth.success && auth.userProfile && auth.userProfile.id === response.respondent_id);
  }

  const presented =
    request.cookies.get(surveyResponseCookieName(response.id))?.value ||
    request.headers.get('x-response-token') ||
    (typeof body?.response_token === 'string' ? body.response_token : null);

  return verifyOpaqueToken(SURVEY_RESPONSE_TOKEN_PURPOSE, response.id, presented);
}
