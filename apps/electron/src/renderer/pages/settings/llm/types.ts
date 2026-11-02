/**
 * Shapes for the LLM gateway settings page (v30 rewrite).
 *
 * Structural mirrors of the RPC payloads — deliberately not importing the
 * shared types directly: the renderer bundle stays smaller and the page keeps
 * compiling when the shared config barrel changes shape underneath it. Where a
 * name differs between the prototype (`pages/llm/config.json`) and the real
 * schema (`packages/shared/src/config/llm-config.ts`), the comment says which
 * way it maps.
 *
 * Prototype → real schema renames we apply here:
 *   providers[].url            → providers[].baseUrl
 *   providers[].keys[].value   → providers[].keys[].key
 *   presets[].limits.rateLimitCooldownSeconds → presets[].rateLimitSeconds
 *   presets[].limits.quotaExhaustedCooldownSeconds → presets[].quotaExhaustedSeconds
 *   strategies[].members (string[]) → strategies[].members ({provider,weight}[])
 *   strategies[].weights{}     → folded into members[].weight
 *   strategies[].sticky (bool) → strategies[].stickySession {enabled,...}
 */

/** Live gateway state, broadcast by the main process every 2s. */
export interface GatewayStatus {
  running: boolean
  port: number
  baseUrl: string
  enabled: boolean
  /** Config rebuild counter; a change means the on-disk config moved. */
  generation?: number
  strategies: Array<{ id: string; type: string; providers: number }>
  coolingKeys: number
  inFlight: number
  keyStates?: Array<{
    provider: string
    keyId: string
    cooling: boolean
    cooldownRemaining: number
    inFlight: number
    available: boolean
    weight: number
  }>
}

/** Named bucket for the overview's global time filter. */
export type TimeBucket = 'day' | 'week' | 'month' | 'all'

/**
 * The reserved preset id every provider/key falls back to.
 *
 * Built in, not user-created: the fallback has to exist for the fallback to
 * mean anything. `resolvePreset` already ended its chain with `?? 'default'`,
 * so without a seeded row the effective default was real but invisible and
 * uneditable. Non-deletable for the same reason — deleting it would strand
 * every unset reference.
 */
export const DEFAULT_PRESET_ID = 'default'

export interface UsageOverview {
  totals: {
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    totalTokens: number
  }
  outcomes: { success: number; retried: number; failed: number }
  successRate: number | null
  firstByte: { p50: number | null; p95: number | null }
  /** Last 24 hours, oldest first. Drives the day view's hourly bars. */
  hourly?: Array<{
    hour: number
    prompt: number
    completion: number
    /** Cache-read prompt tokens in this hour; absent on payloads from older builds. */
    cached?: number
    success: number
    failed: number
  }>
  daily: Array<{
    day: string
    success: number
    retried: number
    failed: number
    promptTokens: number
    completionTokens: number
    /** Cache-read prompt tokens that day; absent on payloads from older builds. */
    cachedTokens?: number
  }>
  byProvider: Array<{
    provider: string
    requests: number
    success: number
    failed: number
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
    totalTokens: number
    avgFirstByteMs: number | null
    lastStatus?: 'success' | 'error'
    lastTs?: number
    sessionCount?: number
  }>
  byStrategy: Array<{ strategy: string; requests: number; totalTokens: number }>
  byModel: Array<{ upstreamModel: string; requests: number; totalTokens: number }>
  sessionCount: number
}

/**
 * One limit window on a preset: `amount` per `per` × `perUnit`.
 *
 * `sliding: true` (default) = the last N seconds (rolling). `sliding: false`
 * = a fixed window that resets at the UTC boundary of its period — a 24-hour
 * window resets at UTC midnight, matching how upstreams reset daily quotas.
 */
export interface CustomLimit {
  amount: number
  unit: 'requests' | 'tokens'
  per: number
  perUnit: 'seconds' | 'minutes' | 'hours'
  /** Sliding (default) vs fixed window that resets at the UTC period boundary. */
  sliding?: boolean
}

/** A preset (the prototype's "type"). `id` doubles as the display name. */
export interface LlmPresetShape {
  id: string
  /**
   * Legacy fixed windows. Read once to migrate an existing config into
   * `customLimits`; never written back, and no longer shown in the card.
   */
  rpm?: number
  rpd?: number
  tpm?: number
  tpd?: number
  qps?: number
  tpr?: number
  concurrency?: number
  firstByteSeconds?: number
  totalSeconds?: number
  defaultSeconds?: number
  /** Prototype name: `rateLimitCooldownSeconds`. */
  rateLimitSeconds?: number
  /** Prototype name: `quotaExhaustedCooldownSeconds`. */
  quotaExhaustedSeconds?: number
  customLimits?: CustomLimit[]
  /** How many providers/keys currently resolve to this preset. */
  usage?: { providers: number; keys: number }
}

/** Time-range enablement (prototype v24–v28), keyed by public model name. */
export interface ModelWindow {
  tz: string
  from?: string
  to?: string
  /** ISO weekday numbers, 1=Mon … 7=Sun. Absent = every day. */
  days?: number[]
  spans?: Array<{ start: string; end: string }>
}

