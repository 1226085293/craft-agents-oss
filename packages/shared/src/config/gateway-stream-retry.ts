import { createHash } from 'node:crypto'

export const GATEWAY_STREAM_TRUNCATION_RETRY_MARKER = 'CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY'
export const GATEWAY_STREAM_TRUNCATION_EXHAUSTED_MARKER = 'CRAFT_GATEWAY_STREAM_TRUNCATION_EXHAUSTED'

export interface GatewayStreamRetryState {
  /** Number of stream attempts already made for each `unitId::keyId` route. */
  attemptsByRoute: Map<string, number>
  /** Total upstream attempts across route/key changes for this logical request. */
  totalAttempts: number
  lastUsedAt: number
}

export interface GatewayStreamRetryStateStoreOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
}

function stableJson(value: unknown, omitSessionKey = false): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const entries = Object.keys(object)
      .filter((key) => !omitSessionKey || key !== 'sessionKey')
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Stable, non-reversible identity for a request body, excluding session routing metadata. */
export function gatewayRequestFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload, true)).digest('hex')
}

/**
 * Short-lived state bridging the client's same-turn continuation requests.
 * Keys are isolated by session, request body and strategy, and the map is
 * bounded so abandoned streams cannot accumulate indefinitely.
 */
export class GatewayStreamRetryStateStore {
  private readonly entries = new Map<string, GatewayStreamRetryState>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(options: GatewayStreamRetryStateStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000
    this.maxEntries = options.maxEntries ?? 256
  }

  getOrCreate(sessionId: string, fingerprint: string, strategyId: string): GatewayStreamRetryState {
    const now = this.now()
    this.prune(now)
    const key = JSON.stringify([sessionId, fingerprint, strategyId])
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsedAt = now
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing
    }

    const state: GatewayStreamRetryState = {
      attemptsByRoute: new Map(),
      totalAttempts: 0,
      lastUsedAt: now,
    }
    this.entries.set(key, state)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return state
  }

  delete(sessionId: string, fingerprint: string, strategyId: string): void {
    this.entries.delete(JSON.stringify([sessionId, fingerprint, strategyId]))
  }

  private prune(now: number): void {
    for (const [key, state] of this.entries) {
      if (now - state.lastUsedAt > this.ttlMs) this.entries.delete(key)
    }
  }
}
