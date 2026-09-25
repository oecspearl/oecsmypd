import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { hasRole } from "@/lib/rbac";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();
    
    // Get current user to check role
    const user = await getCurrentUser();
    const isInstructor = user && hasRole(user.role, ["instructor", "curriculum_designer", "admin", "super_admin"]);
    
    const { data: lesson, error } = await supabase
      .from("lessons")
      .select("*")
      .eq("id", id)
      .single();
    
    if (error) {
      console.error('Lesson fetch error:', error);
      return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    }
    
    // Check if lesson is published for students
    if (!isInstructor && lesson && !lesson.published) {
      return NextResponse.json({ error: "This lesson is not yet published" }, { status: 403 });
    }
    
    return NextResponse.json(lesson);
  } catch (e: any) {
    console.error('Lesson GET API error:', e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user || !hasRole(user.role, ["instructor", "curriculum_designer", "admin", "super_admin"])) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    
    const body = await request.json();
    const supabase = await createServerSupabaseClient();
    
    // Prepare update data
    const updateData: any = {
      title: String(body.title || ""),
      description: String(body.description || ""),
      difficulty: Number(body.difficulty ?? 1),
      learning_outcomes: Array.isArray(body.learning_outcomes) ? body.learning_outcomes : [],
      lesson_instructions: String(body.lesson_instructions || ""),
      content: Array.isArray(body.content) ? body.content : [],
      resources: Array.isArray(body.resources) ? body.resources : [],
      estimated_time: Number(body.estimated_time ?? 0),
      published: Boolean(body.published ?? false),
      updated_at: new Date().toISOString()
    };
    
    const { data: lesson, error } = await supabase
      .from("lessons")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();
    
    if (error) {
      console.error('Lesson update error:', error);
      return NextResponse.json({ error: "Failed to update lesson" }, { status: 500 });
    }
    
    return NextResponse.json(lesson);
  } catch (e: any) {
    console.error('Lesson PUT API error:', e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user || !hasRole(user.role, ["admin", "super_admin"])) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    
    const supabase = await createServerSupabaseClient();
    
    const { error } = await supabase
      .from("lessons")
      .delete()
      .eq("id", id);
    
    if (error) {
      console.error('Lesson delete error:', error);
      // 23503 = foreign_key_violation: another table still references this
      // lesson and its FK is not set to cascade/detach. Tell the caller what
      // is blocking instead of a generic 500.
      if ((error as { code?: string }).code === '23503') {
        const details = (error as { details?: string }).details || '';
        const table = details.match(/table "([^"]+)"/)?.[1];
        return NextResponse.json(
          {
            error: table
              ? `This lesson cannot be deleted because it is still referenced by ${table}. Remove or detach those items first.`
              : 'This lesson cannot be deleted because other records still reference it.',
            code: 'LESSON_IN_USE',
            blockedBy: table ?? null,
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Failed to delete lesson" }, { status: 500 });
    }
    
    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('Lesson DELETE API error:', e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
