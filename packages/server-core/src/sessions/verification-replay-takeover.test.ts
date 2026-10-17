import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession, hasVerificationReplayPending, readInheritedContextTokens, shouldSuppressGhostErrorCard } from './SessionManager.ts'

/**
 * Verification replay take-over (2026-10-13 261013-mild-stream incident).
 *
 * A verification-class turn captures the final reply as a CANDIDATE: the
 * adapter demotes the draft (`text_demote` → isIntermediate=true) and holds
 * the event queue until the judge reports back. On PASS the captured text is
 * REPLAYED carrying the SAME turnId as the demoted draft.
 *
 * The transcript must end with ONE row for that sub-turn. Historically the
 * replay was appended unconditionally (`messages.push`), so session.jsonl
 * held two byte-identical rows — a demoted draft (process card) and the
 * replay (final bubble). The live view hid it (the renderer overwrites by
 * turnId), but a reload/session-switch hydrated BOTH rows and the same text
 * showed up twice in the transcript.
 *
 * These tests pin the take-over contract: a replay for a demoted draft
 * reuses that draft's slot; unrelated appends are unaffected.
 */

function buildSessionManager(sessionId = 'verify-replay') {
  const sm = new SessionManager()
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/craft-agent-test',
    createdAt: Date.now(),
  } as unknown as { id: string } & import('./SessionManager.ts').ManagedSession
  const managed = createManagedSession(
    { id: sessionId, name: 'verification replay test' } as unknown as { id: string } & Partial<import('./SessionManager.ts').ManagedSession>,
    workspace as never,
    { messagesLoaded: true },
  )
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  return { sm, managed }
}

function captureEvents(sm: SessionManager) {
  const events: Array<Record<string, unknown>> = []
  ;(sm as unknown as { sendEvent: (e: unknown, _workspaceId?: string) => void }).sendEvent = (e: unknown) => {
    events.push(e as Record<string, unknown>)
  }
  return events
}

async function fire(sm: SessionManager, managed: import('./SessionManager.ts').ManagedSession, event: unknown) {
  await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
}

type Row = { role: string; content: string; isIntermediate?: boolean; turnId?: string; id: string }

const rowsOf = (managed: import('./SessionManager.ts').ManagedSession): Row[] =>
  (managed.messages as unknown as Row[]).map(m => ({
    role: m.role,
    content: m.content,
    isIntermediate: m.isIntermediate,
    turnId: m.turnId,
    id: m.id,
  }))

