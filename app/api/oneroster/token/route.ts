/**
 * OneRoster OAuth 2 client-credentials token endpoint.
 * POST /api/oneroster/token
 *
 * Accepts `application/x-www-form-urlencoded` or JSON with
 * `grant_type=client_credentials`, `client_id`, `client_secret`
 * (or HTTP Basic credentials), and returns a short-lived Bearer token
 * for the /api/oneroster/* endpoints.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateClientCredentials, issueOneRosterToken } from '@/lib/oneroster/auth';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { tooManyRequests, serverError } from '@/lib/api-errors';

export const dynamic = 'force-dynamic';

function oauthError(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit({ key: `oneroster-token:${clientIp(request)}`, limit: 20, windowSeconds: 60 });
    if (!limited.ok) return tooManyRequests(limited.retryAfter);

    let clientId = '';
    let clientSecret = '';
    let grantType = 'client_credentials';

    // HTTP Basic client authentication (RFC 6749 §2.3.1)
    const authHeader = request.headers.get('authorization') || '';
    if (/^Basic\s+/i.test(authHeader)) {
      const decoded = Buffer.from(authHeader.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    }

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      grantType = String(body?.grant_type ?? grantType);
      clientId = clientId || String(body?.client_id ?? '');
      clientSecret = clientSecret || String(body?.client_secret ?? '');
    } else {
      const form = await request.formData().catch(() => null);
      if (form) {
        grantType = String(form.get('grant_type') ?? grantType);
        clientId = clientId || String(form.get('client_id') ?? '');
        clientSecret = clientSecret || String(form.get('client_secret') ?? '');
      }
    }

    if (grantType !== 'client_credentials') return oauthError('unsupported_grant_type');
    if (!clientId || !clientSecret) return oauthError('invalid_request');

    const principal = await authenticateClientCredentials(clientId, clientSecret);
    if (!principal) return oauthError('invalid_client', 401);

    const issued = issueOneRosterToken(principal);
    if (!issued) return serverError('Token service unavailable');

    return NextResponse.json(
      {
        access_token: issued.token,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        scope: principal.scopes.join(' '),
      },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } }
    );
  } catch (err) {
    return serverError('Token request failed', err);
  }
}
