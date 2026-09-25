import { NextResponse } from 'next/server';
import { createServiceSupabaseClient } from '@/lib/supabase-server';

/**
 * GET /api/i18n/locales
 * Get the list of supported locales
 */
export async function GET() {
  try {
    const supabase = await createServiceSupabaseClient();

    // Try to get locales from database
    const { data: locales, error } = await supabase
      .from('supported_locales')
      .select('code, name, native_name, is_rtl, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error || !locales || locales.length === 0) {
      // Fall back to hardcoded locales
      return NextResponse.json({
        locales: [
          { code: 'en', name: 'English', native_name: 'English', is_rtl: false },
          { code: 'es', name: 'Spanish', native_name: 'Español', is_rtl: false },
          { code: 'fr', name: 'French', native_name: 'Français', is_rtl: false },
        ],
        source: 'fallback',
      });
    }

    return NextResponse.json({
      locales,
      source: 'database',
    });

  } catch (error) {
    console.error('Error getting locales:', error);
    // Return fallback locales
    return NextResponse.json({
      locales: [
        { code: 'en', name: 'English', native_name: 'English', is_rtl: false },
        { code: 'es', name: 'Spanish', native_name: 'Español', is_rtl: false },
        { code: 'fr', name: 'French', native_name: 'Français', is_rtl: false },
      ],
      source: 'fallback',
    });
  }
}
