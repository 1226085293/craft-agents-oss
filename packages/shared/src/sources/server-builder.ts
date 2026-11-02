/**
 * Shared source server config helpers.
 */

import type { ApiConfig, LoadedSource } from './types.ts';

export const SERVER_BUILD_ERRORS = {
  AUTH_REQUIRED: 'Authentication required',
  TOKEN_EXPIRED: 'Token expired',
  CREDENTIALS_NEEDED: 'Credentials needed',
} as const;

/** Normalize MCP URL to standard format (removes trailing slashes). */
export function normalizeMcpUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Build an ApiConfig from a loaded API source. */
export function buildApiConfig(source: LoadedSource): ApiConfig {
  const api = source.config.api!;

  const config: ApiConfig = {
    name: source.config.slug,
    baseUrl: api.baseUrl,
    defaultHeaders: api.defaultHeaders,
  };

  switch (api.authType) {
    case 'bearer':
      config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
      break;
    case 'header':
      config.auth = { type: 'header', headerName: api.headerName || 'x-api-key' };
      break;
    case 'query':
      config.auth = { type: 'query', queryParam: api.queryParam || 'api_key' };
      break;
    case 'basic':
      config.auth = { type: 'basic' };
      break;
    case 'oauth':
      // Generic OAuth tokens are sent as Bearer tokens
      config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
      break;
    case 'none':
    default:
      config.auth = { type: 'none' };
  }

  return config;
}
