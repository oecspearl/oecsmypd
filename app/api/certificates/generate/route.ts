import { NextRequest, NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { getCurrentUser } from '@/lib/database-helpers';
import { getCourseAccess } from '@/lib/course-access';
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/api-errors';
import { recomputeCourseCompletion } from '@/lib/certificates/completion';
import { generateCertificatePDF, getCertificateTemplate, uploadCertificatePDF } from '@/lib/certificates/generator';
import { generate_verification_code } from '@/lib/certificates/helpers';

/**
 * Weighted final grade across the student's course_grades rows.
 * Weights come from course_grade_items.weight (equal weights when absent or
 * all zero). Returns null only when there are no grades at all; a legitimate
 * 0% is preserved.
 */
function computeFinalGrade(
  grades: Array<{ percentage: unknown; grade_item?: { weight?: unknown; is_active?: unknown } | null }>
): number | null {
  const rows = grades
    .map((g) => {
      const pct = Number(g.percentage);
      const w = Number(g.grade_item?.weight);
      return {
        pct: Number.isFinite(pct) ? pct : null,
        weight: Number.isFinite(w) && w > 0 ? w : null,
        active: g.grade_item?.is_active !== false,
      };
    })
    .filter((r) => r.pct !== null && r.active) as Array<{ pct: number; weight: number | null }>;

  if (rows.length === 0) return null;

  const allWeighted = rows.every((r) => r.weight !== null);
  if (allWeighted) {
    const totalWeight = rows.reduce((s, r) => s + (r.weight as number), 0);
    if (totalWeight > 0) {
      return rows.reduce((s, r) => s + r.pct * (r.weight as number), 0) / totalWeight;
    }
  }
  // Fall back to equal weights.
  return rows.reduce((s, r) => s + r.pct, 0) / rows.length;
}

/**
 * POST /api/certificates/generate
 * Generate a certificate for a student upon course completion
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return unauthorized();
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }
    const { studentId, courseId, templateId, forceRegenerate } = body || {};

    if (!studentId || !courseId || typeof studentId !== 'string' || typeof courseId !== 'string') {
      return badRequest('studentId and courseId are required');
    }

    // Permissions: a student may generate their own; course managers
    // (admin, owner, co-instructor) and curriculum designers may generate for anyone.
    const isOwnCertificate = user.id === studentId;
    const access = await getCourseAccess(user.id, user.role, courseId);
    if (!access.courseExists) {
      return notFound('Course not found');
    }
    const canManage = access.canManage || user.role === 'curriculum_designer';

    if (!isOwnCertificate && !canManage) {
      return forbidden();
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Check if certificate already exists
    const { data: existingCert } = await serviceSupabase
      .from('certificates')
      .select('id, pdf_url')
      .eq('student_id', studentId)
      .eq('course_id', courseId)
      .maybeSingle();

    if (existingCert && !forceRegenerate) {
      return NextResponse.json({
        message: 'Certificate already exists',
        certificate: existingCert,
        alreadyExists: true
      });
    }

    // Verify course completion
    let { data: enrollment } = await serviceSupabase
      .from('enrollments')
      .select('id, status, completed_at, progress_percentage')
      .eq('student_id', studentId)
      .eq('course_id', courseId)
      .maybeSingle();

    if (!enrollment) {
      return notFound('Enrollment not found');
    }

    if (enrollment.status !== 'completed') {
      // The enrollment may not have been promoted yet (e.g. progress written
      // before this bookkeeping existed). Recompute; this promotes an 'active'
      // enrollment to 'completed' as a side effect when progress is 100%.
      const completion = await recomputeCourseCompletion(studentId, courseId);
      if (!completion.enrollmentCompleted) {
        return badRequest('Course not completed yet');
      }
      const { data: refreshed } = await serviceSupabase
        .from('enrollments')
        .select('id, status, completed_at, progress_percentage')
        .eq('student_id', studentId)
        .eq('course_id', courseId)
        .maybeSingle();
      if (!refreshed || refreshed.status !== 'completed') {
        return badRequest('Course not completed yet');
      }
      enrollment = refreshed;
    }

    // Get course and student details
    const [courseResult, studentResult] = await Promise.all([
      serviceSupabase
        .from('courses')
        .select('title, ceu_credits, credit_type')
        .eq('id', courseId)
        .maybeSingle(),
      serviceSupabase
        .from('users')
        .select('name, email')
        .eq('id', studentId)
        .maybeSingle()
    ]);

    if (courseResult.error || !courseResult.data) {
      return notFound('Course not found');
    }

    if (studentResult.error || !studentResult.data) {
      return notFound('Student not found');
    }

    // Calculate final grade if gradebook exists (weighted by grade item weight)
    const { data: grades } = await serviceSupabase
      .from('course_grades')
      .select('percentage, grade_item:course_grade_items(weight, is_active)')
      .eq('student_id', studentId)
      .eq('course_id', courseId);

    const gradePercentage = computeFinalGrade(
      ((grades || []) as any[]).map((g) => ({
        percentage: g.percentage,
        grade_item: Array.isArray(g.grade_item) ? g.grade_item[0] : g.grade_item,
      }))
    );
    const roundedGrade = typeof gradePercentage === 'number' ? Math.round(gradePercentage) : null;

    // Get template
    const template = await getCertificateTemplate(templateId);

    // Generate verification code
    const verificationCode = await generate_verification_code();

    const completionDateIso = enrollment.completed_at || new Date().toISOString();

    // Generate certificate PDF
    const certificateData = {
      studentName: studentResult.data.name,
      courseName: courseResult.data.title,
      completionDate: new Date(completionDateIso).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      gradePercentage: typeof roundedGrade === 'number' ? roundedGrade : undefined,
      verificationCode,
      logoUrl: template.logo_url || undefined
    };

    const pdfBuffer = await generateCertificatePDF(certificateData, template.template_html);

    // Upload PDF to storage
    let pdfUrl: string;
    try {
      pdfUrl = await uploadCertificatePDF(pdfBuffer, studentId, courseId, 'temp');
    } catch (storageError: any) {
      console.error('Storage upload error:', storageError);
      // Continue without storage - store PDF in database later or handle differently
      pdfUrl = '';
    }

    const issuedAt = new Date().toISOString();
    const certificateRow = {
      student_id: studentId,
      course_id: courseId,
      template_id: template.id,
      verification_code: verificationCode,
      issued_at: issuedAt,
      pdf_url: pdfUrl,
      grade_percentage: roundedGrade,
      metadata: {
        course_title: courseResult.data.title,
        student_name: studentResult.data.name,
        completion_date: completionDateIso
      },
      updated_at: issuedAt
    };

    // Create (or, on forceRegenerate, replace) the certificate record.
    // certificates has UNIQUE(student_id, course_id).
    const { data: certificate, error: certError } = existingCert
      ? await serviceSupabase
          .from('certificates')
          .update(certificateRow)
          .eq('id', existingCert.id)
          .select()
          .single()
      : await serviceSupabase
          .from('certificates')
          .upsert([certificateRow], { onConflict: 'student_id,course_id' })
          .select()
          .single();

    if (certError || !certificate) {
      return serverError('Failed to create certificate record', certError);
    }

    // Update PDF URL with actual certificate ID now that we have it
    if (pdfUrl && certificate.id) {
      try {
        const finalPdfUrl = await uploadCertificatePDF(pdfBuffer, studentId, courseId, certificate.id);
        await serviceSupabase
          .from('certificates')
          .update({ pdf_url: finalPdfUrl })
          .eq('id', certificate.id);
        certificate.pdf_url = finalPdfUrl;
      } catch (err) {
        console.error('Error updating certificate PDF URL:', err);
      }
    }

    // Record CEU credits if course has credits
    const ceuCredits = Number(courseResult.data.ceu_credits);
    if (Number.isFinite(ceuCredits) && ceuCredits > 0) {
      const { error: ceuError } = await serviceSupabase
        .from('ceu_credits')
        .upsert([{
          student_id: studentId,
          course_id: courseId,
          credits: ceuCredits,
          credit_type: courseResult.data.credit_type || 'CEU',
          certificate_id: certificate.id,
          issued_at: issuedAt
        }], {
          onConflict: 'student_id,course_id,credit_type'
        });
      if (ceuError) {
        console.error('Error recording CEU credits:', ceuError);
      }
    }

    return NextResponse.json({
      message: existingCert ? 'Certificate regenerated successfully' : 'Certificate generated successfully',
      certificate
    });

  } catch (error) {
    return serverError('Failed to generate certificate', error);
  }
}
