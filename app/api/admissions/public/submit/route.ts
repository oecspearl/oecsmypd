import { NextRequest, NextResponse } from 'next/server';
import { submitApplication } from '@/lib/admissions/admission-service';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { badRequest, serverError, tooManyRequests } from '@/lib/api-errors';

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit({ key: `admissions-submit:${clientIp(request)}`, limit: 5, windowSeconds: 600 });
    if (!limited.ok) return tooManyRequests(limited.retryAfter);

    const { slug, applicant_name, applicant_email, applicant_phone, answers } = await request.json();

    if (!slug || !applicant_name || !applicant_email) {
      return badRequest('Slug, name, and email are required');
    }
    if (typeof applicant_name !== 'string' || applicant_name.length > 200) {
      return badRequest('Invalid name');
    }
    if (typeof applicant_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicant_email)) {
      return badRequest('Invalid email address');
    }

    const result = await submitApplication(
      slug,
      { name: applicant_name.trim(), email: applicant_email.trim(), phone: applicant_phone || null },
      Array.isArray(answers) ? answers : []
    );

    if (!result.success) {
      return badRequest(result.error || 'Submission failed');
    }

    // application_id is needed by the client to attach documents with the token.
    return NextResponse.json(
      { access_token: result.access_token, application_id: result.application_id },
      { status: 201 }
    );
  } catch (error) {
    return serverError('Failed to submit application', error);
  }
}
