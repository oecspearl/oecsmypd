import { NextRequest, NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { authenticateUser } from '@/lib/api-auth';
import { getCourseAccess } from '@/lib/course-access';
import { unauthorized, forbidden, notFound, badRequest, conflict, serverError, fromDbError } from '@/lib/api-errors';
import { isUuid } from '@/lib/security';

const FULL_ENROLLMENT_COLUMNS = `
  id,
  student_id,
  status,
  enrolled_at,
  course_id,
  progress_percentage,
  completed_at,
  student_name,
  student_email,
  student_role,
  student_bio,
  student_avatar,
  learning_preferences,
  user_created_at,
  profile_created_at,
  updated_at
`;

/**
 * GET /api/courses/[id]/participants
 *
 * Managers (admins, course owner, co-instructors) receive the full roster.
 * Enrolled students receive a minimal directory (id, name, avatar, role) and
 * never see email, bio or learning preferences unless the course's settings
 * explicitly enable `participants_show_email`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  try {
    const { id: courseId } = await params;
    if (!courseId || !isUuid(courseId)) return badRequest('Invalid course ID format');

    const auth = await authenticateUser(request);
    if (!auth.success || !auth.user || !auth.userProfile) return unauthorized();

    const access = await getCourseAccess(auth.user.id, auth.userProfile.role, courseId);
    if (!access.courseExists) return notFound('Course not found');
    if (!access.canView) return forbidden();

    const serviceSupabase = createServiceSupabaseClient();

    const { data: courseRow, error: courseError } = await serviceSupabase
      .from('courses')
      .select('*')
      .eq('id', courseId)
      .single();
    if (courseError || !courseRow) return notFound('Course not found');

    const course = {
      id: courseRow.id,
      title: courseRow.title,
      description: courseRow.description ?? null,
      instructor_id: courseRow.instructor_id ?? null,
    };

    const { data: participants, error: participantsError } = await serviceSupabase
      .from('enrollments')
      .select(FULL_ENROLLMENT_COLUMNS)
      .eq('course_id', courseId)
      .order('enrolled_at', { ascending: false });

    if (participantsError) return fromDbError(participantsError, 'Failed to fetch participants');

    let roster: any[] = Array.isArray(participants) ? participants : [];

    // Enrich rows whose denormalised user fields are missing.
    const needsEnrichment = roster.filter((p) => !p.student_name || !p.student_email);
    if (needsEnrichment.length > 0) {
      const studentIds = needsEnrichment.map((p) => p.student_id).filter((id): id is string => !!id);
      if (studentIds.length > 0) {
        const [{ data: users }, { data: profiles }] = await Promise.all([
          serviceSupabase.from('users').select('id, name, email, role, created_at').in('id', studentIds),
          serviceSupabase.from('user_profiles').select('user_id, bio, avatar, learning_preferences, created_at').in('user_id', studentIds),
        ]);
        const userMap = new Map((users || []).map((u: any) => [u.id, u]));
        const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p]));
        roster = roster.map((participant) => {
          const user: any = userMap.get(participant.student_id);
          const profile: any = profileMap.get(participant.student_id);
          if (!user) return participant;
          return {
            ...participant,
            student_name: participant.student_name || user.name || 'Unknown Student',
            student_email: participant.student_email || user.email || null,
            student_role: participant.student_role || user.role || 'student',
            student_bio: participant.student_bio || profile?.bio || null,
            student_avatar: participant.student_avatar || profile?.avatar || null,
            learning_preferences: participant.learning_preferences || profile?.learning_preferences || {},
            user_created_at: participant.user_created_at || user.created_at || null,
            profile_created_at: participant.profile_created_at || profile?.created_at || null,
          };
        });
      }
    }

    if (!access.canManage) {
      const settings = (courseRow.settings && typeof courseRow.settings === 'object') ? courseRow.settings : {};
      const showEmail = settings.participants_show_email === true;
      roster = roster
        .filter((p) => p.status === 'active' || p.status === 'completed')
        .map((p) => ({
          id: p.id,
          name: p.student_name || 'Student',
          avatar: p.student_avatar || null,
          role: p.student_role || 'student',
          // Aliases kept for the existing participants page.
          student_name: p.student_name || 'Student',
          student_avatar: p.student_avatar || null,
          student_role: p.student_role || 'student',
          status: p.status,
          ...(showEmail ? { email: p.student_email || null, student_email: p.student_email || null } : {}),
        }));
    }

    return NextResponse.json({
      course,
      participants: roster,
      meta: {
        count: roster.length,
        canManage: access.canManage,
        responseTime: `${Date.now() - startTime}ms`,
      },
    });
  } catch (error) {
    return serverError('Failed to fetch participants', error);
  }
}

/**
 * POST /api/courses/[id]/participants
 * Enrol a student by email. Managers only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: courseId } = await params;
    if (!courseId || !isUuid(courseId)) return badRequest('Invalid course ID format');

    let requestBody: any;
    try {
      requestBody = await request.json();
    } catch {
      return badRequest('Invalid JSON in request body');
    }

    const studentEmail = typeof requestBody?.studentEmail === 'string' ? requestBody.studentEmail.trim() : '';
    if (!studentEmail) return badRequest('Student email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail) || studentEmail.length > 254) {
      return badRequest('Invalid email format');
    }

    const auth = await authenticateUser(request);
    if (!auth.success || !auth.user || !auth.userProfile) return unauthorized();

    const access = await getCourseAccess(auth.user.id, auth.userProfile.role, courseId);
    if (!access.courseExists) return notFound('Course not found');
    if (!access.canManage) return forbidden();

    const serviceSupabase = createServiceSupabaseClient();

    const { data: student, error: studentError } = await serviceSupabase
      .from('users')
      .select('id, email, name, role, created_at')
      .ilike('email', studentEmail)
      .maybeSingle();

    if (studentError) return fromDbError(studentError, 'Failed to lookup student');
    if (!student) {
      return notFound('Student not found. Please make sure the student has an account in the system.');
    }

    const { data: existingEnrollment, error: existingError } = await serviceSupabase
      .from('enrollments')
      .select('id, status')
      .eq('course_id', courseId)
      .eq('student_id', student.id)
      .maybeSingle();

    if (existingError) return fromDbError(existingError, 'Failed to check existing enrollment');
    if (existingEnrollment) return conflict('Student is already enrolled in this course');

    const { data: studentProfile } = await serviceSupabase
      .from('user_profiles')
      .select('bio, avatar, learning_preferences, created_at')
      .eq('user_id', student.id)
      .maybeSingle();

    const enrollmentData = {
      course_id: courseId,
      student_id: student.id,
      status: 'active',
      enrolled_at: new Date().toISOString(),
      student_name: student.name,
      student_email: student.email,
      student_role: student.role,
      student_bio: studentProfile?.bio || null,
      student_avatar: studentProfile?.avatar || null,
      learning_preferences: studentProfile?.learning_preferences || {},
      user_created_at: student.created_at,
      profile_created_at: studentProfile?.created_at || null,
    };

    const { data: enrollment, error: enrollmentError } = await serviceSupabase
      .from('enrollments')
      .insert(enrollmentData)
      .select(FULL_ENROLLMENT_COLUMNS)
      .single();

    if (enrollmentError) return fromDbError(enrollmentError, 'Failed to enroll student');
    if (!enrollment) return serverError('Failed to create enrollment');

    return NextResponse.json({ message: 'Student enrolled successfully', enrollment });
  } catch (error) {
    return serverError('Failed to enroll student', error);
  }
}
