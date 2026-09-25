import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server';
import { isUuid } from '@/lib/security';
import { resolveConferenceAccess } from '@/lib/conferences/access';
import { clientInfoFromRequest, recordAccess } from '@/lib/conferences/access-log';
import { trackedJoinPath } from '@/lib/conferences/zoom';

/**
 * GET /api/conferences/[id]/zoom
 *
 * One-click tracked redirect. Suitable for calendar invites and emails: the
 * LMS records who followed the link (with device and IP) and then forwards
 * them to Zoom. Anyone not signed in is sent to sign-in and returned to the
 * lobby page afterwards; anyone without access lands on the lobby with a
 * message instead of the meeting.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: conferenceId } = await params;
  const origin = request.nextUrl.origin;
  const lobby = new URL(trackedJoinPath(conferenceId), origin);

  if (!isUuid(conferenceId)) return NextResponse.redirect(new URL('/', origin), 302);

  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      const signin = new URL('/auth/signin', origin);
      signin.searchParams.set('next', lobby.pathname);
      return NextResponse.redirect(signin, 302);
    }

    const service = createServiceSupabaseClient();
    const access = await resolveConferenceAccess(service, user.id, conferenceId);
    if (access.ok === false) {
      lobby.searchParams.set('error', access.status === 404 ? 'not_found' : 'forbidden');
      return NextResponse.redirect(lobby, 302);
    }

    const { conference, isHost, canManage } = access;
    if (conference.video_provider !== 'zoom' || !conference.meeting_url) {
      return NextResponse.redirect(lobby, 302);
    }
    if (conference.status === 'ended' || conference.status === 'cancelled') {
      lobby.searchParams.set('error', 'ended');
      return NextResponse.redirect(lobby, 302);
    }

    const now = new Date().toISOString();
    await service
      .from('conference_participants')
      .upsert(
        [{ conference_id: conference.id, user_id: user.id, joined_at: now, left_at: null, role: isHost ? 'host' : 'participant' }],
        { onConflict: 'conference_id,user_id' }
      );
    if (conference.status === 'scheduled') {
      await service.from('video_conferences').update({ status: 'live' }).eq('id', conference.id);
    }

    await recordAccess(service, {
      conference_id: conference.id,
      user_id: user.id,
      course_id: conference.course_id,
      event: 'join_redirect',
      role: isHost ? 'host' : canManage ? 'co-host' : 'participant',
      client: clientInfoFromRequest(request),
    });

    const res = NextResponse.redirect(conference.meeting_url, 302);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  } catch (error) {
    console.error('[conference-zoom-redirect] error:', error);
    lobby.searchParams.set('error', 'server');
    return NextResponse.redirect(lobby, 302);
  }
}
