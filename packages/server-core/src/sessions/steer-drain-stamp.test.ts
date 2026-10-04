import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import type { AgentEvent } from '@craft-agent/core/types'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type EventHarness = {
  processEvent(managed: ManagedSession, event: AgentEvent): Promise<void>
  pendingDeltas: Map<string, { delta: string; turnId?: string }>
  deltaFlushTimers: Map<string, ReturnType<typeof setTimeout>>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  persistSession(managed: ManagedSession): void
  monotonic(): number
}

/** Exercise the real event methods without agents, disk writes or watchers. */
function harness() {
  const manager = Object.create(SessionManager.prototype) as unknown as EventHarness
  const events: SessionEvent[] = []
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  manager.sendEvent = event => { events.push(event) }
  manager.persistSession = () => {}
  manager.monotonic = () => Date.now()
  const managed = createManagedSession({ id: 'steer-drain-stamp' }, {
    id: 'workspace', slug: 'workspace', name: 'Test', rootPath: '/unused-steer-drain', createdAt: Date.now(),
  })
  return { manager, managed, events, fire: (event: AgentEvent) => manager.processEvent(managed, event) }
}

describe('steer_injected drain re-stamp (2026-10-07 plain-jade)', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('re-stamps the pending guidance at the drain moment and re-merges it', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 130 // the guide-click stamp already consumed values up to 130
    manager.monotonic = () => ++clock

    managed.messages = [{
      id: 'g1', role: 'user', content: '还有你的名字',
      timestamp: 100, isGuidance: true, isQueued: false, startedAt: 130,
    }] as never
    managed.steerDrainPendingFor = 'g1'

    await fire({ type: 'steer_injected' })

    // Row position + display time = the drain moment (strictly after the
    // guide-click stamp 130).
    expect(managed.messages[0]?.startedAt).toBe(131)
    expect(managed.messages[0]?.timestamp).toBe(100) // display semantics untouched
    const um = events.find(e => e.type === 'user_message') as { status?: string; message?: { id?: string; startedAt?: number } } | undefined
    expect(um).toBeDefined()
    expect(um?.status).toBe('accepted')
    expect(um?.message?.id).toBe('g1')
    expect(um?.message?.startedAt).toBe(131)
    expect(managed.steerDrainPendingFor).toBeUndefined()
  })

  it('is a no-op when no guidance is pending drain', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 100
    manager.monotonic = () => ++clock

    managed.messages = [{
      id: 'g1', role: 'user', content: '还有你的名字',
      timestamp: 100, isGuidance: true, isQueued: false, startedAt: 130,
    }] as never

    await fire({ type: 'steer_injected' })

    expect(managed.messages[0]?.startedAt).toBe(130) // untouched
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  it('falls back to the guide-click stamp when the target message is gone', async () => {
    const { manager, managed, events, fire } = harness()
    let clock = 100
    manager.monotonic = () => ++clock

    // Canceled/removed guidance: the flag points at a missing record.
    managed.messages = [] as never
    managed.steerDrainPendingFor = 'gone'

    await fire({ type: 'steer_injected' })

    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
    expect(managed.steerDrainPendingFor).toBeUndefined()
  })
})

describe('complete-time guidance pairing (2026-10-07 clever-marble)', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('re-stamps each guidance row to the top of the round that answers it', async () => {
    const { manager, managed, events, fire } = harness()

    // One run: Q1 folders + two queued guidances (名字/日期). The ordered-
    // mandate wrap made the model reply in order: [folders, 名字, 日期].
    managed.messages = [
      { id: 'g1', role: 'user', content: '告诉我你的名字', timestamp: 1000, isGuidance: true, startedAt: 5000 },
      { id: 'g2', role: 'user', content: '告诉我今天的日期', timestamp: 2000, isGuidance: true, startedAt: 6000 },
      { id: 'm1', role: 'assistant', content: 'thinking', timestamp: 3000, isIntermediate: true },
      { id: 'm2', role: 'assistant', content: 'folders…', timestamp: 4000, startedAt: 3500, isIntermediate: false },
      { id: 'm4', role: 'assistant', content: '我是…', timestamp: 5500, startedAt: 5200, isIntermediate: false },
      { id: 'm6', role: 'assistant', content: '今天是…', timestamp: 7000, startedAt: 6800, isIntermediate: false },
    ] as never
    managed.currentRunStartedAt = 500

    await fire({ type: 'complete' })

    // Each row leads its ANSWERING round: key = previous final reply ts + 1
    // (g1 → just after folders m2 @4000; g2 → just after 名字 m4 @5500).
    // NOT the paired reply's startedAt — the round's thinking starts earlier
    // than the reply, and the row must sit ABOVE it.
    const g1 = managed.messages.find(m => m.id === 'g1')!
    const g2 = managed.messages.find(m => m.id === 'g2')!
    expect(g1.startedAt).toBe(4001)
    expect(g2.startedAt).toBe(5501)
    const ums = events.filter(e => e.type === 'user_message')
    expect(ums).toHaveLength(2)
    expect(ums.map(e => (e as { message?: { id?: string } }).message?.id)).toEqual(['g1', 'g2'])
    expect(ums.map(e => (e as { status?: string }).status)).toEqual(['accepted', 'accepted'])
  })

  it('is idempotent — a second complete re-emits nothing', async () => {
    const { manager, managed, events, fire } = harness()

    managed.messages = [
      { id: 'g1', role: 'user', content: 'g', timestamp: 1000, isGuidance: true, startedAt: 4001 },
      { id: 'm2', role: 'assistant', content: 'folders…', timestamp: 4000, isIntermediate: false },
      { id: 'm4', role: 'assistant', content: '我是…', timestamp: 5500, startedAt: 5200, isIntermediate: false },
    ] as never
    managed.currentRunStartedAt = 500

    await fire({ type: 'complete' })
    events.length = 0
    await fire({ type: 'complete' })

    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  it('keeps the drain stamp when the model skipped the guidance reply', async () => {
    // wise-boulder shape: two guidances but only ONE final reply (the
    // original task) — no paired reply → no re-stamp.
    const { manager, managed, events, fire } = harness()

    managed.messages = [
      { id: 'g1', role: 'user', content: 'g1', timestamp: 1000, isGuidance: true, startedAt: 5000 },
      { id: 'g2', role: 'user', content: 'g2', timestamp: 2000, isGuidance: true, startedAt: 6000 },
      { id: 'm2', role: 'assistant', content: 'folders…', timestamp: 4000, startedAt: 3500, isIntermediate: false },
    ] as never
    managed.currentRunStartedAt = 500

    await fire({ type: 'complete' })

    expect(managed.messages.find(m => m.id === 'g1')!.startedAt).toBe(5000)
    expect(managed.messages.find(m => m.id === 'g2')!.startedAt).toBe(6000)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })

  it('does nothing without a run boundary', async () => {
    const { manager, managed, events, fire } = harness()

    managed.messages = [
      { id: 'g1', role: 'user', content: 'g', timestamp: 1000, isGuidance: true, startedAt: 5000 },
      { id: 'm4', role: 'assistant', content: '我是…', timestamp: 5500, startedAt: 5200, isIntermediate: false },
    ] as never

    await fire({ type: 'complete' })

    expect(managed.messages.find(m => m.id === 'g1')!.startedAt).toBe(5000)
    expect(events.filter(e => e.type === 'user_message')).toHaveLength(0)
  })
})
