'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { getSupabaseClient } from './supabase'
import { clearPwaCaches } from './pwa-utils'
import { clearRoleCache } from '@/app/components/RoleGuard'
import type { User } from '@supabase/supabase-js'

interface SupabaseContextType {
  user: User | null
  loading: boolean
  supabase: ReturnType<typeof getSupabaseClient>
  signOut: () => Promise<void>
  signUp: (email: string, password: string, metadata?: any) => Promise<{ data: any; error: any }>
  signIn: (email: string, password: string) => Promise<{ data: any; error: any }>
  createUserProfile: (userData: { id: string; email: string; name: string; role: string }) => Promise<{ data: any; error: any }>
}

const SupabaseContext = createContext<SupabaseContextType | undefined>(undefined)

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Use the shared supabase instance
  const supabaseInstance = getSupabaseClient()

  useEffect(() => {
    // Get initial session
    const getInitialSession = async () => {
      const { data: { session } } = await supabaseInstance.auth.getSession()
      setUser(session?.user ?? null)
      setLoading(false)
    }

    getInitialSession()

    // Listen for auth changes
    const { data: { subscription } } = supabaseInstance.auth.onAuthStateChange(
      async (event, session) => {
        setUser(session?.user ?? null)
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  const signOut = async () => {
    // 1. Drop any in-memory role data so the next session cannot inherit it.
    clearRoleCache()
    try {
      await supabaseInstance.auth.signOut()
    } catch (error) {
      console.error('Sign out failed:', error)
    }
    // 2. Purge service-worker/Cache Storage entries that may hold user data.
    try {
      await clearPwaCaches()
    } catch (error) {
      console.error('Failed to clear PWA caches on sign out:', error)
    }
    // 3. Hard redirect so all client state (React, module caches) is reset.
    if (typeof window !== 'undefined') {
      window.location.assign('/auth/signin')
    }
  }

  const signUp = async (email: string, password: string, metadata?: any) => {
    // Never let the client choose a role via auth metadata; roles are assigned
    // server-side by administrators.
    const { role: _ignoredRole, ...safeMetadata } = (metadata || {}) as Record<string, unknown>
    return await supabaseInstance.auth.signUp({
      email,
      password,
      options: { data: safeMetadata }
    })
  }

  const signIn = async (email: string, password: string) => {
    return await supabaseInstance.auth.signInWithPassword({
      email,
      password
    })
  }

  const createUserProfile = async (userData: { id: string; email: string; name: string; role: string }) => {
    return await supabaseInstance
      .from('users')
      .insert([userData])
  }

  return (
    <SupabaseContext.Provider value={{ user, loading, supabase: supabaseInstance, signOut, signUp, signIn, createUserProfile }}>
      {children}
    </SupabaseContext.Provider>
  )
}

export function useSupabase() {
  const context = useContext(SupabaseContext)
  if (context === undefined) {
    throw new Error('useSupabase must be used within a SupabaseProvider')
  }
  return context
}
