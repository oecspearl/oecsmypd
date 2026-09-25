import { NextRequest, NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { authenticateUser } from '@/lib/api-auth';
import { getCourseAccess } from '@/lib/course-access';
import { unauthorized, forbidden, notFound, serverError, fromDbError } from '@/lib/api-errors';

/** Admins, the course owner, co-instructors and curriculum designers may manage the roster. */
async function requireManager(request: NextRequest, courseId: string) {
  const auth = await authenticateUser(request);
  if (!auth.success || !auth.user || !auth.userProfile) return { response: unauthorized() };
  const access = await getCourseAccess(auth.user.id, auth.userProfile.role, courseId);
  if (!access.courseExists) return { response: notFound('Course not found') };
  if (!access.canManage && auth.userProfile.role !== 'curriculum_designer') return { response: forbidden() };
  return { user: auth.user, userProfile: auth.userProfile };
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> }
) {
  const startTime = Date.now();
  const { id, participantId: participantIdParam } = await params;
  const courseId = id;
  const participantId = participantIdParam;
  
  // Validate parameters
  if (!courseId || typeof courseId !== 'string') {
    console.error('Invalid course ID for DELETE:', { courseId, type: typeof courseId });
    return NextResponse.json({ 
      error: 'Invalid course ID format' 
    }, { status: 400 });
  }

  if (!participantId || typeof participantId !== 'string') {
    console.error('Invalid participant ID for DELETE:', { participantId, type: typeof participantId });
    return NextResponse.json({ 
      error: 'Invalid participant ID format' 
    }, { status: 400 });
  }

  try {
    console.log('Starting drop participant:', { courseId, participantId });
    
    const gate = await requireManager(request, courseId);
    if ('response' in gate) return gate.response;

    const supabase = createServiceSupabaseClient();

    // Verify the enrollment exists and belongs to this course
    const { data: enrollment, error: enrollmentError } = await supabase
      .from('enrollments')
      .select('id, student_id, course_id, status')
      .eq('id', participantId)
      .eq('course_id', courseId)
      .single();

    if (enrollmentError) {
      console.error('Database error finding enrollment:', {
        error: enrollmentError,
        participantId,
        courseId,
        code: enrollmentError.code,
        message: enrollmentError.message
      });
      
      if (enrollmentError.code === 'PGRST116') {
        return NextResponse.json({ 
          error: 'Enrollment not found' 
        }, { status: 404 });
      }
      
      return fromDbError(enrollmentError, 'Failed to verify enrollment');
    }

    if (!enrollment) {
      console.error('Enrollment not found:', { participantId, courseId });
      return NextResponse.json({ 
        error: 'Enrollment not found' 
      }, { status: 404 });
    }

    console.log('Enrollment found, dropping participant:', {
      enrollmentId: enrollment.id,
      studentId: enrollment.student_id,
      status: enrollment.status
    });

    // Delete the enrollment
    const { error: deleteError } = await supabase
      .from('enrollments')
      .delete()
      .eq('id', participantId);

    if (deleteError) {
      console.error('Database error dropping participant:', {
        error: deleteError,
        participantId,
        courseId,
        code: deleteError.code,
        message: deleteError.message
      });
      return fromDbError(deleteError, 'Failed to drop participant');
    }

    const responseTime = Date.now() - startTime;
    console.log(`Participant dropped successfully in ${responseTime}ms:`, {
      participantId,
      courseId
    });

    return NextResponse.json({
      message: 'Participant dropped successfully',
      meta: {
        responseTime: `${responseTime}ms`
      }
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('Drop Participant API Error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      courseId,
      participantId,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
    return serverError('Internal server error', error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> }
) {
  const startTime = Date.now();
  const { id, participantId: participantIdParam } = await params;
  const courseId = id;
  const participantId = participantIdParam;
  
  // Validate parameters
  if (!courseId || typeof courseId !== 'string') {
    console.error('Invalid course ID for PUT:', { courseId, type: typeof courseId });
    return NextResponse.json({ 
      error: 'Invalid course ID format' 
    }, { status: 400 });
  }

  if (!participantId || typeof participantId !== 'string') {
    console.error('Invalid participant ID for PUT:', { participantId, type: typeof participantId });
    return NextResponse.json({ 
      error: 'Invalid participant ID format' 
    }, { status: 400 });
  }

  try {
    console.log('Starting update participant:', { courseId, participantId });
    
    // Parse and validate request body
    let requestBody;
    try {
      requestBody = await request.json();
    } catch (parseError) {
      console.error('Invalid JSON in request body for PUT:', parseError);
      return NextResponse.json({ 
        error: 'Invalid JSON in request body' 
      }, { status: 400 });
    }

    const { status, progress_percentage } = requestBody;

    // Validate status if provided
    if (status !== undefined && !['active', 'inactive', 'completed', 'dropped'].includes(status)) {
      console.error('Invalid status value:', status);
      return NextResponse.json({ 
        error: 'Invalid status. Must be one of: active, inactive, completed, dropped' 
      }, { status: 400 });
    }

    // Validate progress_percentage if provided
    if (progress_percentage !== undefined) {
      if (typeof progress_percentage !== 'number' || progress_percentage < 0 || progress_percentage > 100) {
        console.error('Invalid progress_percentage:', progress_percentage);
        return NextResponse.json({ 
          error: 'Progress percentage must be a number between 0 and 100' 
        }, { status: 400 });
      }
    }

    const gate = await requireManager(request, courseId);
    if ('response' in gate) return gate.response;

    const supabase = createServiceSupabaseClient();

    // Verify the enrollment exists and belongs to this course
    const { data: enrollment, error: enrollmentError } = await supabase
      .from('enrollments')
      .select('id, student_id, course_id, status, progress_percentage')
      .eq('id', participantId)
      .eq('course_id', courseId)
      .single();

    if (enrollmentError) {
      console.error('Database error finding enrollment for PUT:', {
        error: enrollmentError,
        participantId,
        courseId,
        code: enrollmentError.code,
        message: enrollmentError.message
      });
      
      if (enrollmentError.code === 'PGRST116') {
        return NextResponse.json({ 
          error: 'Enrollment not found' 
        }, { status: 404 });
      }
      
      return fromDbError(enrollmentError, 'Failed to verify enrollment');
    }

    if (!enrollment) {
      console.error('Enrollment not found for PUT:', { participantId, courseId });
      return NextResponse.json({ 
        error: 'Enrollment not found' 
      }, { status: 404 });
    }

    console.log('Enrollment found, updating participant:', {
      enrollmentId: enrollment.id,
      currentStatus: enrollment.status,
      currentProgress: enrollment.progress_percentage,
      newStatus: status,
      newProgress: progress_percentage
    });

    // Update the enrollment
    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (progress_percentage !== undefined) updateData.progress_percentage = progress_percentage;
    
    if (status === 'completed') {
      updateData.completed_at = new Date().toISOString();
    }

    // Check if there are any updates to make
    if (Object.keys(updateData).length === 0) {
      console.log('No updates to make');
      return NextResponse.json({ 
        message: 'No updates provided' 
      });
    }

    const { error: updateError } = await supabase
      .from('enrollments')
      .update(updateData)
      .eq('id', participantId);
    
    // Trigger certificate generation if course is completed
    if (status === 'completed' && !updateError) {
      // Generate certificate in background (don't wait for it)
      (async () => {
        try {
          const generateUrl = new URL('/api/certificates/generate', request.url);
          await fetch(generateUrl.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': request.headers.get('authorization') || ''
            },
            body: JSON.stringify({
              studentId: enrollment.student_id,
              courseId: courseId
            })
          });
          console.log(`Certificate generation triggered for student ${enrollment.student_id}, course ${courseId}`);
        } catch (certError) {
          console.error('Error triggering certificate generation:', certError);
          // Don't fail the enrollment update if certificate generation fails
        }
      })();
    }

    if (updateError) {
      console.error('Database error updating participant:', {
        error: updateError,
        updateData,
        participantId,
        courseId,
        code: updateError.code,
        message: updateError.message
      });
      return fromDbError(updateError, 'Failed to update participant');
    }

    const responseTime = Date.now() - startTime;
    console.log(`Participant updated successfully in ${responseTime}ms:`, {
      participantId,
      courseId,
      updates: updateData
    });

    return NextResponse.json({
      message: 'Participant updated successfully',
      updates: updateData,
      meta: {
        responseTime: `${responseTime}ms`
      }
    });

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error('Update Participant API Error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      courseId,
      participantId,
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });
    
    return serverError('Internal server error', error);
  }
}
