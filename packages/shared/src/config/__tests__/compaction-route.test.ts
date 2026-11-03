/**
 * 「会话压缩」 resolution.
 *
 * The pin is opt-in: an unset `compactionStrategy` must leave compaction exactly
 * where it was (the session's own group), and every way the reference can go
 * stale — deleted group, disabled group, group with no models, a session that is
 * not on a gateway endpoint — must degrade to "no pin" rather than to a broken
 * summary. These pin that, plus the two things the subprocess cannot work out
 * for itself: the group's endpoint and a model the group actually serves.
 */

import { describe, expect, it } from 'bun:test'

import { repointStrategyBaseUrl, resolveCompactionRoute } from '../compaction-route'

const GATEWAY = 'http://127.0.0.1:8787/s/agnes'

/** A config with one usable compaction group called `compact`. */
function config(overrides: Record<string, unknown> = {}) {
  return {
    compactionStrategy: 'compact',
    strategies: [
      { id: 'agnes', modelAliases: { 'agnes-3.0-flash': 'agnes-3.0-flash' } },
      { id: 'compact', modelAliases: { cheap: 'cheap', cheaper: 'cheaper' } },
    ],
    providers: [{ id: 'p1' }],
    ...overrides,
  }
}

describe('repointStrategyBaseUrl', () => {
  it('swaps the strategy segment and keeps host, port and query', () => {
    expect(repointStrategyBaseUrl('http://127.0.0.1:8787/s/agnes', 'compact')).toBe(
      'http://127.0.0.1:8787/s/compact',
    )
    expect(repointStrategyBaseUrl('http://127.0.0.1:8787/s/agnes/v1', 'compact')).toBe(
      'http://127.0.0.1:8787/s/compact/v1',
    )
  })

  it('drops a trailing slash so both endpoints serialize the same way', () => {
    expect(repointStrategyBaseUrl('http://127.0.0.1:8787/s/agnes/', 'compact')).toBe(
      'http://127.0.0.1:8787/s/compact',
    )
  })

  it('encodes a strategy id that is not URL-safe', () => {
    expect(repointStrategyBaseUrl(GATEWAY, '会话 压缩')).toBe(
      `http://127.0.0.1:8787/s/${encodeURIComponent('会话 压缩')}`,
    )
  })

  it('refuses anything that is not a strategy-scoped gateway endpoint', () => {
    // A direct connection has no group to move to. Guessing would send the
    // summary to the upstream with a model name it does not know.
    expect(repointStrategyBaseUrl('https://api.anthropic.com', 'compact')).toBeUndefined()
    expect(repointStrategyBaseUrl('http://127.0.0.1:8787/v1', 'compact')).toBeUndefined()
    expect(repointStrategyBaseUrl('', 'compact')).toBeUndefined()
    expect(repointStrategyBaseUrl('not a url', 'compact')).toBeUndefined()
    expect(repointStrategyBaseUrl(undefined, 'compact')).toBeUndefined()
  })
})

describe('resolveCompactionRoute', () => {
  it('pins the endpoint and a model the group serves', () => {
    expect(resolveCompactionRoute(config(), GATEWAY)).toEqual({
      strategyId: 'compact',
      model: 'cheap',
      baseUrl: 'http://127.0.0.1:8787/s/compact',
    })
  })

  it('is a no-op when the setting is absent', () => {
    // The pre-setting behaviour: compaction runs on the session's group.
    expect(resolveCompactionRoute({ strategies: config().strategies }, GATEWAY)).toBeUndefined()
    expect(resolveCompactionRoute(null, GATEWAY)).toBeUndefined()
    expect(resolveCompactionRoute(undefined, GATEWAY)).toBeUndefined()
  })

  it('degrades to the session group when the reference is stale', () => {
    expect(resolveCompactionRoute(config({ compactionStrategy: 'gone' }), GATEWAY)).toBeUndefined()
  })

  it('refuses a disabled group — routing to it would 404, not summarize', () => {
    const cfg = config({
      strategies: [
        { id: 'agnes', modelAliases: { a: 'a' } },
        { id: 'compact', enabled: false, modelAliases: { cheap: 'cheap' } },
      ],
    })
    expect(resolveCompactionRoute(cfg, GATEWAY)).toBeUndefined()
  })

  it('refuses a group with no models of its own', () => {
    const cfg = config({
      strategies: [
        { id: 'agnes', modelAliases: { a: 'a' } },
        { id: 'compact', modelAliases: {} },
      ],
    })
    expect(resolveCompactionRoute(cfg, GATEWAY)).toBeUndefined()
  })

  it('refuses a session that is not on a gateway endpoint', () => {
    expect(resolveCompactionRoute(config(), 'https://api.anthropic.com')).toBeUndefined()
    expect(resolveCompactionRoute(config(), undefined)).toBeUndefined()
  })

  it('skips a model whose availability window is closed', () => {
    // `cheap` is a limited-time model whose window ended in 2000; the summary
    // must not be pinned to it just because it is declared first.
    //
    // Members are what makes the window apply at all — the same rule the router
    // uses (`pickStrategyModel`): a group written before members existed has
    // only its declared order, and nothing to check the clock against.
    const cfg = config({
      strategies: [
        { id: 'agnes', modelAliases: { a: 'a' } },
        {
          id: 'compact',
          modelAliases: { cheap: 'cheap', cheaper: 'cheaper' },
          members: [
            { provider: 'p1', model: 'cheap' },
            { provider: 'p1', model: 'cheaper' },
          ],
        },
      ],
      providers: [
        {
          id: 'p1',
          timeWindows: {
            cheap: { tz: 'UTC', from: '2000-01-01', to: '2000-01-31' },
          },
        },
      ],
    })
    const route = resolveCompactionRoute(cfg, GATEWAY, Date.UTC(2026, 10, 3))
    expect(route?.model).toBe('cheaper')
  })

  it('carries the declared size of the pinned model', () => {
    // The summary sizes its output against the *compaction* model's window; a
    // wrong number here truncates a summary that had room, or overflows one
    // that did not.
    const cfg = config({
      strategies: [
        { id: 'agnes', modelAliases: { a: 'a' } },
        {
          id: 'compact',
          modelAliases: { cheap: 'cheap' },
          members: [{ provider: 'p1', model: 'cheap' }],
        },
      ],
      providers: [
        {
          id: 'p1',
          modelOptions: { cheap: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
        },
      ],
    })
    expect(resolveCompactionRoute(cfg, GATEWAY)).toMatchObject({
      model: 'cheap',
      contextWindow: 128_000,
      maxTokens: 8_192,
    })
  })

  it('omits the size when nothing declares it', () => {
    const route = resolveCompactionRoute(config(), GATEWAY)
    expect(route).not.toHaveProperty('contextWindow')
    expect(route).not.toHaveProperty('maxTokens')
  })
})
