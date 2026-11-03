/**
 * 「会话压缩」 — the summarization override.
 *
 * Compaction has no per-call model parameter; the one seam that decides the
 * model, key, headers and env of a *summary* request is
 * `_getSummarizationRequestAuth`. These pin that the wrapper only ever replaces
 * the model description (endpoint + name + declared size) and the attribution
 * header — the key, provider, api shape and env stay the session's, because
 * every strategy group is served by the same gateway.
 *
 * They also pin the failure mode: when nothing is configured, or the SDK no
 * longer has the seam, compaction must keep running on the session's group
 * instead of failing the turn.
 */

import { describe, expect, it } from 'bun:test'

import {
  installCompactionRoute,
  summarizationAuthForRoute,
  type CompactionRoute,
  type SummarizationCapableSession,
} from './compaction-auth.ts'

const ROUTE: CompactionRoute = {
  strategyId: 'compact',
  model: 'cheap-model',
  baseUrl: 'http://127.0.0.1:8787/s/compact',
}

/** The auth the SDK would produce for the session's own model. */
function sessionAuth() {
  return {
    model: {
      id: 'agnes-3.0-flash',
      name: 'Agnes',
      provider: 'custom-endpoint',
      api: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:8787/s/agnes',
      contextWindow: 512_000,
      maxTokens: 65_536,
      reasoning: true,
    },
    apiKey: 'sk-session',
    headers: { 'x-craft-session-id': 'sess-1' },
    env: { FOO: '1' },
  }
}

describe('summarizationAuthForRoute', () => {
  it('leaves the SDK result untouched when no group is configured', () => {
    // Identity, not a copy: an unset setting must be byte-identical to the
    // behaviour before it existed.
    const auth = sessionAuth()
    expect(summarizationAuthForRoute(auth, undefined)).toBe(auth)
  })

  it('ignores an incomplete route instead of sending a half-built request', () => {
    const auth = sessionAuth()
    expect(summarizationAuthForRoute(auth, { ...ROUTE, model: '' })).toBe(auth)
    expect(summarizationAuthForRoute(auth, { ...ROUTE, baseUrl: '' })).toBe(auth)
  })

  it('repoints the model at the compaction group and names its model', () => {
    const result = summarizationAuthForRoute(sessionAuth(), ROUTE)
    expect(result.model).toMatchObject({
      id: 'cheap-model',
      name: 'cheap-model',
      baseUrl: 'http://127.0.0.1:8787/s/compact',
    })
  })

  it('keeps the transport: provider, api shape, key and env stay the session s', () => {
    // Every group lives on the same gateway, so only the path and the model
    // name may change. Swapping the provider here would lose the custom-endpoint
    // api shape the gateway speaks.
    const result = summarizationAuthForRoute(sessionAuth(), ROUTE)
    expect(result.model).toMatchObject({
      provider: 'custom-endpoint',
      api: 'anthropic-messages',
    })
    expect(result.apiKey).toBe('sk-session')
    expect(result.env).toEqual({ FOO: '1' })
  })

  it('drops the session model s reasoning capability', () => {
    // `reasoning` describes the model we are switching TO. Inherited, the SDK
    // would attach the session's thinking level to a compaction model that may
    // not accept reasoning parameters — a 400 on every summary. A summary does
    // not need it anyway.
    const auth = sessionAuth()
    expect(auth.model.reasoning).toBe(true)
    expect(summarizationAuthForRoute(auth, ROUTE).model).toMatchObject({ reasoning: false })
  })

  it('stamps the request kind so the log does not bill it as conversation', () => {
    const result = summarizationAuthForRoute(sessionAuth(), ROUTE)
    expect(result.headers).toMatchObject({
      'x-craft-session-id': 'sess-1',
      'x-craft-model-kind-override': 'compaction',
    })
  })

  it('keeps the session s declared size when the group declares none', () => {
    const result = summarizationAuthForRoute(sessionAuth(), ROUTE)
    expect(result.model).toMatchObject({ contextWindow: 512_000, maxTokens: 65_536 })
  })

  it('uses the compaction model s declared size when the group has one', () => {
    const result = summarizationAuthForRoute(sessionAuth(), {
      ...ROUTE,
      contextWindow: 128_000,
      maxTokens: 8_192,
    })
    expect(result.model).toMatchObject({ contextWindow: 128_000, maxTokens: 8_192 })
  })

  it('works on a session with no headers and no api key of its own', () => {
    const result = summarizationAuthForRoute({ model: { id: 'm' } }, ROUTE)
    expect(result.headers).toEqual({ 'x-craft-model-kind-override': 'compaction' })
    expect(result.apiKey).toBeUndefined()
  })
})

describe('installCompactionRoute', () => {
  function fakeSession(auth = sessionAuth()): SummarizationCapableSession & { calls: number } {
    const session = {
      calls: 0,
      async _getSummarizationRequestAuth(_model: unknown) {
        session.calls += 1
        return auth
      },
    }
    return session
  }

  it('does nothing when no group is configured', () => {
    const session = fakeSession()
    const original = session._getSummarizationRequestAuth
    expect(installCompactionRoute(session, undefined)).toBe(false)
    expect(session._getSummarizationRequestAuth).toBe(original)
  })

  it('routes the summary through the group and delegates to the original', async () => {
    const session = fakeSession()
    expect(installCompactionRoute(session, ROUTE)).toBe(true)

    const auth = await session._getSummarizationRequestAuth!({ id: 'agnes-3.0-flash' })
    expect(session.calls).toBe(1)
    expect(auth.model).toMatchObject({
      id: 'cheap-model',
      baseUrl: 'http://127.0.0.1:8787/s/compact',
    })
    expect(auth.apiKey).toBe('sk-session')
  })

  it('refuses — and says why — when the SDK lost the seam', () => {
    const messages: string[] = []
    expect(installCompactionRoute({}, ROUTE, (m) => messages.push(m))).toBe(false)
    expect(messages.join('\n')).toContain('会话压缩')
    expect(messages.join('\n')).toContain('compact')
  })

  it('logs the active pin so a session transcript explains its routing', () => {
    const messages: string[] = []
    installCompactionRoute(fakeSession(), ROUTE, (m) => messages.push(m))
    expect(messages.join('\n')).toContain('cheap-model')
    expect(messages.join('\n')).toContain('http://127.0.0.1:8787/s/compact')
  })
})
