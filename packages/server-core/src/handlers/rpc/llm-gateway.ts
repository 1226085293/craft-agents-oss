/**
 * RPC handlers for the in-process LLM gateway.
 *
 * These exist so the settings UI can read live scheduling state and edit
 * `llm-config.json` without owning any of the gateway's internals. Two
 * constraints shaped the surface:
 *
 * - **Writes go through `saveLlmConfig`, never a direct file write.** The
 *   loader validates and refuses an invalid config, so a malformed JSON edit
 *   from the UI is rejected rather than persisted. On success we tell the
 *   watcher the next events are our own, so the save does not look like an
 *   external change and trigger a redundant rebuild.
 * - **Status is pushed, not polled.** `STATUS` broadcasts on an interval so the
 *   cooldown countdowns and in-flight numbers move without the UI asking,
 *   following the same event-sink pattern as `llmConnections.CHANGED`.
 */

import { RPC_CHANNELS, type LlmGatewayStatusPayload, type LlmProviderDetailPayload, type LlmGatewayTestConnectionParams, type LlmGatewayTestConnectionResult, type LlmGatewayListModelsParams, type LlmGatewayListModelsResult } from '@craft-agent/shared/protocol'
import {
  loadLlmConfig,
  emptyLlmConfig,
  saveLlmConfig,
  aggregateOverview,
  aggregateProviderDetail,
  filterUsageByRange,
  recordProbeUsage,
  type UsageRange,
  type LlmConfig,
} from '@craft-agent/shared/config'
import { resolveSetupTestConnectionHint, testBackendConnection } from '@craft-agent/shared/agent/backend'
import { parseTestConnectionError } from '@craft-agent/server-core/domain'
import { buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

/** How often the gateway's live state is broadcast to clients. */
const STATUS_PUSH_INTERVAL_MS = 2000

/**
 * Derive the `GET /models` URL from a provider's baseUrl.
 *
 * baseUrl is whatever the user pasted, and it is not normalised on the way
 * in: it can be a bare origin (`https://api.x.cn`), a version root
 * (`https://api.x.cn/v1`) or a full chat endpoint
 * (`https://api.x.cn/v1/chat/completions` — the shape the settings form
 * suggests). The OpenAI convention is `/v1/models`, so the version segment is
 * kept when present and added when not; a trailing chat path is dropped.
 *
 * Anthropic-messages providers use `/v1/models` too, so the protocol does not
 * change the answer here.
 */
/**
 * The `GET /models` URL for a provider's base URL.
 *
 * Two details matter for real relays:
 *
 * 1. **Query strings survive.** An upstream that selects a tenant by query
 *    (`.../v1/chat/completions?realm=cn`) needs that parameter on every path,
 *    not just the chat one — dropping it made probing such a relay fail with
 *    an auth error that looked like a bad key.
 * 2. **A full endpoint is accepted.** Users paste the chat/completions URL
 *    they were given, so the path suffix is stripped before `/models` is
 *    appended. Stripping keeps any query, because the parameter usually
 *    applies to the whole relay.
 */
export function modelsEndpointFor(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  // Drop everything from /chat/completions, /messages or /responses onward.
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages|responses)\/?$/i, '')
  const segs = url.pathname.split('/').filter(Boolean)
  if (!segs.some((s) => /^v\d+$/i.test(s))) segs.push('v1')
  url.pathname = `/${[...segs, 'models'].join('/')}`
  // `URL.toString()` keeps `search` (and `hash`, which carries no meaning
  // here) — this is what preserves `?realm=cn` on the probed request.
  return url.toString()
}

/**
 * Pull model ids out of a `GET /models` response.
 *
 * The OpenAI shape is `{ data: [{ id }] }`, but relays vary: some nest under
 * `models`, some return a bare array, and a few send a map of
 * model-id -> object. Accepting the common variants costs little and keeps a
 * working upstream from being reported as "no models".
 *
 * Ids are de-duplicated while preserving order — the upstream order is the
 * one shown in the picker.
 */
export function extractModelIds(body: unknown): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>
      // `id` wins: the upstream id is what the config stores.
      if (typeof rec.id === 'string') push(rec.id)
      else if (typeof rec.model === 'string') push(rec.model)
      else if (typeof rec.name === 'string') push(rec.name)
      return
    }
    push(v)
  }
  if (Array.isArray(body)) {
    walk(body)
    return out
  }
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>
    if (Array.isArray(rec.data)) walk(rec.data)
    else if (Array.isArray(rec.models)) walk(rec.models)
    else Object.keys(rec).forEach((k) => push(k))
  }
  return out
}

