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
): RetryLadderRow | null {
  if (event.phase === 'end') {
    // 2026-10-10 (261010-warm-carbon): a VERDICTLESS end — no recovered flag,
    // no attempt, no startedAt — is the Pi adapter's channel-closing signal
    // (releaseHeldRetryError / auto_retry_end cancellation / fallback timer),
    // NOT a ladder verdict. With no row to settle it would APPEND a phantom
    // "重试 1 次后失败 · 耗时 00:00" line (attempt 1, startedAt=now, elapsed 0)
    // beside the ladder's real rows. A verdictless end settles only a row it
    // actually found; it never creates one out of thin air.
    if (
      event.recovered === undefined &&
      event.attempt === undefined &&
      event.startedAt === undefined &&
      !prev
    ) {
      return null
    }
    // startedAt is the LADDER start — a matching key for the terminal `end`
    // (findLastRetryRowByStartedAt). It must stay constant across all cycles
    // of the same ladder, so a settled row of any cycle can be re-found.
    const startedAt = prev?.startedAt ?? (typeof event.startedAt === 'number' ? event.startedAt : now)
    // 2026-10-11 (swift-slate): the row's DISPLAY anchor and elapsed base is
    // its own cycle start (backoffAt) — set once on the cycle's first backoff,
    // kept by every later backoff/active/settling event of that row. The
    // process block sorts rows by the message timestamp (= backoffAt when the
    // row is created), and "耗时 mm:ss" counts from here, so each cycle's line
    // reads its OWN duration, never a ladder-wide accumulation.
    const backoffAt = prev?.backoffAt ?? now
    // Rows written before backoffAt existed (or tests) fall back to their
    // startedAt as the elapsed base.
    const elapsedMs = prev
      ? Math.max(0, now - (prev.backoffAt ?? prev.startedAt))
      : typeof event.elapsedMs === 'number'
        ? Math.max(0, event.elapsedMs)
        : Math.max(0, now - backoffAt)
    return {
      status: event.recovered ? 'recovered' : 'failed',
      attempt: typeof event.attempt === 'number' ? event.attempt : prev?.attempt ?? 1,
      startedAt,
      backoffAt,
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
  // 2026-10-10: `startedAt` stays the ladder's authoritative start (carried
  // by backoff/active events) so a later `end` (same ladder start) re-finds
  // this row by startedAt. `backoffAt` is the row's OWN cycle start — fixed
  // on the first backoff of the cycle, never overwritten by later events.
  const startedAt = prev?.startedAt ?? (typeof event.startedAt === 'number' ? event.startedAt : now)
  const backoffAt = prev?.backoffAt ?? now
  if (event.phase === 'active') {
    return {
      status: 'retrying',
      attempt,
      startedAt,
      backoffAt,
      activeAt: now,
    }
  }
  return {
    status: 'retrying',
    attempt,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    startedAt,
    backoffAt,
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

/**
 * 2026-10-12 (user spec "one entry per ladder"): find the row of the CURRENT
 * turn's ladder that a backoff/active event may REVIVE.
 *
 * Within ONE ladder, repeated failures must stay on ONE row: an intermediate
 * terminal verdict (`end failed` from the SDK/auto-retry channel) settles the
 * row to 'failed', but the unified ladder keeps going — the next backoff must
 * revive THAT row in place (attempt advances 1→2→3) instead of appending a
 * fresh line per failure.
 *
 * A 'recovered' row is deliberately NOT matched: recovery closes the visible
 * cycle — a later failure starts a NEW ladder/row whose attempt count begins
 * at 1 (fine-cloud spec, 2026-10-11). Bounded by the first regular user
 * message (the ladder is per-turn).
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
      (nested === 'retrying' || nested === 'failed')
    ) {
      return i
    }
  }
  return -1
}
