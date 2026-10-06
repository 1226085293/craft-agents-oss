/**
 * retry-row.ts
 *
 * Shared state machine for the PERSISTED retry-ladder process-block row
 * (2026-10-08). Both the session manager (server, owns persistence) and the
 * renderer's event processor (display) apply the SAME transitions from the
 * SAME `retry` ladder events, so the two copies can never drift apart:
 *
 *   backoff  → { status: 'retrying', attempt, nextRetryAt, startedAt }
 *   active   → { status: 'retrying', attempt, startedAt }        (countdown over)
 *   end      → { status: 'recovered' | 'failed', attempt, startedAt, elapsedMs }
 *
 * The row lives on a `status` message (statusType 'retrying') carrying a
 * `retry` payload of this shape; see @craft-agent/core RetryLadderRow.
 */

import type { RetryLadderRow } from '@craft-agent/core'

/**
 * Minimal structural subset of the `retry` ladder event. Both the server
 * (AgentEvent from the pi subprocess) and the renderer (AgentEvent union in
 * the event processor) satisfy this shape.
 */
export interface RetryLadderEventLike {
  phase: 'backoff' | 'active' | 'end'
  /** Retry ordinal (1-based) surfaced to the user. */
  attempt?: number
  /** Backoff delay before the next retry (only on phase 'backoff'). */
  nextRetryInMs?: number
  /** True when the retried run recovered (only on phase 'end'). */
  recovered?: boolean
  /** Authoritative ladder-start epoch ms (end only) — the ladder's real
   *  start, even when the row was lost (reload/restart). */
  startedAt?: number
  /** Frozen total retry duration (end only) — avoids a 00:00 terminal line
   *  when the row could not be found (reload/restart). */
  elapsedMs?: number
}

/**
 * Compute the next row payload from a ladder event + the previous row (if
 * any). Pure — both callers pass their own `now` so the anchor stays local.
 */
export function nextRetryRowPayload(
  event: RetryLadderEventLike,
  prev: RetryLadderRow | null | undefined,
  now: number = Date.now(),
): RetryLadderRow {
  if (event.phase === 'end') {
    // Prefer the ladder's authoritative start/elapsed (carried by the event)
    // so a reload/restart that lost the row still shows the true duration —
    // never a misleading 00:00.
    const startedAt =
      typeof event.startedAt === 'number'
        ? event.startedAt
        : prev?.startedAt ?? now
    const elapsedMs =
      typeof event.elapsedMs === 'number'
        ? Math.max(0, event.elapsedMs)
        : Math.max(0, now - startedAt)
    return {
      status: event.recovered ? 'recovered' : 'failed',
      attempt: typeof event.attempt === 'number' ? event.attempt : prev?.attempt ?? 1,
      startedAt,
      elapsedMs,
    }
  }

  // backoff / active — still retrying. The countdown target exists only
  // during the backoff window; once the retry is in flight ('active') the
  // (now elapsed) target is dropped and `activeAt` anchors the live
  // "retrying for mm:ss" timer. The next backoff clears it again.
  const attempt = typeof event.attempt === 'number' ? event.attempt : prev?.attempt ?? 1
  const nextRetryAt =
    event.phase === 'backoff' && typeof event.nextRetryInMs === 'number'
      ? now + event.nextRetryInMs
      : undefined
  if (event.phase === 'active') {
    return {
      status: 'retrying',
      attempt,
      startedAt: prev?.startedAt ?? now,
      activeAt: now,
    }
  }
  return {
    status: 'retrying',
    attempt,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    startedAt: prev?.startedAt ?? now,
  }
}

/**
 * Find the index of the retry row that belongs to the CURRENT turn.
 *
 * Scans backwards: the first retry row found before any regular user message
 * is the active one — a later regular user message starts a NEW turn, so any
 * older row belongs to a previous (settled) turn and must never be recycled
 * or re-settled. Guidance/steer messages (role 'user', isGuidance) are
 * injected MID-turn and do not start a new turn.
 *
 * Returns -1 when no current-turn row exists (cross-turn reuse prevented).
 */
export function findActiveRetryRowIndex(
  messages: Array<{ role?: string; statusType?: string; isGuidance?: boolean }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && !m.isGuidance) return -1
    if (m.role === 'status' && m.statusType === 'retrying') return i
  }
  return -1
}

/**
 * Terminal-state builder used by fail-safes: a ladder that ended WITHOUT a
 * `retry end` event (subprocess exit, guardrail stop, stale restored rung)
 * settles the row to `failed` — the retries did not recover — so a stale
 * "重试中" spinner can never persist in the transcript.
 */
export function settleRetryRowAsFailed(
  prev: RetryLadderRow | null | undefined,
  now: number = Date.now(),
): RetryLadderRow {
  const startedAt = prev?.startedAt ?? now
  return {
    status: 'failed',
    attempt: prev?.attempt ?? 1,
    startedAt,
    elapsedMs: Math.max(0, now - startedAt),
  }
}
