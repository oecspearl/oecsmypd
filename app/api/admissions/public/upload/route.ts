import { NextRequest, NextResponse } from 'next/server';
import { uploadDocument } from '@/lib/admissions/admission-service';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { tooManyRequests, badRequest, unauthorized, serverError } from '@/lib/api-errors';
import { isUuid } from '@/lib/security';

/**
 * POST /api/admissions/public/upload
 *
 * Multipart fields: file, application_id, field_id, token.
 * The caller must present the application's access token (the same tracking
 * token used by /api/admissions/public/status) either as the `token` form
 * field or an `X-Application-Token` header; the document is bound to that
 * application only.
 */
export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit({ key: `admissions-upload:${clientIp(request)}`, limit: 20, windowSeconds: 600 });
    if (!limited.ok) return tooManyRequests(limited.retryAfter);

    const formData = await request.formData();
    const file = formData.get('file');
    const applicationId = formData.get('application_id');
    const fieldId = formData.get('field_id');
    const token =
      (typeof formData.get('token') === 'string' ? (formData.get('token') as string) : '') ||
      request.headers.get('x-application-token') ||
      '';

    if (!(file instanceof File) || typeof applicationId !== 'string' || typeof fieldId !== 'string') {
      return badRequest('file, application_id, and field_id are required');
    }
    if (!isUuid(applicationId) || !isUuid(fieldId)) {
      return badRequest('Documents can only be uploaded for a submitted application');
    }
    if (!token) return unauthorized('Application token is required');

    if (file.size > 10 * 1024 * 1024) {
      return badRequest('File size exceeds 10MB limit');
    }

    // Bind the upload to the application that owns this token.
    const supabase = createServiceSupabaseClient();
    const { data: application } = await supabase
      .from('admission_applications')
      .select('id')
      .eq('id', applicationId)
      .eq('access_token', token)
      .maybeSingle();
    if (!application) return unauthorized('Invalid application token');

    const result = await uploadDocument(application.id, fieldId, file);
    if (!result.success) return badRequest(result.error || 'Upload failed');

    return NextResponse.json({ document: result.document }, { status: 201 });
  } catch (error) {
    return serverError('Upload failed', error);
  }
}
