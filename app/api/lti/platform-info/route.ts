/**
 * LTI Platform Information Endpoint
 * Returns platform configuration details for external tool registration
 */

import { NextResponse } from 'next/server';
import { getPlatformConfig } from '@/lib/lti/core';
import { createServiceSupabaseClient } from '@/lib/supabase-server';
import { serverError } from "@/lib/api-errors";

export async function GET() {
  try {
    // Get platform configuration
    const platformConfig = await getPlatformConfig();
    
    // Get all active LTI tools with their client IDs and deployment IDs
    const supabase = createServiceSupabaseClient();
    const { data: tools, error: toolsError } = await supabase
      .from('lti_tools')
      .select('id, name, client_id, deployment_id, launch_url, status')
      .eq('status', 'active')
      .order('name');

    if (toolsError) {
      console.error('Error fetching LTI tools:', toolsError);
    }

    // Determine base URL from issuer or environment
    const baseUrl = platformConfig.issuer || process.env.NEXT_PUBLIC_APP_URL || 'https://your-domain.com';

    // Build response
    const platformInfo = {
      lti_version: '1.3.0',
      platform: {
        issuer: platformConfig.issuer,
        authorization_server: platformConfig.authorization_server,
        token_endpoint: platformConfig.token_endpoint,
        jwks_uri: platformConfig.jwks_uri,
        oidc_login_url: `${baseUrl}/api/lti/oidc-login`,
        launch_url: `${baseUrl}/api/lti/launch`,
      },
      endpoints: {
        launch: `${baseUrl}/api/lti/launch`,
        jwks: `${baseUrl}/api/lti/jwks`,
        token: `${baseUrl}/api/lti/token`,
        oidc_login: `${baseUrl}/api/lti/oidc-login`,
      },
      tools: tools?.map(tool => ({
        id: tool.id,
        name: tool.name,
        client_id: tool.client_id,
        deployment_id: tool.deployment_id || 'default',
        launch_url: tool.launch_url,
      })) || [],
      configuration_for_external_tools: {
        platform_issuer: platformConfig.issuer,
        authorization_server: platformConfig.authorization_server,
        token_endpoint: platformConfig.token_endpoint,
        jwks_url: platformConfig.jwks_uri,
        oidc_login_initiation_url: `${baseUrl}/api/lti/oidc-login`,
        redirect_uris: [
          `${baseUrl}/api/lti/oidc-login`,
        ],
      },
    };

    return NextResponse.json(platformInfo, {
      headers: {
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    return serverError('Failed to fetch platform information', error);
  }
}



