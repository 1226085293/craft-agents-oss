import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import type { AgentEvent } from '@craft-agent/core/types'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type EventHarness = {
  processEvent(managed: ManagedSession, event: AgentEvent): Promise<void>
  pendingDeltas: Map<string, { delta: string; turnId?: string }>
  deltaFlushTimers: Map<string, ReturnType<typeof setTimeout>>
  // 2026-10-09: thinking-delta batches mirror the text batches (Object.create
  // harness skips class-field initializers, so these must be set up manually).
  pendingThinkingDeltas: Map<string, { delta: string; turnId?: string }>
  thinkingFlushTimers: Map<string, ReturnType<typeof setTimeout>>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  persistSession(managed: ManagedSession): void
  monotonic(): number
}

/** Exercise the real batching/event methods without agents, disk writes or watchers. */
function harness() {
  const manager = Object.create(SessionManager.prototype) as EventHarness
  const events: SessionEvent[] = []
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  manager.pendingThinkingDeltas = new Map()
  manager.thinkingFlushTimers = new Map()
  manager.sendEvent = event => { events.push(event) }
  manager.persistSession = () => {}
  manager.monotonic = () => Date.now()
  const managed = createManagedSession({ id: 'retry-test' }, {
    id: 'workspace', slug: 'workspace', name: 'Test', rootPath: '/unused-retry-test', createdAt: Date.now(),
  })
  return { manager, managed, events, fire: (event: AgentEvent) => manager.processEvent(managed, event) }
}