describe('SessionManager — verification replay take-over', () => {
  it('replays the verified text into the demoted draft slot instead of appending', async () => {
    const { sm, managed } = buildSessionManager()
    captureEvents(sm)

    // The turn's draft reply is captured for verification and demoted.
    await fire(sm, managed, {
      type: 'text_complete',
      text: '草稿：我上一轮的最终回复已经完整交付了原请求……',
      isIntermediate: true,
      turnId: 'pi-turn-1__m16',
    } as never)
    await fire(sm, managed, {
      type: 'text_demote',
      turnId: 'pi-turn-1__m16',
    } as never)

    // The judge passes → the adapter replays the verified text with the
    // SAME turnId as the demoted draft.
    await fire(sm, managed, {
      type: 'text_complete',
      text: '草稿：我上一轮的最终回复已经完整交付了原请求……',
      isIntermediate: false,
      turnId: 'pi-turn-1__m16',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.isIntermediate).toBe(false)
    expect(rows[0]!.turnId).toBe('pi-turn-1__m16')
    // The replay must be registered as the turn's final reply.
    expect(managed.lastFinalMessageId).toBe(rows[0]!.id)
  })

  it('keeps the demoted draft message id across the take-over', async () => {
    const { sm, managed } = buildSessionManager('verify-replay-id')
    captureEvents(sm)

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'draft',
      isIntermediate: true,
      turnId: 'pi-turn-1__m16',
    } as never)
    await fire(sm, managed, { type: 'text_demote', turnId: 'pi-turn-1__m16' } as never)
    const draftId = (managed.messages as unknown as Row[])[0]!.id

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'verified final reply',
      isIntermediate: false,
      turnId: 'pi-turn-1__m16',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows).toHaveLength(1)
    // Clients key off the id the draft already published (renderer atom,
    // branch anchors) — a take-over that rotated the id would orphan them.
    expect(rows[0]!.id).toBe(draftId)
    expect(rows[0]!.content).toBe('verified final reply')
  })

  it('does not disturb unrelated appends with distinct turnIds', async () => {
    const { sm, managed } = buildSessionManager('verify-replay-distinct')
    captureEvents(sm)

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'process step A',
      isIntermediate: true,
      turnId: 'pi-turn-1__m12',
    } as never)
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'process step B',
      isIntermediate: true,
      turnId: 'pi-turn-1__m13',
    } as never)
    // A demoted draft…
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'draft',
      isIntermediate: true,
      turnId: 'pi-turn-1__m16',
    } as never)
    await fire(sm, managed, { type: 'text_demote', turnId: 'pi-turn-1__m16' } as never)
    // …taken over by the replay — the earlier process steps stay put.
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'verified',
      isIntermediate: false,
      turnId: 'pi-turn-1__m16',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows.map(r => r.turnId)).toEqual([
      'pi-turn-1__m12',
      'pi-turn-1__m13',
      'pi-turn-1__m16',
    ])
    expect(rows[0]!.content).toBe('process step A')
    expect(rows[1]!.content).toBe('process step B')
    expect(rows[2]!.content).toBe('verified')
    expect(rows[2]!.isIntermediate).toBe(false)
  })

  it('an intermediate replay never promotes a draft that was never demoted', async () => {
    const { sm, managed } = buildSessionManager('verify-replay-intermediate')
    captureEvents(sm)

    // Genuine process-card commentary (not a verification draft) arriving
    // twice with the same turnId must stay two rows: the renderer's
    // handleTextComplete treats each intermediate as a distinct rendering
    // unit ("each thinking block should be distinct"), so collapsing them
    // would drop content the user is meant to read.
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'first commentary',
      isIntermediate: true,
      turnId: 'pi-turn-1__m7',
    } as never)
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'second commentary',
      isIntermediate: true,
      turnId: 'pi-turn-1__m7',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.content)).toEqual(['first commentary', 'second commentary'])
  })

  it('a final reply takes over the demoted draft but not live commentary', async () => {
    const { sm, managed } = buildSessionManager('verify-replay-mixed')
    captureEvents(sm)

    // Two commentary rows under the same turnId (distinct rendering units)…
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'first commentary',
      isIntermediate: true,
      turnId: 'pi-turn-1__m7',
    } as never)
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'second commentary',
      isIntermediate: true,
      turnId: 'pi-turn-1__m7',
    } as never)

    // …plus a demoted draft under a DIFFERENT turnId. The replay targets the
    // draft's turnId only — commentary rows are never the takeover target.
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'draft',
      isIntermediate: true,
      turnId: 'pi-turn-1__m16',
    } as never)
    await fire(sm, managed, { type: 'text_demote', turnId: 'pi-turn-1__m16' } as never)
    await fire(sm, managed, {
      type: 'text_complete',
      text: 'verified',
      isIntermediate: false,
      turnId: 'pi-turn-1__m16',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows.map(r => r.content)).toEqual([
      'first commentary',
      'second commentary',
      'verified',
    ])
    expect(rows[2]!.isIntermediate).toBe(false)
  })

  it('a normal final reply still appends (no draft with that turnId)', async () => {
    const { sm, managed } = buildSessionManager('verify-replay-normal')
    captureEvents(sm)

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'plain final reply, no verification involved',
      isIntermediate: false,
      turnId: 'pi-turn-2__m1',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.isIntermediate).toBe(false)
    expect(managed.lastFinalMessageId).toBe(rows[0]!.id)
  })

  it('a cross-turn replay does NOT take over a stale draft from an earlier turn (261014-prime-moor)', async () => {
    // Prime-moor shape: the earlier turn left a demoted draft row (same
    // turnId survives via pi session continuity). A restart-recovery turn
    // ran, and its final report replays that draft's turnId. Taking over
    // the stale slot splices the new final into the MIDDLE of the array,
    // leaving the recovery turn's intermediate rows trailing it — so the
    // NEXT restart's recoverPendingUserTurns sees a dangling tail and every
    // restart emitted a duplicate result bubble.
    const { sm, managed } = buildSessionManager('verify-replay-cross-turn')
    captureEvents(sm)

    const msgs = managed.messages as unknown as Array<Record<string, unknown>>
    msgs.push({ id: 'orig-user', role: 'user', content: 'original task', timestamp: 1 })
    msgs.push({
      id: 'stale-draft',
      role: 'assistant',
      content: 'old demoted draft',
      timestamp: 2,
      isIntermediate: true,
      turnId: 'pi-turn-1__m3',
    })
    // The recovery prompt (appended by recoverPendingUserTurns on restart)
    // stamps AFTER the stale draft → the draft belongs to an older turn.
    msgs.push({
      id: 'recovery-user',
      role: 'user',
      content: 'Continue the previous user request…',
      timestamp: 10,
    })
    msgs.push({
      id: 'recheck-int',
      role: 'assistant',
      content: 're-reading state',
      timestamp: 11,
      isIntermediate: true,
      turnId: 'pi-turn-1__m1',
    })

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'new final report',
      isIntermediate: false,
      turnId: 'pi-turn-1__m3', // same turnId as the stale draft (pi session continuity)
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    // The final APPENDS a new row at the array tail instead of rewriting
    // the stale slot in place.
    expect(rows).toHaveLength(3)
    expect(rows[0]!.content).toBe('old demoted draft') // untouched
    expect(rows[2]!.content).toBe('new final report')
    expect(rows[2]!.isIntermediate).toBe(false)
    expect(managed.messages[managed.messages.length - 1]!.content).toBe('new final report')
    expect(managed.lastFinalMessageId).toBe(rows[2]!.id)
    expect(rows[2]!.id).not.toBe('stale-draft')
  })

  it('a same-turn demoted draft is still taken over by its replay', async () => {
    // The guard must not disable the mild-stream fix: a draft stamped at or
    // after the current turn's user row stays eligible for takeover.
    const { sm, managed } = buildSessionManager('verify-replay-same-turn')
    captureEvents(sm)

    const msgs = managed.messages as unknown as Array<Record<string, unknown>>
    msgs.push({ id: 'u1', role: 'user', content: 'task', timestamp: 5 })
    const draftId = 'same-turn-draft'
    msgs.push({
      id: draftId,
      role: 'assistant',
      content: 'draft',
      timestamp: 6, // stamped AFTER the user row → same turn
      isIntermediate: true,
      turnId: 'pi-turn-1__m3',
    })

    await fire(sm, managed, {
      type: 'text_complete',
      text: 'verified final',
      isIntermediate: false,
      turnId: 'pi-turn-1__m3',
    } as never)

    const rows = rowsOf(managed).filter(r => r.role === 'assistant')
    expect(rows).toHaveLength(1) // slot replaced, not appended
    expect(rows[0]!.id).toBe(draftId)
    expect(rows[0]!.content).toBe('verified final')
    expect(rows[0]!.isIntermediate).toBe(false)
  })
})

