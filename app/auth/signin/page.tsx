'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSupabase } from '@/lib/supabase-provider'
import Link from 'next/link'

/**
 * Only allow same-origin relative paths as a post-login destination.
 * Rejects absolute URLs, protocol-relative URLs (//evil.com) and anything
 * that does not start with a single "/".
 */
function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/dashboard'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard'
  if (/[\r\n]/.test(raw)) return '/dashboard'
  if (raw.startsWith('/auth/')) return '/dashboard'
  return raw
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  no_account: 'No account found for that Google email. Ask an admin to invite you.',
  oauth_failed: 'Google sign-in could not be completed. Please try again or sign in with your password.',
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  )
}

function SignInForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const resetSuccess = searchParams.get('reset') === 'success'
  const nextPath = safeNextPath(searchParams.get('next'))
  const oauthError = searchParams.get('error')
  const [error, setError] = useState(() => (oauthError && OAUTH_ERROR_MESSAGES[oauthError]) || '')
  const { signIn, createUserProfile, supabase } = useSupabase()

  const handleGoogleSignIn = async () => {
    if (loading || googleLoading) return
    setGoogleLoading(true)
    setError('')
    try {
      const callback = new URL('/auth/callback', window.location.origin)
      if (nextPath !== '/dashboard') callback.searchParams.set('next', nextPath)
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callback.toString(),
          queryParams: { prompt: 'select_account' },
        },
      })
      if (error) {
        setError(error.message)
        setGoogleLoading(false)
      }
      // On success the browser navigates away to Google.
    } catch {
      setError('An unexpected error occurred')
      setGoogleLoading(false)
    }
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError('')

    try {
      const { data, error } = await signIn(email, password)

      if (error) {
        setError(error.message)
      } else if (data.user) {
        // Check if user profile exists, create if not
        try {
          const response = await fetch('/api/auth/profile', { cache: 'no-store' })
          if (!response.ok) {
            // Profile doesn't exist, create it. Role is always 'student' here:
            // privileged roles are assigned by administrators server-side, never
            // from client-controlled auth metadata.
            const { error: profileError } = await createUserProfile({
              id: data.user.id,
              email: data.user.email!,
              name: data.user.user_metadata?.full_name || data.user.email!.split('@')[0],
              role: 'student'
            })

            if (profileError) {
              console.error('Failed to create user profile:', profileError)
              // Continue anyway - the user can still access the app
            }
          }
        } catch (profileError) {
          console.error('Error checking/creating profile:', profileError)
          // Continue anyway - the user can still access the app
        }

        router.push(nextPath)
      }
    } catch (err) {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-blue-100">
            <img 
              src="/oecs-logo.png" 
              alt="OECS Logo" 
              className="h-8 w-8 object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'block';
              }}
            />
            <span className="text-2xl font-bold text-blue-600 hidden">OECS</span>
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Sign in to OECS LearnBoard
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Or{' '}
            <Link href="/auth/signup" className="font-medium text-blue-600 hover:text-blue-500">
              create a new account
            </Link>
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSignIn}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="email" className="sr-only">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center justify-end">
            <Link href="/auth/forgot-password" className="text-sm font-medium text-blue-600 hover:text-blue-500">
              Forgot your password?
            </Link>
          </div>

          {resetSuccess && !error && (
            <div className="rounded-md bg-green-50 p-4" role="status">
              <div className="text-sm text-green-800">Your password has been updated. Sign in with your new password.</div>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 transition-all duration-300"
              style={{
                background: `linear-gradient(to right, var(--theme-primary), var(--theme-secondary))`,
                '--tw-ring-color': 'var(--theme-primary)'
              } as React.CSSProperties & { '--tw-ring-color': string }}
              onMouseEnter={(e) => {
                if (!loading) {
                  const primary = getComputedStyle(document.documentElement).getPropertyValue('--theme-primary');
                  const secondary = getComputedStyle(document.documentElement).getPropertyValue('--theme-secondary');
                  e.currentTarget.style.background = `linear-gradient(to right, ${primary}DD, ${secondary}DD)`;
                }
              }}
              onMouseLeave={(e) => {
                if (!loading) {
                  e.currentTarget.style.background = `linear-gradient(to right, var(--theme-primary), var(--theme-secondary))`;
                }
              }}
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className="w-full border-t border-gray-300" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-gray-50 text-gray-500">or</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading || googleLoading}
          className="w-full flex items-center justify-center gap-3 py-2 px-4 border border-gray-300 rounded-md bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.95l3.66-2.84z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
          </svg>
          {googleLoading ? 'Redirecting to Google...' : 'Continue with Google'}
        </button>
        <p className="text-center text-xs text-gray-500">
          Google sign-in works for existing accounts only.
        </p>
      </div>
    </div>
  )
}
