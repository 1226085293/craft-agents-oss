/**
 * Source → server-config builder, shared by session startup and the pages
 * action executor.
 *
 * Turns LoadedSources into Pi-compatible MCP / in-process API server configs
 * with credentials resolved at build time and refresh wired for OAuth /
 * renew-endpoint sources.
 */

import { createScopedLogger, CONSOLE_LOGGER, type Logger } from '@craft-agent/server-core/runtime'
import {
  getSourceCredentialManager,
  isApiOAuthProvider,
  hasRenewEndpoint,
  SERVER_BUILD_ERRORS,
  TokenRefreshManager,
  createTokenGetter,
  buildApiConfig,
  normalizeMcpUrl,
  isSourceUsable,
  isMultiHeaderCredential,
  type LoadedSource,
  type SummarizeCallback,
  type ApiConfig,
  type ApiCredential,
} from '@craft-agent/shared/sources'
import { perf } from '@craft-agent/shared/utils'

const defaultLog = createScopedLogger(CONSOLE_LOGGER, 'sources')

export type SdkMcpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; lazy?: boolean }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export interface BuiltServerConfigs {
  mcpServers: Record<string, SdkMcpServerConfig>
  apiServers: Record<string, {
    config: ApiConfig
    getToken?: () => Promise<string>
    getCredential?: () => Promise<ApiCredential | null>
    summarize?: SummarizeCallback
  }>
  errors: Array<{ sourceSlug: string; error: string }>
}

export async function buildServersFromSources(
  sources: LoadedSource[],
  _sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback,
  log: Logger = defaultLog
): Promise<BuiltServerConfigs> {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()

  const sourcesWithCreds = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => log.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    if (hasRenewEndpoint(source)) {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => log.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    return async () => credManager.getApiCredential(source)
  }

  const mcpServers: Record<string, SdkMcpServerConfig> = {}
  const apiServers: BuiltServerConfigs['apiServers'] = {}
  const errors: BuiltServerConfigs['errors'] = []

  for (const { source, token, credential } of sourcesWithCreds) {
    if (!isSourceUsable(source)) continue
    const slug = source.config.slug

    if (source.config.type === 'mcp') {
      const mcp = source.config.mcp
      if (!mcp) {
        errors.push({ sourceSlug: slug, error: 'MCP source missing mcp config' })
        continue
      }

      if (mcp.transport === 'stdio') {
        if (!mcp.command) {
          errors.push({ sourceSlug: slug, error: 'Stdio source missing command' })
          continue
        }
        mcpServers[slug] = {
          type: 'stdio',
          command: mcp.command,
          args: mcp.args,
          env: mcp.env,
          lazy: mcp.lazy ?? true,
        }
        continue
      }

      if (!mcp.url) {
        errors.push({ sourceSlug: slug, error: 'HTTP/SSE source missing URL' })
        continue
      }

      // Layer headers with increasing precedence:
      // 1. Static headers from config (non-secret)
      // 2. Credential-store headers (secret API keys via headerNames)
      // 3. Authorization bearer token (OAuth/bearer auth — highest priority)
      let mergedHeaders: Record<string, string> = {}
      if (mcp.headers) mergedHeaders = { ...mcp.headers }
      if (credential && isMultiHeaderCredential(credential)) {
        mergedHeaders = { ...mergedHeaders, ...credential }
      }
      if (mcp.authType !== 'none') {
        if (token) {
          mergedHeaders.Authorization = `Bearer ${token}`
        } else if (source.config.isAuthenticated) {
          errors.push({ sourceSlug: slug, error: SERVER_BUILD_ERRORS.AUTH_REQUIRED })
          continue
        }
      }

      mcpServers[slug] = {
        type: mcp.transport === 'sse' ? 'sse' : 'http',
        url: normalizeMcpUrl(mcp.url),
        ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      }
      continue
    }

    if (source.config.type === 'api') {
      if (!source.config.api) {
        errors.push({ sourceSlug: slug, error: 'API source missing api config' })
        continue
      }
      if (!source.config.isAuthenticated) {
        errors.push({ sourceSlug: slug, error: SERVER_BUILD_ERRORS.AUTH_REQUIRED })
        continue
      }
      apiServers[slug] = {
        config: buildApiConfig(source),
        getToken: getTokenForSource(source),
        getCredential: getCredentialForSource(source),
        summarize,
      }
      continue
    }

    errors.push({ sourceSlug: slug, error: `Unsupported source type: ${String(source.config.type)}` })
  }

  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(mcpServers).length)
  span.setMetadata('apiCount', Object.keys(apiServers).length)

  for (const error of errors) {
    if (error.error !== SERVER_BUILD_ERRORS.AUTH_REQUIRED) continue
    const source = sources.find(s => s.config.slug === error.sourceSlug)
    if (!source) continue

    const cred = await credManager.load(source)
    const isExpiredRefreshable =
      cred &&
      (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
      (cred.refreshToken || hasRenewEndpoint(source))

    if (isExpiredRefreshable) {
      error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
      log.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
      continue
    }

    credManager.markSourceNeedsReauth(source, 'Token missing or expired')
    log.info(`Marked source ${error.sourceSlug} as needing re-auth`)
  }

  span.end()
  return { mcpServers, apiServers, errors }
}
