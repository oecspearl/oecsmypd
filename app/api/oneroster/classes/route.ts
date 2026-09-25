/**
 * OneRoster Classes Endpoint
 * GET /ims/oneroster/v1p1/classes
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateOneRosterRequest, parseOneRosterFilter } from '@/lib/oneroster/auth';
import { createServiceSupabaseClient } from '@/lib/supabase-server';

export async function GET(request: NextRequest) {
  try {
    // Authenticate (Bearer JWT from /api/oneroster/token, or OAuth 1.0a)
    const authResult = await authenticateOneRosterRequest(request);
    if (!authResult) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');
    const filter = searchParams.get('filter');

    const supabase = createServiceSupabaseClient();
    let query = supabase
      .from('oneroster_classes')
      .select(`
        *,
        oneroster_organizations!oneroster_classes_school_sourced_id_fkey(sourced_id, name)
      `)
      .eq('status', 'active')
      .range(offset, offset + limit - 1);

    const parsedFilter = parseOneRosterFilter(filter, 'classes');
    if (filter && !parsedFilter) {
      return NextResponse.json({ error: 'Unsupported filter' }, { status: 400 });
    }
    if (parsedFilter) {
      query = query.eq(parsedFilter.column, parsedFilter.value);
    }

    query = query.order('title', { ascending: true });

    const { data: classes, error } = await query;

    if (error) {
      console.error('OneRoster classes query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch classes' },
        { status: 500 }
      );
    }

    const response = {
      classes: (classes || []).map(cls => ({
        sourcedId: cls.sourced_id,
        status: cls.status,
        dateLastModified: cls.date_last_modified,
        metadata: cls.metadata,
        title: cls.title,
        classCode: cls.class_code,
        classType: cls.class_type,
        location: cls.location,
        grades: cls.grades || [],
        subjects: cls.subjects || [],
        course: cls.course_sourced_id ? {
          sourcedId: cls.course_sourced_id,
        } : null,
        school: cls.school_sourced_id ? {
          sourcedId: cls.school_sourced_id,
        } : null,
        terms: (cls.term_sourced_ids || []).map((termId: string) => ({
          sourcedId: termId,
        })),
        periods: cls.periods || [],
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('OneRoster classes error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

