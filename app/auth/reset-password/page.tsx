'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useSupabase } from '@/lib/supabase-provider'

/**
 * Landing page for the Supabase password-recovery email link.
 *
 * The link can arrive in three shapes, and all are handled here explicitly
 * because the browser client is configured for PKCE and refuses to auto-
 * consume an implicit-flow hash ("Not a valid PKCE flow url"):
 *   1. `#access_token=…&refresh_token=…&type=recovery`  (default template,
 *      request made server-side)  -> setSession()
 *   2. `?token_hash=…&type=recovery`  (custom template)   -> verifyOtp()
 *   3. `?code=…`  (PKCE, request made in this browser)   -> auto-exchanged
 * Expired or reused links arrive with `error_description` and get a message
 * with a way to request a fresh link.
 */

type Stage = 'checking' | 'ready' | 'invalid' | 'done'

function linkParams() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const query = new URLSearchParams(window.location.search)
  const get = (k: string) => hash.get(k) || query.get(k)
  return {
    error: get('error_description') || get('error'),
    accessToken: hash.get('access_token'),
    refreshToken: hash.get('refresh_token'),
    tokenHash: query.get('token_hash'),
    type: get('type'),
  }
}

function stripTokensFromUrl() {
  try {
    window.history.replaceState({}, '', window.location.pathname)
  } catch {
    /* ignore */
  }
}

export default function ResetPasswordPage() {
  const { supabase } = useSupabase()
  const router = useRouter()
  const [stage, setStage] = useState<Stage>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const params = linkParams()

    if (params.error) {
      setStage('invalid')
      return
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return
      if ((event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') && session) {
        setStage('ready')
      }
    })

    const establish = async () => {
      try {
        // 1. Implicit-flow hash from the default recovery email.
        if (params.accessToken && params.refreshToken) {
          const { data, error } = await supabase.auth.setSession({
            access_token: params.accessToken,
            refresh_token: params.refreshToken,
          })
          stripTokensFromUrl()
          if (!cancelled) setStage(!error && data.session ? 'ready' : 'invalid')
          return
        }

        // 2. token_hash style link (custom email template).
        if (params.tokenHash && params.type === 'recovery') {
          const { data, error } = await supabase.auth.verifyOtp({
            token_hash: params.tokenHash,
            type: 'recovery',
          })
          stripTokensFromUrl()
          if (!cancelled) setStage(!error && data.session ? 'ready' : 'invalid')
          return
        }

        // 3. PKCE code: the client exchanges it on init; poll briefly.
        for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
          const { data: { session } } = await supabase.auth.getSession()
          if (session) {
            setStage('ready')
            return
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!cancelled) setStage((s) => (s === 'ready' ? s : 'invalid'))
      } catch {
        if (!cancelled) setStage('invalid')
      }
    }
    establish()

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [supabase])

  const validate = (): string | null => {
    if (password.length < 8) return 'Password must be at least 8 characters long.'
    if (password.length > 128) return 'Password must be less than 128 characters.'
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Use at least one letter and one number.'
    if (password !== confirm) return 'The two passwords do not match.'
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setStage('invalid')
        return
      }
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        console.error('[reset-password] updateUser failed:', updateError.status, updateError.message)
        const msg = updateError.message || ''
        if (/different from the old|same password|same as/i.test(msg)) {
          setError('That is your current password. Choose a new one you have not used before.')
        } else if (/session|not authenticated|jwt|token/i.test(msg)) {
          setStage('invalid')
        } else if (/password/i.test(msg)) {
          // Supabase password-policy messages are user-safe; show them verbatim.
          setError(msg)
        } else {
          setError(`Could not update the password: ${msg || 'unknown error'}. If this keeps happening, request a new link.`)
        }
        return
      }
      setStage('done')
      // End the recovery session so the user signs in normally with the new password.
      setTimeout(async () => {
        try {
          await supabase.auth.signOut()
        } finally {
          router.replace('/auth/signin?reset=success')
        }
      }, 1500)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-blue-100">
            <img src="/oecs-logo.png" alt="OECS Logo" className="h-8 w-8 object-contain" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">Choose a new password</h2>
        </div>

        {stage === 'checking' && (
          <p className="text-center text-sm text-gray-500" role="status">Verifying your reset link…</p>
        )}

        {stage === 'invalid' && (
          <div className="rounded-md bg-yellow-50 p-4" role="alert">
            <p className="text-sm text-yellow-800">
              This password reset link is invalid or has expired. Reset links can only be used once and are valid for a limited time.
            </p>
            <p className="mt-3 text-sm">
              <Link href="/auth/forgot-password" className="font-medium text-blue-600 hover:text-blue-500">
                Request a new reset link
              </Link>
            </p>
          </div>
        )}

        {stage === 'done' && (
          <div className="rounded-md bg-green-50 p-4" role="status">
            <p className="text-sm text-green-800">Your password has been updated. Taking you to sign in…</p>
          </div>
        )}

        {stage === 'ready' && (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit} noValidate>
            <div className="rounded-md shadow-sm -space-y-px">
              <div>
                <label htmlFor="password" className="sr-only">New password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  autoFocus
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="confirm" className="sr-only">Confirm new password</label>
                <input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                  placeholder="Confirm new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">At least 8 characters, including a letter and a number.</p>

            {error && (
              <div className="rounded-md bg-red-50 p-4" role="alert">
                <div className="text-sm text-red-700">{error}</div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50"
              style={{ background: 'linear-gradient(to right, var(--theme-primary), var(--theme-secondary))' }}
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
