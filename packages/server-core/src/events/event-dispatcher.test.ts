import { describe, it, expect, mock } from 'bun:test'
import { EventDispatcher, type DispatchTarget } from './event-dispatcher.ts'
import type { EventMeta } from '@craft-agent/shared/events/event-store.ts'

/**
 * Routing order is the contract these pin down.
 *
 * Thread ownership must be consulted before subscriptions, because a
 * subscription says "I want events from qq" — a class — while a thread is one
 * conversation already being handled. If subscriptions won, a follow-up message
 * in a busy channel would keep re-entering triage, which is the behaviour this
 * whole layer exists to remove.
 */

function event(overrides: Partial<EventMeta> = {}): EventMeta {
  return {
    spec: 'v1',
    id: 'evt-1',
    source: 'qq',
    receivedAt: Date.now(),
    type: 'message.received',
    title: 'hi',
    recipients: [],
    links: [{ url: 'message://qq/group:1/msg-1' }],
    attachments: [],
    delivered: false,
    deliveries: [],
    routing: [],
    ...overrides,
  } as EventMeta
}

function makeDispatcher(options: {
  threadOwner?: string | undefined
  alive?: (sessionId: string) => boolean
  subscriptions?: Array<{ subscriptionId: string; sessionId: string; filter: { sources?: string[]; types?: string[] }; createdAt: number }>
}) {
  const delivered: Array<{ sessionId: string; eventId: string }> = []
  const unclaimed: EventMeta[] = []

  const target: DispatchTarget = {
    deliver: mock(async (sessionId: string, params: { eventId: string }) => {
      delivered.push({ sessionId, eventId: params.eventId })
      return true
    }),
    isBusy: () => false,
    hasQueuedUserMessage: () => false,
    ...(options.alive ? { exists: options.alive } : {}),
  }

  const dispatcher = new EventDispatcher({
    getSubscriptions: () => (options.subscriptions ?? []) as never,
    target,
    onUnclaimed: (meta) => unclaimed.push(meta),
    ...(options.threadOwner !== undefined || options.alive
      ? {
          resolveThreadOwner: (meta: EventMeta) => {
            // The real resolver lives in EventService; this mirrors its contract:
            // a binding to a dead session is treated as unbound.
            const owner = options.threadOwner
            if (!owner) return undefined
            const alive = options.alive
            if (alive && !alive(owner)) return undefined
            return owner
          },
        }
      : {}),
    mergeWindowMs: 0,
  })

  return { dispatcher, delivered, unclaimed }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('event routing order', () => {
  it('delivers to the thread owner without touching subscriptions', async () => {
    const { dispatcher, delivered, unclaimed } = makeDispatcher({
      threadOwner: 'owner-session',
      subscriptions: [
        { subscriptionId: 'sub1', sessionId: 'subscriber', filter: { sources: ['qq'] }, createdAt: 0 },
      ],
    })
    dispatcher.dispatch(event())
    await flush()
    expect(delivered.map((entry) => entry.sessionId)).toEqual(['owner-session'])
    expect(unclaimed).toHaveLength(0)
  })

  it('never hands a bound thread to the supervisor', async () => {
    const { dispatcher, unclaimed } = makeDispatcher({ threadOwner: 'owner-session' })
    dispatcher.dispatch(event())
    await flush()
    expect(unclaimed).toHaveLength(0)
  })

  it('falls back to the funnel when the owner session is gone', async () => {
    // A binding outlives its session. Routing into the void would make the event
    // invisible, because it counts as routed and nothing retries it.
    const { dispatcher, delivered, unclaimed } = makeDispatcher({
      threadOwner: 'deleted-session',
      alive: () => false,
    })
    dispatcher.dispatch(event())
    await flush()
    expect(delivered).toHaveLength(0)
    expect(unclaimed).toHaveLength(1)
  })

  it('uses subscriptions when the thread is unbound', async () => {
    const { dispatcher, delivered } = makeDispatcher({
      alive: () => true,
      subscriptions: [
        { subscriptionId: 'sub1', sessionId: 'subscriber', filter: { sources: ['qq'] }, createdAt: 0 },
      ],
    })
    dispatcher.dispatch(event())
    await flush()
    expect(delivered.map((entry) => entry.sessionId)).toEqual(['subscriber'])
  })

  it('sends an unbound, unsubscribed event to the supervisor tier', async () => {
    const { dispatcher, unclaimed } = makeDispatcher({})
    dispatcher.dispatch(event())
    await flush()
    expect(unclaimed).toHaveLength(1)
  })

  it('routes each event once even if dispatched twice', async () => {
    const { dispatcher, delivered } = makeDispatcher({ threadOwner: 'owner-session' })
    const same = event()
    dispatcher.dispatch(same)
    dispatcher.dispatch(same)
    await flush()
    expect(delivered).toHaveLength(1)
  })
})
