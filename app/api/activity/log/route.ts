import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { serverError } from "@/lib/api-errors";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json();
    const {
      courseId,
      activityType,
      itemId,
      itemType,
      action,
      metadata = {}
    } = body;

    // Validate required fields
    if (!activityType || !action) {
      return NextResponse.json({ 
        error: "activityType and action are required" 
      }, { status: 400 });
    }

    // Get IP address and user agent from request
    const ipAddress = request.headers.get('x-forwarded-for') || 
                      request.headers.get('x-real-ip') || 
                      null;
    const userAgent = request.headers.get('user-agent') || null;

    const serviceSupabase = createServiceSupabaseClient();

    // Insert activity log
    const { data: logEntry, error } = await serviceSupabase
      .from('student_activity_log')
      .insert({
        student_id: user.id,
        course_id: courseId || null,
        activity_type: activityType,
        item_id: itemId || null,
        item_type: itemType || null,
        action: action,
        metadata: metadata,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select()
      .single();

    if (error) {
      console.error('Activity log insert error:', error);
      return serverError("Failed to log activity", error);
    }

    return NextResponse.json({ 
      success: true,
      logEntry 
    });
  } catch (e: any) {
    console.error('Activity log API error:', e);
    return serverError("Internal server error", e);
  }
}

