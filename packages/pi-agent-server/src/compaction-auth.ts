/**
 * 「会话压缩」 — make the SDK's summarization call use the configured group.
 *
 * Compaction is the SDK's own work: it builds a summarization prompt from the
 * transcript and calls the model through the same auth it uses for the
 * conversation. There is no per-call model parameter on `session.compact()`,
 * but there is exactly one seam where the model, key, headers and env for a
 * *summary* request are decided:
 * `AgentSession._getSummarizationRequestAuth(model)`. Both compaction entry
 * points (manual `/compact` and the automatic threshold/overflow path) resolve
 * their request through it, so wrapping that one method covers every path
 * without touching the conversation's own requests.
 *
 * The route itself is resolved in the main process (see
 * `resolveCompactionRoute`): the group is an endpoint path (`/s/<id>`) plus a
 * public model that group serves, and the subprocess has no gateway config to
 * derive either from. All this module does is substitute them.
 *
 * Only the model description is replaced. Provider, api shape, key and env stay
 * the session's: every group lives on the same gateway, so the transport is
 * identical and only the routing path and the model name change. The one
 * capability that is intentionally turned OFF is `reasoning` — see
 * {@link summarizationAuthForRoute}.
 *
 * Fragility is handled by refusing, not throwing: if a future SDK renames the
 * method, `installCompactionRoute` logs once and compaction keeps using the
 * session's group — a worse route, never a broken turn.
 */

import { MODEL_KIND_OVERRIDE_HEADER } from '../../shared/src/config/model-request-kind.ts'

/** What the main process resolves for one backend. Mirrors `CompactionRoute`. */
export interface CompactionRoute {
  strategyId: string
  /** Public model the compaction group serves. */
  model: string
  /** Gateway endpoint pinned to that group. */
  baseUrl: string
  contextWindow?: number
  maxTokens?: number
}

/** The shape `_getSummarizationRequestAuth` resolves to. */
export interface SummarizationAuth<M = Record<string, unknown>> {
  model: M
  apiKey?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

/**
 * The auth a summary request should use.
 *
 * Absent route (or an empty model) returns the input untouched, so the caller's
 * result is byte-identical to the SDK's own when nothing is configured.
 */
export function summarizationAuthForRoute<M extends Record<string, unknown>>(
  auth: SummarizationAuth<M>,
  route: CompactionRoute | undefined,
): SummarizationAuth<M> {
  if (!route || !route.model || !route.baseUrl) return auth
  const model = {
    ...auth.model,
    id: route.model,
    name: route.model,
    baseUrl: route.baseUrl,
    // A summary is not a reasoning task, and the capability belongs to the
    // model we are switching TO, not the one we came from. Left true, the SDK
    // would attach the session's thinking level to a compaction model that may
    // not accept reasoning parameters at all (a 400 at the upstream, i.e. a
    // compaction that can never succeed).
    reasoning: false,
    ...(route.contextWindow ? { contextWindow: route.contextWindow } : {}),
    ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
  } as M
  return {
    ...auth,
    model,
    // Attribution: the provider header says `chat` for a session process, so
    // without this the summary would be logged as conversation traffic on a
    // group the conversation never used. The override header wins at the
    // gateway, and it is stripped before the request goes upstream.
    headers: { ...(auth.headers ?? {}), [MODEL_KIND_OVERRIDE_HEADER]: 'compaction' },
  }
}

/** The slice of `AgentSession` this module needs — keeps it testable. */
export interface SummarizationCapableSession {
  _getSummarizationRequestAuth?: (model: unknown) => Promise<SummarizationAuth>
}

/**
 * Wrap a session's summarization auth resolution.
 *
 * @returns true when the pin is active (a route was given AND the SDK still has
 *   the seam). False means "compaction runs on the session's group", which is
 *   the documented fallback.
 */
export function installCompactionRoute(
  session: SummarizationCapableSession | null | undefined,
  route: CompactionRoute | undefined,
  log?: (message: string) => void,
): boolean {
  if (!route) return false
  if (!session || typeof session._getSummarizationRequestAuth !== 'function') {
    log?.(
      `[compaction] 「会话压缩」策略组 ${route.strategyId} 未生效：当前 SDK 没有 _getSummarizationRequestAuth；本次会话压缩仍使用会话策略组`,
    )
    return false
  }
  const original = session._getSummarizationRequestAuth.bind(session)
  session._getSummarizationRequestAuth = async (model: unknown) =>
    summarizationAuthForRoute(await original(model), route)
  log?.(
    `[compaction] 会话压缩固定到策略组 ${route.strategyId}（模型 ${route.model}，端点 ${route.baseUrl}）`,
  )
  return true
}
