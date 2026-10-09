import { describe, expect, it } from 'bun:test'
import { nextRetryRowPayload, settleRetryRowAsFailed, findActiveRetryRowIndex, findLastRetryRowIndex, findLastRetryRowByStartedAt, findRetryRowForLadder } from '../retry-row'
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
  // 2026-10-10: the lookup now requires the NESTED state to still be 'retrying'
  // (settled rows keep their outer statusType), so fixtures carry the payload.
  const retryRow = { role: 'status' as const, statusType: 'retrying' as const, retry: { status: 'retrying', attempt: 1, startedAt: 1 } }

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
describe('findLastRetryRowIndex (2026-10-09, cross-turn settlement)', () => {
  const row = { role: 'status', statusType: 'retrying' }
  it('finds a retrying row across a turn boundary', () => {
    const messages = [
      { role: 'user' },
      { id: 'tool-1', role: 'tool', toolName: 'Read', toolUseId: 't1', toolStatus: 'completed', toolResult: 'ok', timestamp: 10 },
      { ...row, retry: { status: 'retrying', attempt: 1, startedAt: 20, activeAt: 21 } },
      { role: 'info', content: 'Response interrupted', type: 'info' },
      { role: 'user' }, // new user message — turn boundary
      { id: 'tool-2', role: 'tool', toolName: 'Bash', toolUseId: 't2', toolStatus: 'completed', toolResult: 'ok', timestamp: 30 },
    ]
    expect(findActiveRetryRowIndex(messages as never)).toBe(-1) // turn-scoped stops at the boundary
    expect(findLastRetryRowIndex(messages as never)).toBe(2) // unbound scan still finds the dangling row
  })

  it('returns -1 when only settled rows exist', () => {
    const messages = [
      { role: 'user' },
      { role: 'status', statusType: 'retrying', retry: { status: 'failed', attempt: 1, startedAt: 20, elapsedMs: 5000 } },
      { role: 'assistant', content: 'ok' },
    ]
    expect(findLastRetryRowIndex(messages as never)).toBe(-1)
  })

  it('returns -1 when no retry rows exist', () => {
    expect(findLastRetryRowIndex([{ role: 'user' }, { role: 'assistant' }] as never)).toBe(-1)
  })
})

describe('row reuse rules (2026-10-10)', () => {
  it('findActiveRetryRowIndex never returns a settled row, even in the same turn', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'status', statusType: 'retrying', retry: { status: 'recovered', attempt: 2, startedAt: 100, elapsedMs: 5000 } },
      { id: 'tool-1', role: 'tool', toolName: 'Bash', toolUseId: 't1', toolStatus: 'completed', toolResult: 'ok', timestamp: 20 },
    ]
    // The new ladder (same turn, later failure) must NOT rewrite this row.
    expect(findActiveRetryRowIndex(messages as never)).toBe(-1)
  })

  it('findActiveRetryRowIndex still finds an unsettled current-turn row', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'status', statusType: 'retrying', retry: { status: 'retrying', attempt: 1, startedAt: 100, activeAt: 101 } },
    ]
    expect(findActiveRetryRowIndex(messages as never)).toBe(1)
  })

  it('findLastRetryRowByStartedAt matches the row of the SAME ladder across turn boundaries', () => {
    const LADDER_START = 100
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'status', statusType: 'retrying', retry: { status: 'recovered', attempt: 1, startedAt: LADDER_START, elapsedMs: 4000 } },
      { role: 'user', content: 'next' },
      { role: 'status', statusType: 'retrying', retry: { status: 'failed', attempt: 3, startedAt: 999, elapsedMs: 60000 } },
    ]
    expect(findLastRetryRowByStartedAt(messages as never, LADDER_START)).toBe(1)
    expect(findLastRetryRowByStartedAt(messages as never, 4242)).toBe(-1)
    expect(findLastRetryRowByStartedAt(messages as never, undefined)).toBe(-1)
  })

  it('nextRetryRowPayload anchors backoff/active rows on the event-startedAt when present', () => {
    const payload = nextRetryRowPayload(
      { phase: 'backoff', attempt: 1, nextRetryInMs: 1000, startedAt: 100 },
      undefined,
      5000,
    )
    expect(payload.startedAt).toBe(100) // ladder start, not the processing time
    const active = nextRetryRowPayload({ phase: 'active', attempt: 1, startedAt: 100 }, payload, 6000)
    expect(active.startedAt).toBe(100)
    expect(active.activeAt).toBe(6000)
  })
})


describe('findRetryRowForLadder — same-ladder row revival (2026-10-10 apt-lion)', () => {
  const T0 = 100
  it('revives a soft-settled recovered row of the SAME ladder for a follow-up backoff', () => {
    const messages = [
      { role: 'user' },
      { role: 'status', statusType: 'retrying', retry: { status: 'recovered', attempt: 1, startedAt: T0, elapsedMs: 2000 } },
      { id: 'tool-1', role: 'tool', toolName: 'Bash', toolUseId: 't1', toolStatus: 'completed', toolResult: 'ok', timestamp: 50 },
    ]
    expect(findActiveRetryRowIndex(messages as never)).toBe(-1) // settled row, turn-scoped
    expect(findRetryRowForLadder(messages as never, T0)).toBe(1) // same ladder → revive
  })

  it('never revives a terminal failed row', () => {
    const messages = [
      { role: 'user' },
      { role: 'status', statusType: 'retrying', retry: { status: 'failed', attempt: 3, startedAt: T0, elapsedMs: 31000 } },
    ]
    expect(findRetryRowForLadder(messages as never, T0)).toBe(-1)
  })

  it('respects the user-message turn boundary (previous turn rows are untouched)', () => {
    const messages = [
      { role: 'user' },
      { role: 'status', statusType: 'retrying', retry: { status: 'recovered', attempt: 1, startedAt: T0, elapsedMs: 2000 } },
      { role: 'user', content: 'new turn' },
    ]
    expect(findRetryRowForLadder(messages as never, T0)).toBe(-1)
  })

  it('returns -1 when no row matches the ladder start', () => {
    const messages = [
      { role: 'user' },
      { role: 'status', statusType: 'retrying', retry: { status: 'recovered', attempt: 1, startedAt: 999, elapsedMs: 2000 } },
    ]
    expect(findRetryRowForLadder(messages as never, T0)).toBe(-1)
    expect(findRetryRowForLadder(messages as never, undefined)).toBe(-1)
  })
})
