import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { tooManyRequests } from '@/lib/api-errors';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { authenticateUser } from '@/lib/api-auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const aiLimit = await rateLimit({ key: `ai:${authResult.user?.id ?? authResult.userProfile?.id}`, limit: 30, windowSeconds: 60 });
    if (!aiLimit.ok) return tooManyRequests(aiLimit.retryAfter);

    const { user } = authResult;
    const supabase = await createServerSupabaseClient();
    const { id } = await params;
    const conversationId = id;

    // Get conversation details
    const { data: conversation, error: conversationError } = await supabase
      .from('ai_conversations')
      .select('id, title, context, created_at, updated_at')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .single();

    if (conversationError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Get messages for this conversation
    const { data: messages, error: messagesError } = await supabase
      .from('ai_messages')
      .select('id, role, content, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (messagesError) {
      console.error('Error fetching messages:', messagesError);
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    return NextResponse.json({
      conversation,
      messages: messages || []
    });

  } catch (error) {
    console.error('AI Conversation API Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const aiLimit = await rateLimit({ key: `ai:${authResult.user?.id ?? authResult.userProfile?.id}`, limit: 30, windowSeconds: 60 });
    if (!aiLimit.ok) return tooManyRequests(aiLimit.retryAfter);

    const { user } = authResult;
    const supabase = await createServerSupabaseClient();
    const { id } = await params;
    const conversationId = id;

    // Verify conversation belongs to user
    const { data: conversation, error: conversationError } = await supabase
      .from('ai_conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .single();

    if (conversationError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Delete conversation (messages will be deleted by CASCADE)
    const { error: deleteError } = await supabase
      .from('ai_conversations')
      .delete()
      .eq('id', conversationId);

    if (deleteError) {
      console.error('Error deleting conversation:', deleteError);
      return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('AI Conversation Delete API Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await authenticateUser(request);
    if (!authResult.success) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const aiLimit = await rateLimit({ key: `ai:${authResult.user?.id ?? authResult.userProfile?.id}`, limit: 30, windowSeconds: 60 });
    if (!aiLimit.ok) return tooManyRequests(aiLimit.retryAfter);

    const { user } = authResult;
    const supabase = await createServerSupabaseClient();
    const { id } = await params;
    const conversationId = id;

    const { title } = await request.json();

    if (!title || title.trim().length === 0) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    // Update conversation title
    const { error: updateError } = await supabase
      .from('ai_conversations')
      .update({ 
        title: title.trim(),
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Error updating conversation:', updateError);
      return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 });
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('AI Conversation Update API Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