/**
 * Per-model capability declaration, keyed by public model name.
 *
 * Mirrors the shared `LlmModelOptions` one-for-one: the settings page edits
 * these and writes them back through the same config object the gateway
 * validated, so a field renamed here would silently stop round-tripping.
 */
export interface LlmModelOptionsShape {
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  /**
   * Levels the upstream accepts. Optional: the gateway sends whatever the
   * session picked and steps down on a refusal, so this is a shortcut for an
   * unusual relay, not a requirement (2026-10-30).
   */
  reasoningEfforts?: string[]
}

export interface LlmKeyShape {
  id: string
  key: string
  note?: string
  enabled?: boolean
  /** Empty string = inherit the provider's `defaultPreset`. */
  preset?: string
}

/** Live per-key scheduling state, pushed by the gateway's STATUS event. */
export interface LlmKeyStateShape {
  provider: string
  keyId: string
  cooling: boolean
  cooldownRemaining: number
  inFlight: number
  available: boolean
  weight: number
}

export interface LlmProviderShape {
  id: string
  name: string
  /** Free-text label for humans scanning a wall of same-host providers. */
  note?: string
  baseUrl: string
  protocol: string
  enabled: boolean
  keys: LlmKeyShape[]
  defaultPreset?: string
  /** Upstream model id -> public model name. */
  models?: Record<string, string>
  /** Time-range enablement, keyed by public model name (prototype `windows`). */
  timeWindows?: Record<string, ModelWindow>
  /** Per-model capabilities (context / max output / image / reasoning). */
  modelOptions?: Record<string, LlmModelOptionsShape>
  lastVerifiedAt?: number
  lastTestOk?: boolean
}

export type LlmStrategyType =
  | 'round_robin'
  | 'sequential'
  | 'weighted'
  | 'least_busy'
  | 'failover_only'

export interface LlmStrategyShape {
  id: string
  /** Display name; the id is a slug and reads badly for non-ASCII names. */
  name?: string
  type: LlmStrategyType
  members: Array<{
    provider: string
    /** Public model this member serves; absent = any model the provider lists. */
    model?: string
    /** Per-member upstream id, overriding the strategy alias. */
    upstreamModel?: string
    weight?: number
    enabled?: boolean
  }>
  enabled?: boolean
  stickySession?: {
    enabled?: boolean
    ttlSeconds?: number
    maxEntries?: number
    scope?: 'session' | 'session+model'
  }
  retry?: { maxAttempts?: number; backoffMs?: number }
  /** Compact the session after the gateway switches its key/model. Default on. */
  compactAfterSwitch?: boolean
  cooldown?: {
    /** Durations live on the preset; only the queue-position flag is strategy-level. */
    returnToOriginalPosition?: boolean
  }
  /** Fallback strategy when every member is unavailable. */
  fallbackStrategyId?: string
  /** Public model name -> upstream model name. */
  modelAliases?: Record<string, string>
  /** Public model name -> provider ids allowed to serve it. Absent = any member. */
  modelProviders?: Record<string, string[]>
}

export interface LlmClientKeyShape {
  key: string
  strategies: string[]
  autoRetry?: boolean
}

export interface LlmConfigShape {
  version: number
  presets: Record<string, LlmPresetShape>
  providers: LlmProviderShape[]
  strategies: LlmStrategyShape[]
  clientKeys: LlmClientKeyShape[]
  /** Strategy group for auxiliary model calls; see the shared `LlmConfig`. */
  miniStrategy?: string
  /** Strategy group new sessions inherit when the caller names none. */
  defaultStrategy?: string
  usage?: {
    persist?: boolean
    retainDays?: number
  }
}

/** Mirrors `LlmProviderDetailPayload`. */
export interface ProviderDetailShape {
  provider: string
  requests: number
  success: number
  retried: number
  failed: number
  successRate: number | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  hourly: Array<{ hour: number; success: number; failed: number }>
  keys: Array<{
    keyId: string
    requests: number
    success: number
    failed: number
    successRate: number | null
    promptTokens: number
    completionTokens: number
    totalTokens: number
    avgFirstByteMs: number | null
    hourly: Array<{ hour: number; success: number; failed: number }>
  }>
  daily: Array<{
    day: string
    success: number
    retried: number
    failed: number
    promptTokens: number
    completionTokens: number
    /** Cache-read prompt tokens that day; absent on payloads from older builds. */
    cachedTokens?: number
  }>
  recent: Array<{
    ts: number
    /** When the request was sent; the log shows this instead of `ts`. */
    startedAt?: number
    model: string
    keyId: string
    /** Group that actually routed the request; '' for a connection probe. */
    strategy?: string
    /** Request kind (`connection_test`, `chat`, …). */
    kind?: string
    /** Owning chat session (absent for memory extraction / system calls). */
    sessionId?: string
    status: 'success' | 'error'
    statusCode: number
    attempts: number
    retried: boolean
    promptTokens: number
    completionTokens: number
    totalTokens: number
    firstByteMs?: number
    totalMs?: number
    error?: string
    stages: Array<{ stage: string; atMs: number | null }>
  }>
}

/** Health tone for a provider card: derived, never stored. */
export type ProviderTone = 'ok' | 'cool' | 'down' | 'disabled'