describe('Pi retry streaming boundaries', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('stamps status rows with the main-process monotonic timestamp', async () => {
    const { manager, events, fire } = harness()
    manager.monotonic = () => 1234

    await fire({ type: 'status', message: 'Verifying final reply…', statusType: 'verification' })

    expect(events).toContainEqual({
      type: 'status',
      sessionId: 'retry-test',
      message: 'Verifying final reply…',
      statusType: 'verification',
      timestamp: 1234,
    })
  })

  it('discards pending failed deltas before backoff and never sends them later', async () => {
    const { manager, managed, events, fire } = harness()
    await fire({ type: 'text_delta', text: 'Failed partial', turnId: 'attempt-0' })
    expect(events).toHaveLength(0)
    expect(managed.streamingText).toBe('Failed partial')
    await fire({ type: 'text_discard', turnId: 'attempt-0' })
    await fire({ type: 'retry', phase: 'backoff', message: 'Retrying in 2s...' })
    jest.advanceTimersByTime(100)

    expect(events).toEqual([
      { type: 'text_discard', sessionId: managed.id, turnId: 'attempt-0' },
      { type: 'retry', sessionId: managed.id, phase: 'backoff', message: 'Retrying in 2s...' },
    ])
    expect(managed.streamingText).toBe('')
    expect(managed.streamingTurnId).toBeUndefined()
    expect(manager.pendingDeltas.size).toBe(0)
    expect(manager.deltaFlushTimers.size).toBe(0)
    // The backoff created the PERSISTED retry row (2026-10-08) — one status
    // message with the structured `retry` payload.
    expect(managed.messages).toHaveLength(1)
    expect(managed.messages[0]).toMatchObject({
      role: 'status',
      statusType: 'retrying',
      retry: { status: 'retrying' },
    })
  })

  it('discards already-flushed partials and persists only the recovered answer', async () => {
    const { managed, events, fire } = harness()
    const completed = { id: 'completed', role: 'assistant' as const, content: 'Earlier commentary', timestamp: 1, isIntermediate: true, turnId: 'earlier' }
    managed.messages.push(completed)
    await fire({ type: 'text_delta', text: 'Discard me', turnId: 'attempt-0' })
    jest.advanceTimersByTime(100)
    expect(events[0]).toMatchObject({ type: 'text_delta', delta: 'Discard me' })
    await fire({ type: 'text_discard', turnId: 'attempt-0' })
    expect(managed.streamingText).toBe('')
    await fire({ type: 'retry', phase: 'backoff', message: 'Retrying...' })
    await fire({ type: 'retry', phase: 'active' })
    await fire({ type: 'text_delta', text: 'Recovered', turnId: 'attempt-1' })
    await fire({ type: 'text_complete', text: 'Recovered', turnId: 'attempt-1' })
    await fire({ type: 'retry', phase: 'end' })

    expect(managed.messages).toHaveLength(3)
    expect(managed.messages[0]).toBe(completed)
    // The persisted retry row sits between the earlier commentary and the
    // recovered answer (chronological ladder start).
    expect(managed.messages[1]).toMatchObject({ role: 'status', statusType: 'retrying' })
    expect(managed.messages[2]).toMatchObject({ role: 'assistant', content: 'Recovered', turnId: 'attempt-1' })
    expect(managed.streamingText).toBe('')
    expect(managed.streamingTurnId).toBeUndefined()
    expect(events.filter(e => e.type === 'text_complete')).toHaveLength(1)
  })

  it('a discard for another identity cannot wipe a newer stream or its batch', async () => {
    const { managed, events, fire } = harness()
    await fire({ type: 'text_delta', text: 'Keep me', turnId: 'newer-attempt' })
    await fire({ type: 'text_discard', turnId: 'older-attempt' })
    expect(managed.streamingText).toBe('Keep me')
    expect(managed.streamingTurnId).toBe('newer-attempt')
    jest.advanceTimersByTime(100)
    expect(events).toContainEqual({ type: 'text_delta', sessionId: managed.id, delta: 'Keep me', turnId: 'newer-attempt' })
  })

  it('repeated failed attempts leave no fused text or unfinished delta timer', async () => {
    const { manager, managed, events, fire } = harness()
    for (let attempt = 0; attempt < 3; attempt++) {
      await fire({ type: 'text_delta', text: `Partial ${attempt}`, turnId: `attempt-${attempt}` })
      if (attempt === 1) jest.advanceTimersByTime(100)
      await fire({ type: 'text_discard', turnId: `attempt-${attempt}` })
      if (attempt < 2) {
        await fire({ type: 'retry', phase: 'backoff', message: 'Retrying...' })
        await fire({ type: 'retry', phase: 'active' })
      }
    }
    await fire({ type: 'retry', phase: 'end' })
    jest.advanceTimersByTime(100)
    expect(managed.streamingText).toBe('')
    // Only the persisted retry row remains, settled to 'failed' by `retry end`.
    expect(managed.messages).toHaveLength(1)
    expect(managed.messages[0]).toMatchObject({ role: 'status', statusType: 'retrying' })
    expect((managed.messages[0] as { retry?: { status: string } }).retry).toMatchObject({ status: 'failed' })
    expect(manager.pendingDeltas.size).toBe(0)
    expect(manager.deltaFlushTimers.size).toBe(0)
    expect(events.filter(e => e.type === 'text_discard')).toHaveLength(3)
    expect(events.filter(e => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', sessionId: managed.id, delta: 'Partial 1', turnId: 'attempt-1' },
    ])
  })

  it('attaches startedAt (first-delta time) to text blocks while keeping timestamp as completion time', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 1000
    manager.monotonic = () => clock

    // First delta at t=1000 (block becomes visible); it completes at t=2000.
    await fire({ type: 'text_delta', text: 'Thinking…', turnId: 'turn-1__m1' })
    clock = 2000
    await fire({ type: 'text_complete', text: 'Thinking…', turnId: 'turn-1__m1', isIntermediate: true })

    // timestamp stays the completion time (bubble display, unread logic);
    // startedAt carries the moment the block first became visible so the
    // process card can order rows by when the user actually saw them.
    expect(managed.messages[0]).toMatchObject({
      role: 'assistant',
      turnId: 'turn-1__m1',
      timestamp: 2000,
      startedAt: 1000,
    })
    expect(events.find(e => e.type === 'text_complete')).toMatchObject({
      type: 'text_complete',
      turnId: 'turn-1__m1',
      timestamp: 2000,
      startedAt: 1000,
    })
  })

  it('leaves startedAt undefined for text blocks that never streamed', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 1000
    manager.monotonic = () => clock

    clock = 500
    await fire({ type: 'text_complete', text: 'Instant answer', turnId: 'turn-2__m1', isIntermediate: false })

    const msg = managed.messages[0]
    expect(msg).toMatchObject({ role: 'assistant', turnId: 'turn-2__m1', timestamp: 500 })
    expect(msg.startedAt).toBeUndefined()
    const forwarded = events.find(e => e.type === 'text_complete')
    expect(forwarded).toBeDefined()
    expect(forwarded!).toMatchObject({ type: 'text_complete', turnId: 'turn-2__m1', timestamp: 500 })
    expect('startedAt' in (forwarded as Record<string, unknown>)).toBe(false)
  })

  it('prefers event.startedAt (adapter-stamped thinking blocks) over the delta map', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 1000
    manager.monotonic = () => clock

    // Thinking-only blocks never stream deltas, so the delta map has no entry
    // for their turnId; the adapter stamps event.startedAt (its message_start
    // time) instead. That hint must win and persist, timestamp stays 2000.
    clock = 2000
    await fire({ type: 'text_complete', text: 'thinking...', turnId: 'turn-3__m1', isIntermediate: true, startedAt: 1500 })

    expect(managed.messages[0]).toMatchObject({ role: 'assistant', turnId: 'turn-3__m1', timestamp: 2000, startedAt: 1500 })
    const forwarded = events.find(e => e.type === 'text_complete')
    expect(forwarded).toBeDefined()
    expect(forwarded!).toMatchObject({ type: 'text_complete', turnId: 'turn-3__m1', timestamp: 2000, startedAt: 1500 })
  })
})
