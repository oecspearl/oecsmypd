import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceSupabaseClient } from '@/lib/supabase-server'

/**
 * OAuth callback (Google sign-in).
 *
 * Supabase redirects here with a `code` after the user authenticates with the
 * provider. We exchange it for a session, then enforce the account policy:
 *
 *   - Existing account (email/password user, or a Google identity already
 *     linked): let them in. Supabase links the Google identity to the existing
 *     auth user automatically when the verified email matches.
 *   - No existing account: Google sign-in must NOT create one. Supabase will
 *     already have created an auth user by this point, so we sign out, delete
 *     that orphan auth user, and send them back with an explanation.
 */

function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/dashboard'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard'
  if (/[\r\n]/.test(raw)) return '/dashboard'
  if (raw.startsWith('/auth/')) return '/dashboard'
  return raw
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'))

  const backToSignIn = (reason: string) =>
    NextResponse.redirect(new URL(`/auth/signin?error=${encodeURIComponent(reason)}`, url.origin))

  // Provider or Supabase reported an error before we got a code.
  if (!code) {
    const providerError = url.searchParams.get('error_description') || url.searchParams.get('error')
    if (providerError) console.error('OAuth callback error from provider:', providerError)
    return backToSignIn('oauth_failed')
  }

  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data?.user) {
    console.error('OAuth code exchange failed:', error?.message)
    return backToSignIn('oauth_failed')
  }

  const user = data.user
  const service = createServiceSupabaseClient()

  const { data: profile, error: profileError } = await service
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('Failed to look up user profile after OAuth:', profileError.message)
    await supabase.auth.signOut()
    return backToSignIn('oauth_failed')
  }

  if (!profile) {
    // An auth user that only has OAuth identities and no profile row was
    // created by this very sign-in attempt. Policy: block and clean up.
    const hasPasswordIdentity = (user.identities ?? []).some((i) => i.provider === 'email')

    if (!hasPasswordIdentity) {
      await supabase.auth.signOut()
      const { error: deleteError } = await service.auth.admin.deleteUser(user.id)
      if (deleteError) {
        console.error('Failed to remove orphan OAuth auth user:', deleteError.message)
      }
      return backToSignIn('no_account')
    }

    // Legacy email/password account that never got a profile row. Mirror the
    // password sign-in behaviour: create it with the lowest-privilege role.
    const { error: insertError } = await service.from('users').insert({
      id: user.id,
      email: user.email!,
      name: user.user_metadata?.full_name || user.user_metadata?.name || user.email!.split('@')[0],
      role: 'student',
    })
    if (insertError) {
      console.error('Failed to create user profile after OAuth:', insertError.message)
      // Continue anyway, matching the password sign-in flow.
    }
  }

  return NextResponse.redirect(new URL(next, url.origin))
}
