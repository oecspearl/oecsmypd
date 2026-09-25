/**
 * OneRoster API authentication.
 *
 * Two mechanisms are supported:
 *
 * 1. OAuth 2 client-credentials (preferred).  The SIS posts its client_id and
 *    client_secret to POST /api/oneroster/token and receives a short-lived JWT.
 *    Every OneRoster endpoint then accepts `Authorization: Bearer <token>`.
 *    The secret is stored only as a SHA-256 hex digest in
 *    `oneroster_clients.client_secret_hash` (see hashClientSecret()).
 *
 * 2. OAuth 1.0a HMAC-SHA1 (`Authorization: OAuth ...`).  This is verified
 *    strictly per RFC 5849 §3.4 (signature base string, timing-safe compare,
 *    ±5 minute timestamp window).  Because HMAC-SHA1 needs the plaintext
 *    consumer secret and the database stores only a hash, this path only works
 *    when the client row exposes a plaintext `client_secret` column.  If that
 *    column does not exist the OAuth 1.0a path fails closed.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { NextRequest } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';

export interface OAuth1Params {
  oauth_consumer_key: string;
  oauth_signature_method: string;
  oauth_timestamp: string;
  oauth_nonce: string;
  oauth_version?: string;
  oauth_signature: string;
  [key: string]: string | undefined;
}

export interface OneRosterPrincipal {
  client_id: string;
  scopes: string[];
}

const TIMESTAMP_WINDOW_SECONDS = 5 * 60;
const TOKEN_TTL_SECONDS = 60 * 60;
const JWT_ISSUER = 'oecsmypd-oneroster';
const JWT_AUDIENCE = 'oneroster';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding as required by RFC 5849 §3.6. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function jwtSecret(): string | null {
  return process.env.ONEROSTER_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || null;
}

/** SHA-256 hex digest used for `oneroster_clients.client_secret_hash`. */
export function hashClientSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret against the stored hash. */
export function verifyClientSecret(secret: string, storedHash: string | null | undefined): boolean {
  if (!secret || !storedHash) return false;
  return timingSafeEqualString(hashClientSecret(secret), storedHash.trim().toLowerCase());
}

/**
 * Parse an `Authorization: OAuth k="v", k2="v2"` header into a params map.
 * Values are percent-decoded per RFC 5849 §3.5.1.
 */
export function parseOAuth1Header(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = header.replace(/^OAuth\s+/i, '');
  const re = /([a-zA-Z0-9_%.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = safeDecode(m[1]);
    if (key.toLowerCase() === 'realm') continue;
    params[key] = safeDecode(m[2]);
  }
  return params;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, '%2B'));
  } catch {
    return v;
  }
}

/** RFC 5849 §3.4.1.2: scheme/host lowercased, default ports dropped, no query. */
function normalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const host = u.hostname.toLowerCase();
  const port = u.port;
  const isDefault =
    !port || (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  return `${scheme}://${host}${isDefault ? '' : ':' + port}${u.pathname}`;
}

