import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { authenticateUser, createAuthResponse } from "@/lib/api-auth";
import { hasRole } from "@/lib/database-helpers";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { status } = await request.json();

    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }
    const { userProfile } = authResult;

    // Check if user has admin privileges
    if (!hasRole(userProfile.role, ['admin', 'super_admin'])) {
      return createAuthResponse("Forbidden: Admin access required", 403);
    }

    if (!status) {
      return NextResponse.json({ error: "Status is required" }, { status: 400 });
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Update enrollment
    const { data: enrollment, error: updateError } = await serviceSupabase
      .from('enrollments')
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating enrollment:', updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ 
      message: "Enrollment updated successfully",
      enrollment 
    });

  } catch (error) {
    console.error('Admin enrollment PUT API error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return createAuthResponse(authResult.error!, authResult.status!);
    }
    const { userProfile } = authResult;

    // Check if user has admin privileges
    if (!hasRole(userProfile.role, ['admin', 'super_admin'])) {
      return createAuthResponse("Forbidden: Admin access required", 403);
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Delete enrollment
    const { error: deleteError } = await serviceSupabase
      .from('enrollments')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error('Error deleting enrollment:', deleteError);
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ 
      message: "Enrollment deleted successfully" 
    });

  } catch (error) {
    console.error('Admin enrollment DELETE API error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