describe('SessionManager — ghost-card guard (hasVerificationReplayPending)', () => {
  it('returns true when a verification_passed info row is newer than the last user message', () => {
    expect(hasVerificationReplayPending([
      { role: 'user', timestamp: 100 },
      { role: 'info', statusType: 'verification_passed', timestamp: 200 },
    ], 100)).toBe(true)
  })

  it('returns false when the verification_passed info is OLDER than the last user message (stale turn)', () => {
    // A verification_passed from an earlier turn must NOT suppress the
    // ghost-card path for the current turn's genuine no-reply situation.
    expect(hasVerificationReplayPending([
      { role: 'info', statusType: 'verification_passed', timestamp: 90 },
      { role: 'user', timestamp: 100 },
    ], 100)).toBe(false)
  })

  it('returns false when there is no verification_passed info (genuine no-reply)', () => {
    expect(hasVerificationReplayPending([
      { role: 'user', timestamp: 100 },
      { role: 'tool', timestamp: 110 },
    ], 100)).toBe(false)
  })

  it('returns false when verification FAILED (no replay in flight)', () => {
    expect(hasVerificationReplayPending([
      { role: 'user', timestamp: 100 },
      { role: 'info', statusType: 'verification_failed', timestamp: 200 },
    ], 100)).toBe(false)
  })

  it('returns false when lastUserTimestamp is undefined', () => {
    expect(hasVerificationReplayPending([
      { role: 'info', statusType: 'verification_passed', timestamp: 200 },
    ], undefined)).toBe(false)
  })
})

