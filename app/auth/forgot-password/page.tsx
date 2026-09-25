'use client'

import { useState } from 'react'
import Link from 'next/link'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setError('')
    setMessage('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 429) {
        setError('Too many requests. Please wait a few minutes and try again.')
      } else if (!res.ok) {
        setError(data.error || 'Unable to process the request right now.')
      } else {
        setMessage(data.message || 'If an account exists for that email address, a reset link has been sent.')
      }
    } catch {
      setError('Network error. Please check your connection and try again.')
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
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">Reset your password</h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Enter the email address for your account and we will send you a link to choose a new password.
          </p>
        </div>

        {message ? (
          <div className="rounded-md bg-green-50 p-4" role="status">
            <p className="text-sm text-green-800">{message}</p>
            <p className="mt-3 text-sm">
              <Link href="/auth/signin" className="font-medium text-blue-600 hover:text-blue-500">
                Back to sign in
              </Link>
            </p>
          </div>
        ) : (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit} noValidate>
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
                autoFocus
                className="appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-md bg-red-50 p-4" role="alert">
                <div className="text-sm text-red-700">{error}</div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50"
              style={{ background: 'linear-gradient(to right, var(--theme-primary), var(--theme-secondary))' }}
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>

            <p className="text-center text-sm text-gray-600">
              Remembered it?{' '}
              <Link href="/auth/signin" className="font-medium text-blue-600 hover:text-blue-500">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
