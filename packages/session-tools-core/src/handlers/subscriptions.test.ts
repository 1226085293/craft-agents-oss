import { describe, expect, it } from 'bun:test'
import type { SessionToolContext } from '../context.ts'
import {
  handleListSubscriptions,
  handleSubscribeSession,
  handleUnsubscribeSession,
} from './subscriptions.ts'

function makeCtx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return { sessionId: 'self', ...overrides } as SessionToolContext
}

describe('subscription handlers', () => {
  it('subscribes and reports what is followed', async () => {
    const ctx = makeCtx({
      subscribeSessionFn: async (id: string) => ({ subscribed: true, targetIds: [id] }),
    })

    const res = await handleSubscribeSession(ctx, { sessionId: 'child-1' })

    expect(res.isError).toBeFalsy()
    expect(JSON.stringify(res)).toContain('child-1')
  })

  it('rejects self-subscription without calling the backend', async () => {
    let called = false
    const ctx = makeCtx({
      subscribeSessionFn: async () => {
        called = true
        return { subscribed: true, targetIds: [] }
      },
    })

    const res = await handleSubscribeSession(ctx, { sessionId: 'self' })

    expect(res.isError).toBe(true)
    expect(called).toBe(false)
  })

  it('requires a sessionId', async () => {
    const ctx = makeCtx({ subscribeSessionFn: async () => ({ subscribed: true, targetIds: [] }) })
    const res = await handleSubscribeSession(ctx, { sessionId: '  ' })
    expect(res.isError).toBe(true)
  })

  it('reports a missing backend instead of pretending to subscribe', async () => {
    const res = await handleSubscribeSession(makeCtx(), { sessionId: 'child-1' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).toContain('not available')
  })

  it('surfaces backend errors', async () => {
    const ctx = makeCtx({
      subscribeSessionFn: async () => {
        throw new Error('Session child-9 not found')
      },
    })
    const res = await handleSubscribeSession(ctx, { sessionId: 'child-9' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).toContain('not found')
  })

  it('unsubscribe is idempotent and says nothing changed', async () => {
    const ctx = makeCtx({
      unsubscribeSessionFn: async () => ({ unsubscribed: false, targetIds: [] }),
    })
    const res = await handleUnsubscribeSession(ctx, { sessionId: 'child-1' })
    expect(res.isError).toBeFalsy()
    expect(JSON.stringify(res)).toContain('nothing to stop')
  })

  it('reports the remaining targets after unsubscribe', async () => {
    const ctx = makeCtx({
      unsubscribeSessionFn: async () => ({ unsubscribed: true, targetIds: ['child-2'] }),
    })
    const res = await handleUnsubscribeSession(ctx, { sessionId: 'child-1' })
    expect(JSON.stringify(res)).toContain('child-2')
  })

  it('lists subscriptions and handles the empty case', async () => {
    const empty = await handleListSubscriptions(makeCtx({ listSubscriptionsFn: () => [] }))
    expect(JSON.stringify(empty)).toContain('not following any')

    const two = await handleListSubscriptions(
      makeCtx({ listSubscriptionsFn: () => ['a', 'b'] }),
    )
    expect(JSON.stringify(two)).toContain('a, b')
  })
})
