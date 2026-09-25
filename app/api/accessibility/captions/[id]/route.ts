import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';

/**
 * GET /api/accessibility/captions/[id]
 * Get a specific caption track
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServiceSupabaseClient();

    const { data, error } = await supabase
      .from('video_captions')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching caption:', error);
      return NextResponse.json({ error: 'Caption not found' }, { status: 404 });
    }

    return NextResponse.json({ caption: data });
  } catch (error) {
    console.error('Error in caption GET:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/accessibility/captions/[id]
 * Update a caption track (e.g., set as default)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { is_default, label } = body;

    const serviceSupabase = await createServiceSupabaseClient();

    // Get the caption to find its video_url
    const { data: caption, error: fetchError } = await serviceSupabase
      .from('video_captions')
      .select('video_url')
      .eq('id', id)
      .single();

    if (fetchError || !caption) {
      return NextResponse.json({ error: 'Caption not found' }, { status: 404 });
    }

    // If setting as default, unset other defaults for this video
    if (is_default) {
      await serviceSupabase
        .from('video_captions')
        .update({ is_default: false })
        .eq('video_url', caption.video_url);
    }

    // Update the caption
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof is_default === 'boolean') updateData.is_default = is_default;
    if (label !== undefined) updateData.label = label;

    const { data, error } = await serviceSupabase
      .from('video_captions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating caption:', error);
      return NextResponse.json({ error: 'Failed to update caption' }, { status: 500 });
    }

    return NextResponse.json({ caption: data });
  } catch (error) {
    console.error('Error in caption PATCH:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/accessibility/captions/[id]
 * Delete a caption track
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check user role
    const serviceSupabase = await createServiceSupabaseClient();
    const { data: userData } = await serviceSupabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    const allowedRoles = ['admin', 'super_admin', 'instructor', 'curriculum_designer'];
    if (!userData || !allowedRoles.includes(userData.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get caption details for cleanup
    const { data: caption } = await serviceSupabase
      .from('video_captions')
      .select('caption_url')
      .eq('id', id)
      .single();

    // Delete from storage if URL exists
    if (caption?.caption_url && caption.caption_url.includes('/captions/')) {
      const storagePath = caption.caption_url.split('/captions/')[1];
      if (storagePath) {
        await serviceSupabase.storage.from('captions').remove([storagePath]);
      }
    }

    // Delete from database
    const { error } = await serviceSupabase
      .from('video_captions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting caption:', error);
      return NextResponse.json({ error: 'Failed to delete caption' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in caption DELETE:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
