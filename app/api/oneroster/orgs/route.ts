/**
 * OneRoster Organizations Endpoint
 * GET /ims/oneroster/v1p1/orgs
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateOneRosterRequest, parseOneRosterFilter, ONEROSTER_FILTER_FIELDS } from '@/lib/oneroster/auth';
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

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');
    const filter = searchParams.get('filter');
    const sort = searchParams.get('sort');
    const orderBy = searchParams.get('orderBy');

    // Query organizations
    const supabase = createServiceSupabaseClient();
    let query = supabase
      .from('oneroster_organizations')
      .select('*')
      .eq('status', 'active')
      .range(offset, offset + limit - 1);

    // Apply filters if provided
    const parsedFilter = parseOneRosterFilter(filter, 'orgs');
    if (filter && !parsedFilter) {
      return NextResponse.json({ error: 'Unsupported filter' }, { status: 400 });
    }
    if (parsedFilter) {
      query = query.eq(parsedFilter.column, parsedFilter.value);
    }

    // Apply sorting
    const requestedSort = sort || 'name';
    const sortColumn = ONEROSTER_FILTER_FIELDS.orgs[requestedSort]
      ?? (Object.values(ONEROSTER_FILTER_FIELDS.orgs).includes(requestedSort) ? requestedSort : 'name');
    const ascending = (orderBy || 'asc').toLowerCase() !== 'desc';
    query = query.order(sortColumn, { ascending });

    const { data: orgs, error } = await query;

    if (error) {
      console.error('OneRoster orgs query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch organizations' },
        { status: 500 }
      );
    }

    // Format OneRoster response
    const response = {
      orgs: (orgs || []).map(org => ({
        sourcedId: org.sourced_id,
        status: org.status,
        dateLastModified: org.date_last_modified,
        metadata: org.metadata,
        name: org.name,
        identifier: org.identifier,
        type: org.type,
        parent: org.parent_sourced_id ? {
          sourcedId: org.parent_sourced_id,
        } : null,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('OneRoster orgs error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

