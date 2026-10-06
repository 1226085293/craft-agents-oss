import { describe, expect, it } from 'bun:test'
import { nextRetryRowPayload, settleRetryRowAsFailed, findActiveRetryRowIndex } from '../retry-row'
import type { RetryLadderRow } from '@craft-agent/core'

const NOW = 1_000_000

describe('nextRetryRowPayload (shared retry-row state machine)', () => {
  it('creates a retrying row on the first backoff with countdown and ladder-start anchor', () => {
    const payload = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 5000 }, undefined, NOW)
    expect(payload).toEqual({
      status: 'retrying',
      attempt: 1,
      nextRetryAt: NOW + 5000,
      startedAt: NOW,
    })
  })

  it('keeps the original startedAt across later backoffs (total-duration anchor)', () => {
    const first = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 1000 }, undefined, NOW)
    const second = nextRetryRowPayload({ phase: 'backoff', attempt: 2, nextRetryInMs: 4000 }, first, NOW + 3000)
    expect(second).toEqual({
      status: 'retrying',
      attempt: 2,
      nextRetryAt: NOW + 3000 + 4000,
      startedAt: NOW,
    })
  })

  it('drops the countdown target once the retry is in flight and anchors the active-at timer', () => {
    const first = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 2000 }, undefined, NOW)
    const active = nextRetryRowPayload({ phase: 'active' }, first, NOW + 2000)
    expect(active).toEqual({
      status: 'retrying',
      attempt: 1,
      startedAt: NOW,
      activeAt: NOW + 2000,
    })
    // The next backoff clears activeAt (waiting phase again).
    const nextBackoff = nextRetryRowPayload({ phase: 'backoff', attempt: 2, nextRetryInMs: 4000 }, active, NOW + 8000)
    expect(nextBackoff).toEqual({
      status: 'retrying',
      attempt: 2,
      nextRetryAt: NOW + 8000 + 4000,
      startedAt: NOW,
    })
    expect(nextBackoff.activeAt).toBeUndefined()
  })

  it('settles to recovered with total elapsed on a successful end', () => {
    const first = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 1000 }, undefined, NOW)
    const active = nextRetryRowPayload({ phase: 'active' }, first, NOW + 1000)
    const end = nextRetryRowPayload({ phase: 'end', recovered: true, attempt: 2 }, active, NOW + 60_000)
    expect(end).toEqual({
      status: 'recovered',
      attempt: 2,
      startedAt: NOW,
      elapsedMs: 60_000,
    })
    // activeAt is a transient in-flight marker — never in a settled payload.
    expect(end.activeAt).toBeUndefined()
  })

  it('settles to failed when the ladder exhausts', () => {
    const first = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 1000 }, undefined, NOW)
    const end = nextRetryRowPayload({ phase: 'end', recovered: false, attempt: 3 }, first, NOW + 90_000)
    expect(end.status).toBe('failed')
    expect(end.attempt).toBe(3)
    expect(end.elapsedMs).toBe(90_000)
  })

  it('reuses prev attempt/startedAt when the event omits them', () => {
    const first = nextRetryRowPayload({ phase: 'backoff', attempt: 1, nextRetryInMs: 1000 }, undefined, NOW)
    const end = nextRetryRowPayload({ phase: 'end', recovered: true }, first, NOW + 10_000)
    expect(end).toEqual({
      status: 'recovered',
      attempt: 1,
      startedAt: NOW,
      elapsedMs: 10_000,
    })
  })

  it('prefers the event-carried authoritative timeline when the row was lost (reload/restart)', () => {
    // No prev row (lost on restart), but the event knows the real ladder start:
    // the terminal line must NOT show a fake 00:00.
    const lost = nextRetryRowPayload(
      {
        phase: 'end',
        recovered: false,
        attempt: 1,
        startedAt: NOW - 328_000,
        elapsedMs: 328_000,
      },
      undefined,
      NOW,
    )
    expect(lost).toEqual({
      status: 'failed',
      attempt: 1,
      startedAt: NOW - 328_000,
      elapsedMs: 328_000,
    })
    // Event elapsed wins even when a (stale/different) row exists.
    const withRow = nextRetryRowPayload(
      { phase: 'end', recovered: true, attempt: 2, startedAt: NOW - 60_000, elapsedMs: 60_000 },
      { status: 'retrying', attempt: 1, startedAt: NOW - 999, nextRetryAt: NOW + 5000 },
      NOW,
    )
    expect(withRow.elapsedMs).toBe(60_000)
    expect(withRow.startedAt).toBe(NOW - 60_000)
  })
})

describe('settleRetryRowAsFailed (fail-safe)', () => {
  it('settles a stuck retrying row to failed with elapsed', () => {
    const prev: RetryLadderRow = { status: 'retrying', attempt: 2, nextRetryAt: NOW + 5000, startedAt: NOW - 8000 }
    expect(settleRetryRowAsFailed(prev, NOW)).toEqual({
      status: 'failed',
      attempt: 2,
      startedAt: NOW - 8000,
      elapsedMs: 8000,
    })
  })

  it('creates a failed row from nothing (defensive)', () => {
    const settled = settleRetryRowAsFailed(undefined, NOW)
    expect(settled).toEqual({ status: 'failed', attempt: 1, startedAt: NOW, elapsedMs: 0 })
  })
})

describe('findActiveRetryRowIndex (cross-turn protection)', () => {
  const retryRow = { role: 'status' as const, statusType: 'retrying' as const }

  it('returns the current-turn row when no later user message exists', () => {
    expect(findActiveRetryRowIndex([retryRow])).toBe(0)
    expect(findActiveRetryRowIndex([{ role: 'user' }, retryRow])).toBe(1)
  })

  it('returns -1 once a later (regular) user message starts a new turn — the old row must not be recycled', () => {
    expect(findActiveRetryRowIndex([retryRow, { role: 'user' }])).toBe(-1)
    expect(findActiveRetryRowIndex([retryRow, { role: 'user' }, retryRow])).toBe(2)
  })

  it('does not treat mid-turn guidance/steer messages as a turn boundary', () => {
    expect(findActiveRetryRowIndex([retryRow, { role: 'user', isGuidance: true }])).toBe(0)
  })

  it('returns -1 for no row at all', () => {
    expect(findActiveRetryRowIndex([{ role: 'user' }, { role: 'tool' }])).toBe(-1)
  })
})