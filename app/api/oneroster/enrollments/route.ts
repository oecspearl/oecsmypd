/**
 * OneRoster Enrollments Endpoint
 * GET /ims/oneroster/v1p1/enrollments
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
      .from('oneroster_enrollments')
      .select('*')
      .eq('status', 'active')
      .range(offset, offset + limit - 1);

    const parsedFilter = parseOneRosterFilter(filter, 'enrollments');
    if (filter && !parsedFilter) {
      return NextResponse.json({ error: 'Unsupported filter' }, { status: 400 });
    }
    if (parsedFilter) {
      query = query.eq(parsedFilter.column, parsedFilter.value);
    }

    query = query.order('date_last_modified', { ascending: false });

    const { data: enrollments, error } = await query;

    if (error) {
      console.error('OneRoster enrollments query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch enrollments' },
        { status: 500 }
      );
    }

    const response = {
      enrollments: (enrollments || []).map(enrollment => ({
        sourcedId: enrollment.sourced_id,
        status: enrollment.status,
        dateLastModified: enrollment.date_last_modified,
        metadata: enrollment.metadata,
        user: {
          sourcedId: enrollment.user_sourced_id,
        },
        class: {
          sourcedId: enrollment.class_sourced_id,
        },
        role: {
          type: enrollment.role,
        },
        primary: enrollment.primary_flag,
        beginDate: enrollment.begin_date,
        endDate: enrollment.end_date,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('OneRoster enrollments error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