/** RFC 5849 §3.4.1.3: collect query + oauth_* params (minus signature), encode, sort, join. */
function normalizeParams(rawUrl: string, oauthParams: Record<string, string | undefined>): string {
  const pairs: Array<[string, string]> = [];
  const u = new URL(rawUrl);
  u.searchParams.forEach((value, key) => pairs.push([percentEncode(key), percentEncode(value)]));
  for (const [key, value] of Object.entries(oauthParams)) {
    if (key === 'oauth_signature' || key === 'realm' || value === undefined) continue;
    pairs.push([percentEncode(key), percentEncode(value)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Build the RFC 5849 §3.4.1.1 signature base string. */
export function buildSignatureBaseString(
  method: string,
  rawUrl: string,
  oauthParams: Record<string, string | undefined>
): string {
  return [
    method.toUpperCase(),
    percentEncode(normalizeUrl(rawUrl)),
    percentEncode(normalizeParams(rawUrl, oauthParams)),
  ].join('&');
}

/**
 * Compute an OAuth 1.0a HMAC-SHA1 signature for a request.
 * `params` should include the oauth_* parameters (excluding oauth_signature);
 * query-string parameters are read from `url`.
 */
export function generateOAuth1Signature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret = ''
): string {
  const base = buildSignatureBaseString(method, url, params);
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

// ---------------------------------------------------------------------------
// OAuth 1.0a verification
// ---------------------------------------------------------------------------

/**
 * Verify an OAuth 1.0a HMAC-SHA1 signed request.
 *
 * Returns the client principal on success, or null on any failure. Fails
 * closed when the plaintext consumer secret is unavailable (the schema only
 * stores `client_secret_hash`); use the Bearer token flow in that case.
 */
export async function verifyOAuth1Signature(
  method: string,
  url: string,
  params: OAuth1Params
): Promise<OneRosterPrincipal | null> {
  try {
    if (!params?.oauth_consumer_key || !params.oauth_signature || !params.oauth_timestamp || !params.oauth_nonce) {
      return null;
    }
    if ((params.oauth_signature_method || '').toUpperCase() !== 'HMAC-SHA1') {
      return null;
    }

    // Timestamp must be within ±5 minutes of server time.
    const ts = Number(params.oauth_timestamp);
    if (!Number.isFinite(ts)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > TIMESTAMP_WINDOW_SECONDS) return null;

    const supabase = createServiceSupabaseClient();
    const { data: client } = await supabase
      .from('oneroster_clients')
      .select('*')
      .eq('client_id', params.oauth_consumer_key)
      .eq('status', 'active')
      .maybeSingle();

    if (!client) return null;

    // The schema stores only a hash; HMAC needs the plaintext secret.
    const consumerSecret: string | undefined = (client as any).client_secret;
    if (!consumerSecret) {
      console.warn('[oneroster] OAuth 1.0a request rejected: no plaintext client_secret available; use the Bearer token flow');
      return null;
    }

    const expected = generateOAuth1Signature(method, url, params as Record<string, string>, consumerSecret);
    if (!timingSafeEqualString(expected, params.oauth_signature)) {
      return null;
    }

    // No oneroster nonce table exists in the schema, so nonce replay is not tracked.

    await supabase
      .from('oneroster_clients')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', client.id);

    return { client_id: client.client_id, scopes: client.allowed_scopes || [] };
  } catch (err) {
    console.error('[oneroster] OAuth 1.0a verification error', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth 2 client-credentials (Bearer JWT)
// ---------------------------------------------------------------------------

/**
 * Validate client_id/client_secret against `oneroster_clients` and return the
 * principal, or null when the credentials are invalid or the client inactive.
 */
export async function authenticateClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<(OneRosterPrincipal & { id: string }) | null> {
  if (!clientId || !clientSecret) return null;
  const supabase = createServiceSupabaseClient();
  const { data: client } = await supabase
    .from('oneroster_clients')
    .select('id, client_id, client_secret_hash, allowed_scopes, status')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .maybeSingle();

  if (!client || !verifyClientSecret(clientSecret, client.client_secret_hash)) {
    return null;
  }

  await supabase
    .from('oneroster_clients')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', client.id);

  return { id: client.id, client_id: client.client_id, scopes: client.allowed_scopes || [] };
}

/** Issue a signed access token for an authenticated client. */
export function issueOneRosterToken(principal: OneRosterPrincipal): { token: string; expiresIn: number } | null {
  const secret = jwtSecret();
  if (!secret) {
    console.error('[oneroster] No ONEROSTER_JWT_SECRET / SUPABASE_JWT_SECRET configured');
    return null;
  }
  const token = jwt.sign(
    { sub: principal.client_id, scopes: principal.scopes, typ: 'oneroster' },
    secret,
    { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
  );
  return { token, expiresIn: TOKEN_TTL_SECONDS };
}

/** Verify a Bearer token issued by issueOneRosterToken(). */
export function verifyOneRosterToken(token: string): OneRosterPrincipal | null {
  const secret = jwtSecret();
  if (!secret || !token) return null;
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload;
    if (!payload || typeof payload.sub !== 'string' || payload.typ !== 'oneroster') return null;
    return {
      client_id: payload.sub,
      scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((s: unknown) => typeof s === 'string') : [],
    };
  } catch {
    return null;
  }
}

/**
 * Authenticate an incoming OneRoster API request.
 * Accepts `Authorization: Bearer <jwt>` or `Authorization: OAuth ...`.
 */
export async function authenticateOneRosterRequest(request: NextRequest): Promise<OneRosterPrincipal | null> {
  const header = request.headers.get('authorization') || '';
  if (/^Bearer\s+/i.test(header)) {
    return verifyOneRosterToken(header.replace(/^Bearer\s+/i, '').trim());
  }
  if (/^OAuth\s+/i.test(header)) {
    const params = parseOAuth1Header(header);
    return verifyOAuth1Signature(request.method, request.url, params as unknown as OAuth1Params);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filter whitelist
// ---------------------------------------------------------------------------

/**
 * Allowed `filter` fields per endpoint, mapping OneRoster field names to the
 * underlying columns. Anything not listed is ignored.
 */
export const ONEROSTER_FILTER_FIELDS: Record<'orgs' | 'classes' | 'users' | 'enrollments', Record<string, string>> = {
  orgs: {
    sourcedId: 'sourced_id',
    status: 'status',
    name: 'name',
    identifier: 'identifier',
    type: 'type',
    parentSourcedId: 'parent_sourced_id',
  },
  classes: {
    sourcedId: 'sourced_id',
    status: 'status',
    title: 'title',
    classCode: 'class_code',
    classType: 'class_type',
    location: 'location',
    courseSourcedId: 'course_sourced_id',
    schoolSourcedId: 'school_sourced_id',
  },
  users: {
    sourcedId: 'sourced_id',
    status: 'status',
    username: 'username',
    givenName: 'given_name',
    familyName: 'family_name',
    middleName: 'middle_name',
    identifier: 'identifier',
    email: 'email',
    role: 'role',
  },
  enrollments: {
    sourcedId: 'sourced_id',
    status: 'status',
    userSourcedId: 'user_sourced_id',
    classSourcedId: 'class_sourced_id',
    role: 'role',
    primary: 'primary_flag',
  },
};

/**
 * Parse a OneRoster `filter` expression of the form `field='value'` and return
 * a safe column/value pair, or null if the field is not whitelisted.
 * snake_case column names are accepted as well as OneRoster camelCase names.
 */
export function parseOneRosterFilter(
  filter: string | null | undefined,
  endpoint: keyof typeof ONEROSTER_FILTER_FIELDS
): { column: string; value: string } | null {
  if (!filter) return null;
  const match = filter.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']{0,256})'\s*$/);
  if (!match) return null;
  const allowed = ONEROSTER_FILTER_FIELDS[endpoint];
  const column = allowed[match[1]] ?? (Object.values(allowed).includes(match[1]) ? match[1] : undefined);
  if (!column) return null;
  return { column, value: match[2] };
}
