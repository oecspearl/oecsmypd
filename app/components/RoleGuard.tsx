'use client';

import React, { useState, useEffect } from 'react';
import { getSupabaseClient } from '@/lib/supabase';

interface RoleGuardProps {
  roles?: string[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

// Cache for role data to reduce API calls.
// Cleared on every auth state change and on sign-out so a role never leaks
// between two different sessions in the same tab.
let roleCache: { role: string | null; timestamp: number } | null = null;
const CACHE_DURATION = 30000; // 30 seconds

export function clearRoleCache() {
  roleCache = null;
}

// Subscribe once (module-level) so the cache is invalidated even when no
// RoleGuard is currently mounted.
let authSubscribed = false;
function ensureAuthSubscription() {
  if (authSubscribed || typeof window === 'undefined') return;
  authSubscribed = true;
  try {
    const supabase = getSupabaseClient();
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        clearRoleCache();
      }
    });
  } catch (error) {
    console.error('RoleGuard: failed to subscribe to auth changes', error);
  }
}

export default function RoleGuard({ roles = [], children, fallback = null }: RoleGuardProps) {
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ensureAuthSubscription();
    let cancelled = false;

    const checkUserRole = async () => {
      // Check cache first
      const now = Date.now();
      if (roleCache && (now - roleCache.timestamp) < CACHE_DURATION) {
        setUserRole(roleCache.role);
        setLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/auth/profile', { cache: 'no-store' });
        let role = 'student';
        if (response.ok) {
          const profile = await response.json();
          role = profile?.role || 'student';
        }
        if (cancelled) return;
        setUserRole(role);
        roleCache = { role, timestamp: now };
      } catch (error) {
        console.error('RoleGuard: Error fetching user role:', error);
        if (cancelled) return;
        // Do not cache a failed lookup: the next mount should retry.
        setUserRole('student');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkUserRole();
    return () => { cancelled = true; };
  }, []);

  // Show loading state while checking role
  if (loading) {
    return null;
  }

  // Check if user has one of the required roles
  const hasAccess = userRole && roles && Array.isArray(roles) && roles.length > 0 && roles.includes(userRole);

  if (!hasAccess) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
