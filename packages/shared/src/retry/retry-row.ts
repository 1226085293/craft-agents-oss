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
  /** Authoritative ladder-start epoch ms. `end` always carries it; since
   *  2026-10-10 `backoff`/`active` do too, so the row's startedAt equals
   *  the ladder start (not the backoff-processing time) — which makes
   *  duplicate-end re-settlement (soft + final) matchable by startedAt. */
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
  // 2026-10-10: anchor the row on the ladder's authoritative start (carried
  // by backoff/active events since this change) instead of "now", so a
  // later `end` (which carries the same ladder start) can re-find this row
  // by startedAt.
  const startedAt = prev?.startedAt ?? (typeof event.startedAt === 'number' ? event.startedAt : now)
  if (event.phase === 'active') {
    return {
      status: 'retrying',
      attempt,
      startedAt,
      activeAt: now,
    }
  }
  return {
    status: 'retrying',
    attempt,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    startedAt,
  }
}

/**
 * Find the index of the UNSETTLED retry row that belongs to the CURRENT
 * turn.
 *
 * Scans backwards: the first UNSETTLED retry row found before any regular
 * user message is the active one — a later regular user message starts a NEW
 * turn, so any older row belongs to a previous (settled) turn and must never
 * be recycled or re-settled. Guidance/steer messages (role 'user',
 * isGuidance) are injected MID-turn and do not start a new turn.
 *
 * 2026-10-10: the nested `retry.status` must still be 'retrying' — settlement
 * keeps the outer statusType, so without this check a NEW ladder inside the
 * SAME turn would rewrite the previous ladder's "recovered/failed" row in
 * place (observed: "重试 2 次后恢复" flipped back to "第 3 次重试中" when
 * a second failure armed a fresh ladder mid-turn). A new ladder now gets
 * its OWN row, appended after the intervening process rows.
 *
 * Returns -1 when no current-turn unsettled row exists.
 */
export function findActiveRetryRowIndex(
  messages: Array<{ role?: string; statusType?: string; retry?: { status?: string }; isGuidance?: boolean }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && !m.isGuidance) return -1
    if (
      m.role === 'status' &&
      m.statusType === 'retrying' &&
      m.retry?.status === 'retrying'
    ) {
      return i
    }
  }
  return -1
}

/**
 * Turn-UNBOUND scan for the last UNSETTLED retrying row (2026-10-09): an
 * `end`/fail-safe arriving AFTER a turn boundary (interrupted turn followed
 * by a new user message) cannot find its row via findActiveRetryRowIndex —
 * it stops at the new user message and returns -1, leaving the old row
 * spinning "重试中" forever. The row's outer statusType stays 'retrying' even
 * after settlement (only the nested `retry.status` flips), so this scan also
 * requires `retry.status === 'retrying'`: settled rows (recovered/failed) are
 * never returned and never re-settled. Returns -1 when no un-settled row
 * exists at all.
 */
export function findLastRetryRowIndex(
  messages: Array<{ role?: string; statusType?: string; retry?: { status?: string }; isGuidance?: boolean }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'status' && m.statusType === 'retrying' && m.retry?.status === 'retrying') return i
  }
  return -1
}

/**
 * Re-find an ALREADY-SETTLED row by its ladder start (2026-10-10, b39283b4
 * duplicate ends): a soft `end recovered` (run went live) followed by the
 * terminal `end` from agent_end both carry the ladder's authoritative
 * startedAt — but the second event finds no UNSETTLED row (the soft end
 * already flipped it to recovered/failed). Without this match it would
 * APPEND a second row, stacking two retry lines for one ladder. Scanning
 * backwards past turn boundaries (a settled row older than the newest
 * user message is exactly the normal case), the first row whose
 * `retry.startedAt` equals the event's startedAt is re-settled in place.
 * No nested-status filter: settled rows ARE the target here.
 */
export function findLastRetryRowByStartedAt(
  messages: Array<{ role?: string; statusType?: string; retry?: { status?: string; startedAt?: number } }>,
  startedAt?: number,
): number {
  if (typeof startedAt !== 'number') return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'status' && m.statusType === 'retrying' && m.retry?.startedAt === startedAt) return i
  }
  return -1
}

/**
 * 2026-10-10: same-ladder row REVIVAL for backoff/active events (apt-lion
 * incident): a retried run that proved alive once is soft-settled
 * ("重试 N 次后恢复") — but if that run then fails and the SAME ladder
 * schedules another backoff, a turn-scoped lookup finds nothing (the row's
 * nested status is no longer 'retrying') and APPENDS a fresh row, so one
 * ladder stacks 重试中→恢复→(backoff)→恢复→… lines. The ladder is single:
 * while it is live there is at most ONE un-settled row, and a row already
 * 'recovered' can only be that ladder's soft-settled row — a genuine
 * terminal 'failed' is never revived. Backwards scan bounded by the FIRST
 * REGULAR USER MESSAGE: the ladder is per-turn, and a previous turn's row
 * (any state) must never be touched by this turn's events.
 */
export function findRetryRowForLadder(
  messages: Array<{ role?: string; statusType?: string; retry?: { status?: string; startedAt?: number }; isGuidance?: boolean }>,
  startedAt?: number,
): number {
  if (typeof startedAt !== 'number') return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && !m.isGuidance) return -1
    const nested = m.retry?.status
    if (
      m.role === 'status' &&
      m.statusType === 'retrying' &&
      m.retry?.startedAt === startedAt &&
      (nested === 'retrying' || nested === 'recovered')
    ) {
      return i
    }
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
