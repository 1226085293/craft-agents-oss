import { describe, expect, it } from 'bun:test'
import {
  GATEWAY_STREAM_TRUNCATION_RETRY_MARKER,
  GatewayStreamRetryStateStore,
  gatewayRequestFingerprint,
} from '../gateway-stream-retry.ts'

describe('gateway stream retry state', () => {
  it('fingerprints equivalent JSON payloads independent of object key order', () => {
    expect(gatewayRequestFingerprint({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
      .toBe(gatewayRequestFingerprint({ messages: [{ content: 'hi', role: 'user' }], model: 'm' }))
  })

  it('does not include session identity in the request fingerprint', () => {
    expect(gatewayRequestFingerprint({ model: 'm', sessionKey: 'session-a', messages: [] }))
      .toBe(gatewayRequestFingerprint({ model: 'm', sessionKey: 'session-b', messages: [] }))
  })

  it('keeps attempts isolated by session, payload, and strategy', () => {
    const store = new GatewayStreamRetryStateStore({ now: () => 1000, maxEntries: 8 })
    const fp = gatewayRequestFingerprint({ model: 'm', messages: [] })
    const first = store.getOrCreate('s1', fp, 'group-a')
    first.attemptsByRoute.set('route-1::key-1', 1)

    expect(store.getOrCreate('s1', fp, 'group-a').attemptsByRoute.get('route-1::key-1')).toBe(1)
    expect(store.getOrCreate('s2', fp, 'group-a').attemptsByRoute.size).toBe(0)
    expect(store.getOrCreate('s1', fp, 'group-b').attemptsByRoute.size).toBe(0)
    expect(store.getOrCreate('s1', gatewayRequestFingerprint({ model: 'm2', messages: [] }), 'group-a').attemptsByRoute.size).toBe(0)
  })

  it('expires idle state and exposes the retry marker', () => {
    let now = 1000
    const store = new GatewayStreamRetryStateStore({ now: () => now, ttlMs: 50 })
    const fp = gatewayRequestFingerprint({ model: 'm', messages: [] })
    store.getOrCreate('s1', fp, 'group-a').attemptsByRoute.set('r::k', 2)
    now += 51
    expect(store.getOrCreate('s1', fp, 'group-a').attemptsByRoute.size).toBe(0)
    expect(GATEWAY_STREAM_TRUNCATION_RETRY_MARKER).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY')
  })
})
