import { NextRequest, NextResponse } from "next/server";

export function addSecurityHeaders(response: NextResponse): NextResponse {
  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  // Content Security Policy
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tiny.cloud; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co;"
  );
  
  return response;
}

export function validateCSRFToken(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');
  
  // For development, allow localhost
  if (process.env.NODE_ENV === 'development') {
    return origin?.includes('localhost') || referer?.includes('localhost') || false;
  }
  
  // In production, validate against your domain
  const allowedOrigins = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null
  ].filter(Boolean);
  
  return allowedOrigins.some(allowedOrigin => 
    origin === allowedOrigin || referer?.startsWith(allowedOrigin!)
  );
}

export function sanitizeInput(input: any): any {
  if (typeof input === 'string') {
    return input
      .trim()
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .substring(0, 1000); // Limit length
  }
  
  if (typeof input === 'object' && input !== null) {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof key === 'string' && key.length < 50) { // Limit key length
        sanitized[key] = sanitizeInput(value);
      }
    }
    return sanitized;
  }
  
  return input;
}

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

export function validateURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function generateNonce(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

export function createSecureResponse(data: any, status: number = 200): NextResponse {
  const response = NextResponse.json(data, { status });
  return addSecurityHeaders(response);
}

// ---------------------------------------------------------------------------
// PostgREST filter sanitisation
// ---------------------------------------------------------------------------

/**
 * Make a user-supplied value safe to interpolate into a PostgREST `.or()` /
 * `.filter()` expression. Strips the characters PostgREST uses as operators
 * or delimiters (`,` `(` `)` `.` `%` `*` `_` `\` and quotes) so the value can
 * never terminate the current condition or start a new one, and truncates it.
 */
export function sanitizeFilterValue(value: unknown, maxLength = 200): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[,().%*_\\"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Loose UUID v1–v5 check for values interpolated into filters. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Upload allowlist
// ---------------------------------------------------------------------------

/**
 * Extension -> canonical MIME type for files the platform will store.
 * Active content (html, htm, svg, js, exe, ...) is deliberately absent.
 */
export const ALLOWED_UPLOAD_TYPES: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
});

/** Alternative MIME types browsers commonly report for an allowed extension. */
const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  csv: ['application/csv', 'application/vnd.ms-excel', 'text/plain'],
  md: ['text/plain', 'text/x-markdown'],
  txt: ['text/plain'],
  jpg: ['image/jpg', 'image/pjpeg'],
  jpeg: ['image/jpg', 'image/pjpeg'],
  mp3: ['audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'],
  wav: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  m4a: ['audio/x-m4a', 'audio/m4a'],
  webm: ['audio/webm'],
  zip: ['application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip', 'application/octet-stream'],
  doc: ['application/octet-stream'],
  xls: ['application/octet-stream'],
  ppt: ['application/octet-stream'],
});

export interface UploadValidation {
  ok: boolean;
  /** Lower-cased, allowlisted extension (without the dot). */
  extension: string;
  /** Canonical MIME type from the allowlist; use this for storage `contentType`. */
  contentType: string;
  error?: string;
}

/** Lower-cased extension of a filename, or '' when there is none. */
export function fileExtension(name: string | null | undefined): string {
  if (!name) return '';
  const base = String(name).split(/[\\/]/).pop() || '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

/**
 * Validate an uploaded file against ALLOWED_UPLOAD_TYPES. Both the filename
 * extension and the declared MIME type must be acceptable; the returned
 * contentType is the canonical allowlisted value, never the client's claim.
 *
 * @param allowedExtensions optional subset of the allowlist (e.g. ['zip'] for SCORM).
 */
export function validateUpload(
  file: { name: string; type: string; size: number },
  allowedExtensions?: readonly string[]
): UploadValidation {
  const extension = fileExtension(file?.name);
  const fail = (error: string): UploadValidation => ({ ok: false, extension, contentType: '', error });

  if (!extension) return fail('File must have an extension');
  const canonical = ALLOWED_UPLOAD_TYPES[extension];
  if (!canonical) return fail(`File type .${extension} is not allowed`);
  if (allowedExtensions && !allowedExtensions.includes(extension)) {
    return fail(`Only ${allowedExtensions.map((e) => '.' + e).join(', ')} files are allowed`);
  }

  const declared = String(file?.type || '').toLowerCase().split(';')[0].trim();
  const acceptable = [canonical, ...(MIME_ALIASES[extension] || [])];
  // Some browsers omit the type entirely; the extension check still guards us.
  if (declared && !acceptable.includes(declared)) {
    return fail('File content type does not match its extension');
  }

  if (!file || typeof file.size !== 'number' || file.size <= 0) return fail('File is empty');

  return { ok: true, extension, contentType: canonical };
}

/**
 * Build a storage object name from a random UUID and an allowlisted extension.
 * The client-supplied filename is never used for the storage key.
 */
export function safeStorageFilename(extension: string): string {
  const ext = String(extension).toLowerCase().replace(/[^a-z0-9]/g, '');
  const uuid = (globalThis.crypto?.randomUUID?.() as string | undefined) || require('crypto').randomUUID();
  return ext ? `${uuid}.${ext}` : uuid;
}

/** Trim a client-supplied display name so it is safe to store and echo back. */
export function safeDisplayFilename(name: string | null | undefined, maxLength = 255): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, maxLength) || 'file';
}

// ---------------------------------------------------------------------------
// Opaque HMAC tokens (e.g. anonymous survey response ownership)
// ---------------------------------------------------------------------------

function opaqueTokenSecret(): string | null {
  return (
    process.env.OPAQUE_TOKEN_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null
  );
}

/**
 * Sign an identifier for a given purpose. The resulting token proves the
 * bearer was handed `id` by the server (it cannot be forged without the secret).
 */
export function signOpaqueToken(purpose: string, id: string): string | null {
  const secret = opaqueTokenSecret();
  if (!secret) return null;
  const { createHmac } = require('crypto') as typeof import('crypto');
  return createHmac('sha256', secret).update(`${purpose}:${id}`).digest('base64url');
}

/** Constant-time verification of a token produced by signOpaqueToken(). */
export function verifyOpaqueToken(purpose: string, id: string, token: string | null | undefined): boolean {
  if (!token || !id) return false;
  const expected = signOpaqueToken(purpose, id);
  if (!expected) return false;
  const { timingSafeEqual } = require('crypto') as typeof import('crypto');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}
