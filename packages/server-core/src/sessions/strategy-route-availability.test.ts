/**
 * `resolveStrategyRoute` — model selection must respect availability windows.
 *
 * The incident this pins (261029-snug-raven, 2026-10-29): a group whose first
 * model is time-limited (`hy4-preview`, 23:00–08:00) and second model is open
 * all day (`hy3`). The router took `models[0]` without looking at the clock, so
 * every request at 17:00 failed with `no healthy account` even though half the
 * group was open — and the composer showed `hy3`, a model the request was never
 * going to use.
 *
 * The rule under test is `pickStrategyModel` from `@craft-agent/shared/config`,
 * shared by the router, the gateway's status projection and the composer's
 * label so the three can no longer disagree.
 */

import { describe, it, expect } from 'bun:test'

import { resolveStrategyRoute } from './SessionManager.ts'

const strategies = [
  {
    id: 'wb',
    modelAliases: { 'hy4-preview': 'hy4-preview', hy3: 'hy3' },
    members: [
      { provider: 'wb', model: 'hy4-preview' },
      { provider: 'wb', model: 'hy3' },
    ],
    modelProviders: { 'hy4-preview': ['wb'], hy3: ['wb'] },
  },
]

const providers = [
  {
    id: 'wb',
    timeWindows: {
      'hy4-preview': {
        tz: 'Asia/Shanghai',
        spans: [{ start: '23:00', end: '08:00' }],
        to: '2026-10-31 23:59',
      },
    },
  },
]

const base = {
  gatewayEnabled: true,
  gatewayRunning: true,
  gatewayBaseUrl: 'http://127.0.0.1:1',
  strategyId: 'wb',
  strategies,
}

/** 2026-10-29 17:00 Asia/Shanghai — hy4-preview is closed, hy3 is open. */
const EVENING_CST = Date.UTC(2026, 9, 29, 9, 0, 0)
/** 2026-10-29 23:30 Asia/Shanghai — hy4-preview is open. */
const LATE_NIGHT_CST = Date.UTC(2026, 9, 29, 15, 30, 0)

describe('resolveStrategyRoute — availability-aware model choice', () => {
  it('skips a model whose window is closed right now', () => {
    const route = resolveStrategyRoute({ ...base, providers, now: EVENING_CST })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy3')
    // The model list still advertises both: only the default choice moves.
    expect(route.models).toEqual(['hy4-preview', 'hy3'])
  })

  it('keeps the declared order while the first model is open', () => {
    const route = resolveStrategyRoute({ ...base, providers, now: LATE_NIGHT_CST })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy4-preview')
  })

  it('does not route a session to a model it cannot use right now', () => {
    // The session was left on hy4-preview last night. Keeping that choice would
    // send the next request to a closed model; the router takes the open one,
    // which is also what the composer promises.
    const route = resolveStrategyRoute({
      ...base,
      providers,
      now: EVENING_CST,
      resolvedModel: 'hy4-preview',
    })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy3')
  })

  it('keeps an explicit choice while it is open', () => {
    const route = resolveStrategyRoute({
      ...base,
      providers,
      now: LATE_NIGHT_CST,
      resolvedModel: 'hy4-preview',
    })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy4-preview')
  })

  it('keeps the declared order when no provider windows are supplied', () => {
    const route = resolveStrategyRoute({ ...base, now: EVENING_CST })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy4-preview')
  })

  it('falls back to the declared order when every model is closed', () => {
    // Nothing can serve, so the last resort is the declared order: the gateway
    // then reports the real reason ("outside its availability window") instead
    // of the router inventing a route that does not exist.
    const closedProviders = [
      {
        id: 'wb',
        timeWindows: {
          'hy4-preview': { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
          hy3: { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
        },
      },
    ]
    const route = resolveStrategyRoute({ ...base, providers: closedProviders, now: EVENING_CST })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy4-preview')
  })

  it('ignores a disabled member when deciding what is open', () => {
    const route = resolveStrategyRoute({
      ...base,
      now: EVENING_CST,
      strategies: [
        {
          ...strategies[0]!,
          members: [
            { provider: 'wb', model: 'hy4-preview', enabled: false },
            { provider: 'wb', model: 'hy3' },
          ],
        },
      ],
      providers,
    })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.model).toBe('hy3')
  })

  it('ignores members whose provider is disabled', () => {
    const route = resolveStrategyRoute({
      ...base,
      now: LATE_NIGHT_CST,
      providers: [{ ...providers[0]!, enabled: false }, { id: 'other', enabled: true }],
    })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    // hy3's provider is not in the list at all, so nothing is open and the
    // declared order answers.
    expect(route.model).toBe('hy4-preview')
  })
})
