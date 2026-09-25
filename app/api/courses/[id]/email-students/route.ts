import { NextRequest, NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { getCurrentUser } from '@/lib/database-helpers';
import { hasRole } from '@/lib/rbac';
import { isUuid } from '@/lib/security';
import { rateLimit } from '@/lib/rate-limit';
import { tooManyRequests } from '@/lib/api-errors';
import { sendBulkEmail, wrapEmailTemplate } from '@/lib/email-service';

// Sending is throttled to ~1.6 emails/second; allow up to ~450 recipients.
export const maxDuration = 300;

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 10_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * POST /api/courses/[id]/email-students
 * Body: { subject, message, include_inactive?: boolean }
 *
 * Emails every enrolled student in the course. Allowed for the course's
 * instructors and for admins / curriculum designers. Honours each student's
 * "email notifications" preference and logs every attempt to
 * email_notifications (type "course_message").
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: courseId } = await params;
    if (!isUuid(courseId)) return NextResponse.json({ error: 'Invalid course id' }, { status: 400 });

    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const service = createServiceSupabaseClient();
    const isAdmin = hasRole(user.role, ['admin', 'super_admin', 'curriculum_designer']);
    let allowed = isAdmin;
    if (!allowed && hasRole(user.role, ['instructor'])) {
      const { data: ci } = await service
        .from('course_instructors')
        .select('id')
        .eq('course_id', courseId)
        .eq('instructor_id', user.id)
        .maybeSingle();
      allowed = Boolean(ci);
    }
    if (!allowed) return NextResponse.json({ error: 'Only instructors of this course and admins can email its students' }, { status: 403 });

    // One send per course per 10 minutes per user guards against double clicks.
    const limit = await rateLimit({ key: `course-email:${user.id}:${courseId}`, limit: 3, windowSeconds: 600 });
    if (!limit.ok) return tooManyRequests(limit.retryAfter);

    const body = await request.json().catch(() => ({}));
    const subject = String(body.subject || '').trim().slice(0, MAX_SUBJECT);
    const message = String(body.message || '').trim().slice(0, MAX_MESSAGE);
    const includeInactive = Boolean(body.include_inactive);
    if (!subject) return NextResponse.json({ error: 'Subject is required' }, { status: 400 });
    if (!message) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

    const { data: course } = await service.from('courses').select('id, title').eq('id', courseId).single();
    if (!course) return NextResponse.json({ error: 'Course not found' }, { status: 404 });

    // --- Recipients -----------------------------------------------------------
    let enrollmentsQuery = service.from('enrollments').select('student_id, status').eq('course_id', courseId);
    enrollmentsQuery = includeInactive ? enrollmentsQuery.in('status', ['active', 'completed']) : enrollmentsQuery.eq('status', 'active');
    const { data: enrollments, error: enrollError } = await enrollmentsQuery;
    if (enrollError) return NextResponse.json({ error: 'Failed to load enrolments' }, { status: 500 });

    const studentIds = Array.from(new Set((enrollments || []).map((e: any) => e.student_id).filter(Boolean)));
    if (studentIds.length === 0) {
      return NextResponse.json({ success: true, sent: 0, failed: 0, skipped: 0, total: 0, message: 'No enrolled students to email.' });
    }

    const { data: students } = await service.from('users').select('id, name, email').in('id', studentIds);
    const { data: prefs } = await service.from('notification_preferences').select('user_id, email_enabled').in('user_id', studentIds);
    const optedOut = new Set((prefs || []).filter((p: any) => p.email_enabled === false).map((p: any) => p.user_id));

    const recipients = (students || []).filter((s: any) => s.email && !optedOut.has(s.id));
    const skipped = studentIds.length - recipients.length;

    // --- Content --------------------------------------------------------------
    const senderName = (user as any).name || (user as any).email || 'Your instructor';
    const htmlMessage = message
      .split('\n')
      .map((line) => `<p style="margin:0 0 10px 0;">${escapeHtml(line) || '&nbsp;'}</p>`)
      .join('');
    const courseUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://oecsmypd.org'}/course/${courseId}`;

    const html = wrapEmailTemplate(
      `<div style="color:#333333; line-height:1.6;">
        <p style="margin:0 0 16px 0;">Hello {{name}},</p>
        ${htmlMessage}
        <p style="margin:24px 0 0 0;">
          <a href="${courseUrl}" style="display:inline-block; background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold;">Open ${escapeHtml(course.title)}</a>
        </p>
        <p style="margin:24px 0 0 0; color:#6b7280; font-size:13px;">Sent by ${escapeHtml(senderName)} to students enrolled in ${escapeHtml(course.title)}.</p>
      </div>`,
      { title: subject }
    );
    const text = `Hello {{name}},\n\n${message}\n\nOpen ${course.title}: ${courseUrl}\n\nSent by ${senderName} to students enrolled in ${course.title}.`;

    // --- Send (throttled inside sendBulkEmail) --------------------------------
    const results = await sendBulkEmail(
      recipients.map((s: any) => ({ email: s.email, variables: { name: s.name || 'Student', email: s.email } })),
      { subject, html, text },
      { tags: [{ name: 'category', value: 'course-email' }, { name: 'course_id', value: courseId }] }
    );

    // --- Log ------------------------------------------------------------------
    const byEmail = new Map(recipients.map((s: any) => [s.email, s.id]));
    const logRows = results.map((r) => ({
      user_id: byEmail.get(r.email),
      type: 'course_message',
      subject,
      body_text: message,
      status: r.success ? 'sent' : 'failed',
      sent_at: r.success ? new Date().toISOString() : null,
      error_message: r.error || null,
      metadata: { course_id: courseId, sender_id: user.id },
    })).filter((r) => r.user_id);
    if (logRows.length > 0) {
      const { error: logError } = await service.from('email_notifications').insert(logRows);
      if (logError) console.error('[course-email] log insert failed:', logError.code, logError.message);
    }

    const sent = results.filter((r) => r.success).length;
    const failed = results.length - sent;
    console.log(`[course-email] ${user.id} → course ${courseId}: ${sent} sent, ${failed} failed, ${skipped} skipped`);

    return NextResponse.json({
      success: true,
      sent,
      failed,
      skipped,
      total: studentIds.length,
      errors: results.filter((r) => !r.success && r.error).map((r) => r.error).slice(0, 5),
    });
  } catch (error) {
    console.error('[course-email] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
