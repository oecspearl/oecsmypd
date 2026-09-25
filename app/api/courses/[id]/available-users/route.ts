import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { hasRole } from "@/lib/database-helpers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }
    const { userProfile } = authResult;
    const { id } = await params;
    const courseId = id;

    // Check if user has admin or instructor privileges
    if (!hasRole(userProfile.role, ['admin', 'super_admin', 'instructor', 'curriculum_designer'])) {
      return createAuthResponse("Forbidden", 403);
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Get all enrolled student IDs for this course
    const { data: enrollments, error: enrollmentsError } = await serviceSupabase
      .from('enrollments')
      .select('student_id')
      .eq('course_id', courseId);

    if (enrollmentsError) {
      console.error('Error fetching enrollments:', enrollmentsError);
      return NextResponse.json({ error: 'Failed to fetch enrollments' }, { status: 500 });
    }

    const enrolledUserIds = enrollments?.map(e => e.student_id) || [];

    // Get all users (excluding admins and instructors by default)
    // For now, let's get all students and other non-admin roles
    const { data: users, error: usersError } = await serviceSupabase
      .from('users')
      .select(`
        id,
        email,
        name,
        role
      `)
      .neq('role', 'super_admin')
      .neq('role', 'admin')
      .order('name', { ascending: true });

    if (usersError) {
      console.error('Error fetching users:', usersError);
      return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
    }

    // Filter out already enrolled users and format the response
    const availableUsers = (users || [])
      .filter(user => !enrolledUserIds.includes(user.id))
      .map(user => ({
        id: user.id,
        email: user.email,
        name: user.name || user.email,
        role: user.role
      }));

    return NextResponse.json({ users: availableUsers });

  } catch (error) {
    console.error('Error in available users endpoint:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
