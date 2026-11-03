/**
 * Where a session's *compaction* call goes.
 *
 * Compaction is the one request the agent makes that is not the conversation:
 * it summarizes the transcript and throws the original away. Running it on the
 * session's own group is a reasonable default, but it competes with the
 * conversation for the same quota, and on a group whose models are expensive or
 * rate-limited it is the worst possible use of them — a summary is a small,
 * mechanical job.
 *
 * So the gateway settings grew 「会话压缩」 (`compactionStrategy`): a group the
 * summarization call is pinned to, exactly like 「记忆整理」 (`miniStrategy`)
 * pins memory consolidation. Empty means "follow the session", which keeps the
 * old behaviour byte-for-byte.
 *
 * How the pin works, and why it is resolved here rather than in the subprocess:
 *
 * The gateway's group is not a config value the summarization call can name — it
 * is the *endpoint path* (`/s/<strategyId>`) plus a public model that group
 * actually serves. The subprocess only knows the session's own `/s/<id>` URL, so
 * the main process resolves the whole triple (endpoint + model + id) once, when
 * it builds the backend's init message, and the subprocess just uses it for
 * summarization. Resolving it up here also means the choice follows the config
 * that the *session* was started with, not a config file read from inside the
 * subprocess.
 *
 * Deliberately silent on failure: a compaction group that has been deleted,
 * disabled, emptied, or that cannot be expressed against this session's endpoint
 * must not break sessions. It falls back to "no pin", and compaction runs on the
 * session's group exactly as before.
 */

import type { ModelWindow } from './model-window.ts'
import { pickStrategyModel } from './strategy-availability.ts'

/** A resolved compaction target, as sent to the backend's subprocess. */
export interface CompactionRoute {
  /** The strategy group the summarization request is pinned to. */
  strategyId: string
  /** A public model that group serves — the summarization request names it. */
  model: string
  /** Gateway endpoint for that group, e.g. `http://127.0.0.1:8787/s/compact`. */
  baseUrl: string
  /**
   * The model's declared context window. The summarization call sizes its
   * output against it (`0.8 * reserve`) and detects an overflowing prompt with
   * it, so guessing the *session* model's window here would either truncate a
   * summary that had room or overflow an upstream that did not.
   */
  contextWindow?: number
  /** Declared output ceiling, when the group's providers say what it is. */
  maxTokens?: number
}

/** The config fields this module reads. Structural, so tests need no full config. */
export interface CompactionRouteConfig {
  compactionStrategy?: string
  strategies?: ReadonlyArray<{
    id: string
    enabled?: boolean
    modelAliases?: Record<string, unknown>
    members?: ReadonlyArray<{ provider: string; model?: string; enabled?: boolean }>
    modelProviders?: Record<string, string[]>
  }>
  providers?: ReadonlyArray<{
    id: string
    enabled?: boolean
    timeWindows?: Record<string, ModelWindow>
    modelOptions?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
  }>
}

/**
 * Re-point a gateway URL from one strategy to another.
 *
 * The session's endpoint is `${gateway}/s/<sessionStrategy>` (built by
 * `applyGatewayStrategy`), and every group lives on that same gateway under the
 * same shape — so swapping the second path segment moves the request without
 * touching host, port or anything after it.
 *
 * Returns `undefined` for a URL that is not a strategy-scoped gateway endpoint:
 * a direct connection has no group to move to, and guessing would send the
 * summary to the upstream provider with a model name it does not know.
 */
export function repointStrategyBaseUrl(
  baseUrl: string | undefined,
  strategyId: string,
): string | undefined {
  if (!baseUrl || !strategyId) return undefined
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  const parts = url.pathname.split('/')
  // ['', 's', '<id>', ...] — the gateway is mounted under /s/<id>.
  if (parts[1] !== 's' || !parts[2]) return undefined
  parts[2] = encodeURIComponent(strategyId)
  url.pathname = parts.join('/')
  // Trailing slash is noise to an HTTP client but makes the two endpoints look
  // different in logs; drop it.
  return url.toString().replace(/\/+$/, '')
}

/**
 * Resolve the compaction pin for a session, or `undefined` when it should keep
 * using its own group.
 *
 * @param config   the gateway config (or `null` when none is configured yet)
 * @param sessionBaseUrl the session backend's gateway endpoint, i.e. its
 *   connection `baseUrl` — `http://host:port/s/<sessionStrategy>`
 * @param now      clock, injected so availability windows are testable
 */
export function resolveCompactionRoute(
  config: CompactionRouteConfig | null | undefined,
  sessionBaseUrl: string | undefined,
  now: number = Date.now(),
): CompactionRoute | undefined {
  const strategyId = config?.compactionStrategy
  if (!strategyId) return undefined
  const strategy = config?.strategies?.find((s) => s.id === strategyId)
  if (!strategy) return undefined
  // A disabled group refuses to route at the gateway, so pinning to it would
  // turn every compaction into a 404 instead of a summary.
  if (strategy.enabled === false) return undefined
  const models = Object.keys(strategy.modelAliases ?? {})
  if (models.length === 0) return undefined
  const baseUrl = repointStrategyBaseUrl(sessionBaseUrl, strategyId)
  if (!baseUrl) return undefined
  // Same rule the router uses for the session's own request: honour a model the
  // caller asked for only if the group is open for it right now, otherwise take
  // the first open one in the group's declared order.
  const model = pickStrategyModel(
    strategy,
    models,
    config?.providers as Parameters<typeof pickStrategyModel>[2],
    undefined,
    now,
  )
  return { strategyId, model, baseUrl, ...declaredModelSize(strategy, config?.providers, model) }
}

/**
 * The model's declared size, from the first enabled member whose provider
 * declares it.
 *
 * Mirrors `routedConnectionModels` in the session layer: a capability is read
 * from the provider that serves the model, because that is where the upstream's
 * real limits live. Nothing declared means nothing is sent, and the subprocess
 * keeps the session model's numbers.
 */
function declaredModelSize(
  strategy: NonNullable<CompactionRouteConfig['strategies']>[number],
  providers: CompactionRouteConfig['providers'],
  model: string,
): { contextWindow?: number; maxTokens?: number } {
  for (const member of strategy.members ?? []) {
    if (member.enabled === false) continue
    // A member that names another model is a fallback route for that model, not
    // a declaration about this one.
    if (member.model && member.model !== model) continue
    const declared = providers?.find((p) => p.id === member.provider)?.modelOptions?.[model]
    if (!declared) continue
    const size = {
      ...(declared.contextWindow ? { contextWindow: declared.contextWindow } : {}),
      ...(declared.maxOutputTokens ? { maxTokens: declared.maxOutputTokens } : {}),
    }
    if (Object.keys(size).length > 0) return size
  }
  return {}
}
