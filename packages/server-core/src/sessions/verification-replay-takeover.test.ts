import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

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
})