function snapshotStatus(status: {
  running: boolean
  port: number
  baseUrl: string
  strategies: Array<{ id: string; type: string; providers: number; name?: string }>
  lastModels?: Record<string, string>
  coolingKeys: number
  inFlight: number
  enabled: boolean
  generation?: number
  keyStates?: Array<{ provider: string; keyId: string; cooling: boolean; cooldownRemaining: number; inFlight: number; available: boolean; weight: number }>
}): LlmGatewayStatusPayload {
  return {
    running: status.running,
    port: status.port,
    baseUrl: status.baseUrl,
    enabled: status.enabled,
    ...(typeof status.generation === 'number' ? { generation: status.generation } : {}),
    strategies: status.strategies,
    // Only forwarded when present: a build whose runtime predates the field
    // would otherwise render `undefined` in the composer's label.
    ...(status.lastModels ? { lastModels: status.lastModels } : {}),
    coolingKeys: status.coolingKeys,
    inFlight: status.inFlight,
    // Cooldown countdowns need this to move; the counts alone cannot place a
    // cooldown on a specific row of the key table.
    keyStates: status.keyStates ?? [],
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmGateway.GET_STATUS,
  RPC_CHANNELS.llmGateway.GET_CONFIG,
  RPC_CHANNELS.llmGateway.GET_USAGE,
  RPC_CHANNELS.llmGateway.QUERY_LOGS,
  RPC_CHANNELS.llmGateway.GET_PROVIDER_DETAIL,
  RPC_CHANNELS.llmGateway.SAVE_CONFIG,
  RPC_CHANNELS.llmGateway.CLEAR_KEY_COOLDOWN,
  RPC_CHANNELS.llmGateway.TEST_CONNECTION,
  RPC_CHANNELS.llmGateway.LIST_MODELS,
]

/**
 * Which key (if any) authenticates a model-listing request.
 *
 * `key` is undefined when there is no usable key — the probe then runs
 * unauthenticated. That is the normal case for a local relay that trusts its
 * caller, and many public upstreams serve `/models` without credentials; the
 * old hard requirement made those connections undiscoverable until the user
 * invented a placeholder secret.
 *
 * An explicit `keyId` is still honoured strictly: the caller picked that key,
 * so a missing or disabled one is an error rather than a silent fallback.
 * A cooling key is fine — cooling gates chat traffic, not the catalogue.
 */
export function pickModelKey<K extends { id: string; enabled?: boolean }>(
  keys: readonly K[],
  keyId?: string,
): { key?: K; error?: string } {
  if (keyId) {
    const chosen = keys.find((k) => k.id === keyId)
    if (!chosen) return { error: `key not found: ${keyId}` }
    if (chosen.enabled === false) return { error: '该 key 已停用' }
    return { key: chosen }
  }
  return { key: keys.find((k) => k.enabled !== false) }
}

export function registerLlmGatewayHandlers(server: RpcServer, deps: HandlerDeps): void {
  const access = deps.llmGateway
  const runtime = access?.runtime

  server.handle(RPC_CHANNELS.llmGateway.GET_STATUS, async (): Promise<LlmGatewayStatusPayload> => {
    // An unarmed host reports inert state rather than erroring: the page then
    // shows "not configured" instead of a broken request.
    if (!runtime) {
      return {
        running: false,
        port: 0,
        baseUrl: '',
        enabled: false,
        strategies: [],
        coolingKeys: 0,
        inFlight: 0,
      }
    }
    return snapshotStatus(runtime.status())
  })

  server.handle(RPC_CHANNELS.llmGateway.GET_CONFIG, async (): Promise<LlmConfig> => {
    // An absent file is the first-run state, not a failure. Returning null made
    // the page show "could not read the config" with no way to create one, so a
    // fresh install could never configure the gateway.
    return loadLlmConfig() ?? emptyLlmConfig()
  })

  /**
   * Aggregate usage for the overview page.
   *
   * Reads the append-only log on demand rather than caching: the file is small
   * in the regime this matters (a few thousand lines) and a stale cache on a
   * dashboard is worse than a full scan.
   *
   * `params.range` scopes the whole aggregate server-side, so the overview's
   * time filter drives every card from one window instead of each view
   * re-deriving its own.
   */
  server.handle(
    RPC_CHANNELS.llmGateway.GET_USAGE,
    async (_ctx, params: { range?: UsageRange } | undefined) => {
      // Same reason as QUERY_LOGS: do not present a dashboard that is up to one
      // flush interval behind the requests it is describing.
      try {
        runtime?.flushUsage()
      } catch {
        // Observability only.
      }
      // Derived from the same records the log page shows, so the two can never
      // disagree. They did while the overview had its own persisted bucket
      // file: the detail log is cleared at startup and that file was not, so
      // after a restart the overview counted requests the log did not have.
      const shared = await import('@craft-agent/shared/config')
      const records = shared.readLlmUsage()
      const buckets = shared.bucketsFromRecords(records)
      const overview = {
        ...shared.aggregateFromBuckets(buckets, params?.range),
        // The day view plots hours; buckets are per-day, so this one series
        // comes straight from the records.
        hourly: shared.hourlyTokens(records),
      }
      return {
        overview,
        totalRecords: overview.outcomes.success + overview.outcomes.failed,
      }
    },
  )

  /**
   * Log page query: tags (AND), time order, and a hard cap applied after
   * filtering. Reading happens in the store so the UI never loads the whole
   * history into memory.
   */
  server.handle(
    RPC_CHANNELS.llmGateway.QUERY_LOGS,
    async (_ctx, params: { tags?: Array<{ field: string; value: string }>; sort?: 'desc' | 'asc'; limit?: number } | undefined) => {
      // Records sit in the gateway's buffer until the 30s flush timer drains
      // them, which made the "real-time" log up to half a minute stale no matter
      // how often the page polled. Draining here is the same call that timer
      // makes, so an idle read costs nothing.
      try {
        runtime?.flushUsage()
      } catch {
        // Usage is observability: a failed flush must not fail the read.
      }
      const shared = await import('@craft-agent/shared/config')
      const result = shared.queryLlmUsage({
        tags: (params?.tags ?? []) as never,
        sort: params?.sort,
        limit: params?.limit ?? 5000,
      })
      return { rows: result.rows, truncated: result.truncated }
    },
  )

  /**
   * Per-provider detail for the provider view's three tabs.
   *
   * Returns null when the provider has no usage yet rather than an empty
   * shell, so the view can say "no requests recorded" instead of rendering
   * four zeroed charts that read like a broken feed.
   */
  server.handle(
    RPC_CHANNELS.llmGateway.GET_PROVIDER_DETAIL,
    async (_ctx, providerId: string): Promise<LlmProviderDetailPayload | null> => {
      const records =
        access?.readUsage() ?? (await import('@craft-agent/shared/config')).readLlmUsage()
      return aggregateProviderDetail(
        records,
        String(providerId ?? ''),
        20,
      )
    },
  )

  server.handle(
    RPC_CHANNELS.llmGateway.SAVE_CONFIG,
    async (_ctx, config: unknown): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
      const result = saveLlmConfig(config as LlmConfig)
      if (result.ok) {
        // Suppress the echo: our own write must not look like an external edit
        // and cause a redundant rebuild of every pool.
        access?.markSelfWrite()
        runtime?.refresh()
      }
      return result
    },
  )

  /**
   * Explicit "test connection" probe for one gateway provider.
   *
   * The page used to derive connection health from the usage log, which only
   * answers "did traffic ever work" — never "is this key good right now". This
   * sends one minimal request through the same backend factory the real agents
   * use, so a green result means the key actually works today.
   *
   * Also persists `lastVerifiedAt` / `lastTestOk` on the provider. Nothing else
   * writes those fields — the view model reads them to render "从未测试" and the
   * onboarding's step 2, so leaving the write to a caller that does not exist
   * made both permanently wrong.
   */
  server.handle(
    RPC_CHANNELS.llmGateway.TEST_CONNECTION,
    async (_ctx, params: LlmGatewayTestConnectionParams): Promise<LlmGatewayTestConnectionResult> => {
      const providerId = String(params?.providerId ?? '')
      const startedAt = Date.now()
      const fail = (error: string): LlmGatewayTestConnectionResult => ({
        success: false,
        error,
        elapsedMs: Date.now() - startedAt,
      })

      const config = loadLlmConfig()
      const provider = config?.providers.find((p) => p.id === providerId)
      if (!provider) return fail(`provider not found: ${providerId}`)

      const key = params.keyId
        ? provider.keys.find((k) => k.id === params.keyId)
        : provider.keys.find((k) => k.enabled !== false) ?? provider.keys[0]
      if (!key) return fail('该连接没有可测试的 key')
      if (key.enabled === false) return fail('该 key 已停用')

      // The probe must name a real upstream model id: `models` maps upstream id
      // -> public name, and the upstream is what answers the request.
      const upstreamModels = Object.keys(provider.models ?? {})
      const model = params.model?.trim() || upstreamModels[0]
      if (!model) return fail('该连接没有配置模型，无法测试')

      const hint = resolveSetupTestConnectionHint({
        provider: 'pi',
        baseUrl: provider.baseUrl,
        customEndpoint: { api: provider.protocol },
      })

      /** Record the outcome on the provider so the UI can say when it last ran. */
      const persistOutcome = (ok: boolean): void => {
        try {
          const current = loadLlmConfig()
          if (!current) return
          saveLlmConfig({
            ...current,
            providers: current.providers.map((p) =>
              p.id === providerId ? { ...p, lastVerifiedAt: Date.now(), lastTestOk: ok } : p,
            ),
          })
        } catch (error) {
          // A failed write must not turn a successful test into an error.
          deps.platform.logger?.warn?.(
            `[llmGateway.testConnection] could not persist outcome: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      try {
        const probeStartedAt = Date.now()
        const result = await testBackendConnection({
          provider: 'pi',
          apiKey: key.key,
          model,
          baseUrl: provider.baseUrl,
          timeoutMs: 45000,
          hostRuntime: buildBackendHostRuntimeContext(deps.platform),
          connection: hint,
        })
        // Same reasoning as the connections page: the probe bypasses the
        // gateway, so this is the only place that can record it. `strategy`
        // stays empty — a probe is never routed.
        recordProbeUsage({
          provider: provider.id,
          keyId: key.id,
          model,
          success: result.success,
          totalMs: Date.now() - probeStartedAt,
          ...(result.success ? {} : { error: result.error }),
        })
        persistOutcome(result.success)
        if (!result.success) return fail(parseTestConnectionError(result.error || 'Unknown error'))
        return { success: true, elapsedMs: Date.now() - startedAt }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        recordProbeUsage({
          provider: provider.id,
          keyId: key.id,
          model,
          success: false,
          totalMs: Date.now() - startedAt,
          error: msg,
        })
        persistOutcome(false)
        return fail(parseTestConnectionError(msg))
      }
    },
  )

  // Ask the upstream which models it serves. A provider can be created with
  // valid keys but no models configured, and without this the settings page
  // had nothing to offer: the model pool is a union of already-configured ids,
  // and the connection probe refuses to run without a model name.
  server.handle(
    RPC_CHANNELS.llmGateway.LIST_MODELS,
    async (_ctx, params: LlmGatewayListModelsParams): Promise<LlmGatewayListModelsResult> => {
      const startedAt = Date.now()
      const fail = (error: string): LlmGatewayListModelsResult => ({
        success: false,
        error,
        models: [],
        elapsedMs: Date.now() - startedAt,
      })

      const config = loadLlmConfig()
      const provider = config?.providers.find((p) => p.id === params?.providerId)
      if (!provider) return fail(`provider not found: ${String(params?.providerId)}`)

      const endpoint = modelsEndpointFor(provider.baseUrl)
      if (!endpoint) return fail('API 地址不是合法的 URL，无法探测模型')

      // Same key choice as the connection probe, except that "no key" is a
      // valid outcome: the request then goes out unauthenticated.
      const picked = pickModelKey(provider.keys, params?.keyId)
      if (picked.error) return fail(picked.error)
      const key = picked.key

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const res = await fetch(endpoint, {
          headers: key
            ? { authorization: `Bearer ${key.key}`, accept: 'application/json' }
            : { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) {
          return fail(
            res.status === 401 || res.status === 403
              ? key
                ? '上游拒绝了密钥（401/403）'
                : '上游要求密钥（401/403）：给该连接添加一个 key 后再探测'
              : `上游返回 ${res.status} ${res.statusText}`.trim(),
          )
        }
        const body: unknown = await res.json()
        const ids = extractModelIds(body)
        if (ids.length === 0) return fail('上游未返回任何模型')
        return { success: true, models: ids, elapsedMs: Date.now() - startedAt }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return fail(/abort/i.test(msg) ? '探测超时（15s）' : parseTestConnectionError(msg))
      } finally {
        clearTimeout(timer)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.llmGateway.CLEAR_KEY_COOLDOWN,
    async (_ctx, args: { provider?: string; keyId?: string }): Promise<{ ok: boolean }> => {
      const ok = (await runtime?.clearKeyCooldown(args?.provider, args?.keyId)) ?? false
      return { ok }
    },
  )

  // Push live state so cooldowns and in-flight counts move without polling.
  // Broadcast to every connected client: the settings page may be open in more
  // than one window, and all of them show the same gateway.
  const timer = setInterval(() => {
    if (!runtime) return;
    try {
      pushTyped(server, RPC_CHANNELS.llmGateway.STATUS, { to: 'all' }, snapshotStatus(runtime.status()))
    } catch {
      // A disconnected client is normal; the next tick will find another one.
    }
  }, STATUS_PUSH_INTERVAL_MS)
  // The server owns its own shutdown path; do not hold the event loop open
  // just for status pushes.
  timer.unref?.()
}
