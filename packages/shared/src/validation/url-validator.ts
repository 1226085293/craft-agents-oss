/**
 * Deterministic Craft MCP URL validation.
 *
 * The valid URL shape is fixed (https://mcp.craft.do/links/<id>/mcp), so this
 * does not need an LLM or an agent SDK. The async signature is kept for
 * existing callers.
 */

import type { AgentError } from '../agent/errors.ts'
import { debug } from '../utils/debug.ts'

export interface UrlValidationResult {
  valid: boolean
  /** Simple error message for validation failures */
  error?: string
  /** Kept for API compatibility; pure URL validation never produces it. */
  typedError?: AgentError
}

const LINK_ID = /^[A-Za-z0-9_-]+$/

/**
 * Validate a Craft MCP URL without an LLM call.
 *
 * Rules:
 * - https only
 * - hostname exactly mcp.craft.do
 * - path /links/<id>/mcp (optional trailing slash)
 * - no credentials, query parameters, or fragments
 * - link id: letters, numbers, hyphens, underscores
 */
export async function validateMcpUrl(
  url: string,
  _apiKey?: string,
  _oauthToken?: string,
): Promise<UrlValidationResult> {
  debug('[url-validator] Validating URL:', url)

  const raw = url.trim()
  if (!raw) {
    return { valid: false, error: 'Enter a Craft MCP URL.' }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      valid: false,
      error: 'Enter a valid URL, e.g. https://mcp.craft.do/links/<id>/mcp',
    }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'URL must start with https://.' }
  }
  if (parsed.hostname.toLowerCase() !== 'mcp.craft.do') {
    return { valid: false, error: 'Hostname must be exactly mcp.craft.do.' }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credentials are not allowed in the URL.' }
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, error: 'URL must not include query parameters or fragments.' }
  }

  const match = parsed.pathname.match(/^\/links\/([^/]+)\/mcp\/?$/)
  if (!match) {
    return { valid: false, error: 'Path must be /links/<id>/mcp.' }
  }
  if (!LINK_ID.test(match[1] ?? '')) {
    return {
      valid: false,
      error: 'Link ID may only contain letters, numbers, hyphens, and underscores.',
    }
  }

  return { valid: true }
}
