/**
 * LTI 1.3 OAuth 2.0 Token Endpoint
 * Handles OAuth token requests from LTI tools
 */

import { NextRequest, NextResponse } from 'next/server';
import { handleTokenRequest } from '@/lib/lti/oauth';
import { apiError } from "@/lib/api-errors";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    
    const grant_type = formData.get('grant_type') as string;
    const client_id = formData.get('client_id') as string;
    const client_assertion_type = formData.get('client_assertion_type') as string;
    const client_assertion = formData.get('client_assertion') as string;
    const scope = formData.get('scope') as string;

    if (!grant_type || !client_id || !client_assertion_type || !client_assertion) {
      return NextResponse.json(
        { error: 'Missing required OAuth parameters' },
        { status: 400 }
      );
    }

    // Handle token request
    const tokenResponse = await handleTokenRequest(
      grant_type,
      client_id,
      client_assertion_type,
      client_assertion,
      scope || undefined
    );

    return NextResponse.json(tokenResponse, {
      headers: {
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
      },
    });
  } catch (error: any) {
    return apiError(400, 'invalid_request', error, {
      error_description: 'Failed to issue access token'
    });
  }
}

