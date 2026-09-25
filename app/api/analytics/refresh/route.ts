import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { getCurrentUser } from "@/lib/database-helpers";
import { serverError } from "@/lib/api-errors";

/**
 * Analytics Refresh API
 *
 * POST /api/analytics/refresh
 *
 * Refreshes the analytics materialized views for up-to-date data.
 * This can be called manually or scheduled via cron.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();

    // Only allow admins to manually refresh, but allow unauthenticated cron requests
    const cronSecret = request.headers.get('x-cron-secret');
    const isCronRequest = cronSecret === process.env.CRON_SECRET;

    if (!isCronRequest) {
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const allowedRoles = ['admin', 'super_admin'];
      if (!allowedRoles.includes(user.role)) {
        return NextResponse.json({
          error: "Forbidden",
          message: "Only admins can manually refresh analytics"
        }, { status: 403 });
      }
    }

    const serviceSupabase = createServiceSupabaseClient();
    const results: { view: string; status: string; error?: string }[] = [];

    // Refresh analytics_daily_active_users
    try {
      const { error: dauError } = await serviceSupabase.rpc('refresh_analytics_dau');
      if (dauError) {
        // Try direct SQL if RPC doesn't exist
        const { error: directError } = await serviceSupabase
          .from('analytics_daily_active_users')
          .select('date')
          .limit(1);

        if (directError) {
          console.error('analytics_daily_active_users refresh error:', directError);
          results.push({ view: 'analytics_daily_active_users', status: 'error', error: 'Refresh failed' });
        } else {
          results.push({ view: 'analytics_daily_active_users', status: 'skipped', error: 'RPC not available, view exists' });
        }
      } else {
        results.push({ view: 'analytics_daily_active_users', status: 'refreshed' });
      }
    } catch (err: any) {
      console.error('analytics_daily_active_users refresh error:', err);
      results.push({ view: 'analytics_daily_active_users', status: 'error', error: 'Refresh failed' });
    }

    // Refresh analytics_course_engagement
    try {
      const { error: engagementError } = await serviceSupabase.rpc('refresh_analytics_course_engagement');
      if (engagementError) {
        results.push({ view: 'analytics_course_engagement', status: 'skipped', error: 'RPC not available' });
      } else {
        results.push({ view: 'analytics_course_engagement', status: 'refreshed' });
      }
    } catch (err: any) {
      console.error('analytics_course_engagement refresh error:', err);
      results.push({ view: 'analytics_course_engagement', status: 'error', error: 'Refresh failed' });
    }

    // Refresh analytics_activity_types
    try {
      const { error: activityError } = await serviceSupabase.rpc('refresh_analytics_activity_types');
      if (activityError) {
        results.push({ view: 'analytics_activity_types', status: 'skipped', error: 'RPC not available' });
      } else {
        results.push({ view: 'analytics_activity_types', status: 'refreshed' });
      }
    } catch (err: any) {
      console.error('analytics_activity_types refresh error:', err);
      results.push({ view: 'analytics_activity_types', status: 'error', error: 'Refresh failed' });
    }

    // Try the combined refresh function if available
    try {
      const { error: allError } = await serviceSupabase.rpc('refresh_analytics_views');
      if (!allError) {
        // If the combined function works, mark all as refreshed
        results.forEach(r => {
          if (r.status === 'skipped') r.status = 'refreshed';
        });
      }
    } catch (err) {
      // Ignore if combined function doesn't exist
    }

    const refreshedCount = results.filter(r => r.status === 'refreshed').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      success: errorCount === 0,
      message: `Refreshed ${refreshedCount} views, ${errorCount} errors`,
      results,
      refreshed_at: new Date().toISOString()
    });

  } catch (error: any) {
    return serverError("Internal server error", error);
  }
}

/**
 * GET /api/analytics/refresh
 *
 * Returns the status of the last refresh and whether views are stale.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const allowedRoles = ['admin', 'super_admin', 'instructor', 'curriculum_designer'];
    if (!allowedRoles.includes(user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const serviceSupabase = createServiceSupabaseClient();

    // Check latest data in each view
    const [dauResult, engagementResult, activityResult] = await Promise.allSettled([
      serviceSupabase.from('analytics_daily_active_users').select('date').order('date', { ascending: false }).limit(1),
      serviceSupabase.from('analytics_course_engagement').select('date').order('date', { ascending: false }).limit(1),
      serviceSupabase.from('analytics_activity_types').select('date').order('date', { ascending: false }).limit(1),
    ]);

    const today = new Date().toISOString().split('T')[0];

    const getLatestDate = (result: PromiseSettledResult<any>) => {
      if (result.status === 'fulfilled' && result.value.data?.[0]?.date) {
        return result.value.data[0].date;
      }
      return null;
    };

    const views = [
      { name: 'analytics_daily_active_users', latest_date: getLatestDate(dauResult) },
      { name: 'analytics_course_engagement', latest_date: getLatestDate(engagementResult) },
      { name: 'analytics_activity_types', latest_date: getLatestDate(activityResult) },
    ];

    // Check if views are stale (latest data is not from today)
    const isStale = views.some(v => v.latest_date !== today);

    return NextResponse.json({
      views,
      today,
      is_stale: isStale,
      recommendation: isStale ? 'Consider refreshing analytics views' : 'Views are up to date'
    });

  } catch (error: any) {
    return serverError("Internal server error", error);
  }
}