describe('SessionManager — ghost-card suppression (shouldSuppressGhostErrorCard, 2026-10-16)', () => {
  const NOW = 1_000_000
  const MAX_AGE = 5 * 60 * 1000

  it('suppresses when the captured error PREDATES this turn\'s user message (the soft-channel ghost)', () => {
    // Real incident shape: the 503 was written 62 minutes before the turn
    // that produced no reply, then surfaced as a fresh "Service Error" card.
    expect(shouldSuppressGhostErrorCard(
      [{ role: 'user', timestamp: 500_000 }],
      500_000,
      90_000, // error written long before this turn
      NOW,
      MAX_AGE,
    )).toBe(true)
  })

  it('suppresses when the captured error is older than maxErrorAgeMs even within the turn', () => {
    // Fresh relative to the turn's own message (10s after it) but older than
    // the caller's age ceiling — a 503 that has been sitting for 110s against
    // a 60s ceiling is not this turn's failure.
    expect(shouldSuppressGhostErrorCard(
      [{ role: 'user', timestamp: 900_000 }],
      900_000,
      890_000,
      NOW,
      60_000, // NOW-890000 = 110000 > 60000 → stale
    )).toBe(true)
  })

  it('suppresses when a verification_failed info row is in flight (defense still recovering)', () => {
    // The followUp fallback for a FAILed judge keeps the turn running; the
    // `complete` can land before that continuation's reply.
    expect(shouldSuppressGhostErrorCard(
      [
        { role: 'user', timestamp: 900_000 },
        { role: 'info', statusType: 'verification_failed', timestamp: 910_000 },
      ],
      900_000,
      950_000, // fresh error
      NOW,
      MAX_AGE,
    )).toBe(true)
  })

  it('suppresses when an unsettled retrying row is in flight (ladder still owns the turn)', () => {
    expect(shouldSuppressGhostErrorCard(
      [
        { role: 'user', timestamp: 900_000 },
        { role: 'status', statusType: 'retrying', timestamp: 910_000, retry: { status: 'retrying' } },
      ],
      900_000,
      950_000,
      NOW,
      MAX_AGE,
    )).toBe(true)
  })

  it('does NOT suppress for a stale verification_failed from an earlier turn', () => {
    expect(shouldSuppressGhostErrorCard(
      [
        { role: 'info', statusType: 'verification_failed', timestamp: 800_000 },
        { role: 'user', timestamp: 900_000 },
      ],
      900_000,
      950_000,
      NOW,
      MAX_AGE,
    )).toBe(false)
  })

  it('does NOT suppress a genuine fresh no-reply with a fresh error', () => {
    expect(shouldSuppressGhostErrorCard(
      [
        { role: 'user', timestamp: 900_000 },
        { role: 'tool', timestamp: 910_000 },
      ],
      900_000,
      990_000, // written after the user message, within the age window
      NOW,
      MAX_AGE,
    )).toBe(false)
  })

  it('treats a missing error timestamp as fresh (never hides a real error)', () => {
    expect(shouldSuppressGhostErrorCard(
      [{ role: 'user', timestamp: 900_000 }],
      900_000,
      undefined,
      NOW,
      MAX_AGE,
    )).toBe(false)
  })

  it('does NOT suppress when lastUserTimestamp is undefined (same contract as the replay guard)', () => {
    // No in-flight signal and a FRESH error (10s old): the guard declines to
    // suppress, exactly like hasVerificationReplayPending with undefined.
    expect(shouldSuppressGhostErrorCard(
      [{ role: 'info', statusType: 'verification_passed', timestamp: 200 }],
      undefined,
      NOW - 10_000,
      NOW,
      MAX_AGE,
    )).toBe(false)
  })
})

// ============================================================================
// Branch usage-ring seeding (2026-10-17 jade-stone)
// ============================================================================

describe('readInheritedContextTokens', () => {
  const FINAL = (ctx?: number) => ({ type: 'assistant', isIntermediate: false, contextTokens: ctx })
  const DRAFT = (ctx?: number) => ({ type: 'assistant', isIntermediate: true, contextTokens: ctx })

  it('reads the last FINAL assistant bubble stamp', () => {
    const msgs = [FINAL(11_970), FINAL(36_915), DRAFT(undefined), FINAL(43_500)]
    expect(readInheritedContextTokens(msgs)).toBe(43_500)
  })

  // REGRESSION (2026-10-18): the call site passes `managed.messages`, which are
  // runtime Messages — `storedToMessage()` converts `type`→`role` and DROPS
  // `type`. The original helper only matched `type`, so it returned 0 for every
  // real branch while the stored-shape cases above kept passing.
  it('reads runtime Message rows (role, no type)', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', isIntermediate: false, contextTokens: 21_000 },
      { role: 'assistant', content: 'draft', isIntermediate: true, contextTokens: 99_999 },
    ]
    expect(readInheritedContextTokens(msgs)).toBe(21_000)
  })

  it('skips intermediate drafts (they never carry a context)', () => {
    const msgs = [FINAL(11_970), DRAFT(99_999), DRAFT(undefined)]
    // The trailing drafts are skipped; the last real stamp wins.
    expect(readInheritedContextTokens(msgs)).toBe(11_970)
  })

  it('returns 0 for a parent with no stamped bubble (historical session)', () => {
    expect(readInheritedContextTokens([FINAL(undefined), DRAFT(undefined)])).toBe(0)
  })

  it('ignores non-assistant rows and non-positive stamps', () => {
    const msgs = [
      { type: 'user', contextTokens: 5_000 },
      FINAL(0),
      { type: 'tool', contextTokens: 7_000 },
      FINAL(12_345),
    ]
    expect(readInheritedContextTokens(msgs)).toBe(12_345)
  })

  it('returns 0 for an empty message list', () => {
    expect(readInheritedContextTokens([])).toBe(0)
  })

  it('returns 0 when the runtime rows carry no stamp at all', () => {
    expect(readInheritedContextTokens([
      { role: 'user' },
      { role: 'assistant', isIntermediate: false },
    ])).toBe(0)
  })
})
