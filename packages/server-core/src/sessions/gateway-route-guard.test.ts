/**
 * The gateway route guard: no silent fallback to a direct upstream.
 *
 * Before this, an unset/unknown strategy id fell through to the session's raw
 * connection. The session looked healthy, replies worked — and not one of those
 * requests reached the gateway, so the logs and usage pages showed nothing.
 * The guard refuses instead.
 *
 * These test `resolveStrategyRoute` directly: it is the pure decision, with the
 * runtime singleton and the config file passed in as arguments. Reaching for
 * the real singleton here would need a live gateway process and would let a
 * cached `enabled` from one case decide every other case.
 */

import { describe, expect, it } from 'bun:test'
import { resolveStrategyRoute, SessionRoutingError } from './SessionManager'

/** A gateway that is configured and up. */
const LIVE = { gatewayEnabled: true, gatewayRunning: true, gatewayBaseUrl: 'http://127.0.0.1:8787' }

const ONE_STRATEGY = [
  { id: 'auto', type: 'round_robin', modelAliases: { 'pub-a': 'pub-a', 'pub-b': 'pub-b' } },
]

describe('resolveStrategyRoute — the guard', () => {
  it('refuses when the gateway is usable but no strategy is selected', () => {
    // The bug this whole change exists for.
    const route = resolveStrategyRoute({ ...LIVE, strategyId: undefined, strategies: ONE_STRATEGY, resolvedModel: 'pub-a' })
    expect(route.ok).toBe(false)
    expect(route.ok === false && route.reason).toBe('no_strategy_selected')
  })

  it('refuses when the selected strategy does not exist', () => {
    const route = resolveStrategyRoute({ ...LIVE, strategyId: 'gone', strategies: ONE_STRATEGY, resolvedModel: 'pub-a' })
    expect(route.ok === false && route.reason).toBe('strategy_not_found:gone')
  })

  it('refuses when the selected strategy is disabled', () => {
    const route = resolveStrategyRoute({
      ...LIVE,
      strategyId: 'auto',
      strategies: [{ id: 'auto', enabled: false, modelAliases: { 'pub-a': 'pub-a' } }],
      resolvedModel: 'pub-a',
    })
    expect(route.ok === false && route.reason).toBe('strategy_disabled:auto')
  })

  it('refuses when the strategy has no models to serve', () => {
    const route = resolveStrategyRoute({
      ...LIVE,
      strategyId: 'auto',
      strategies: [{ id: 'auto', modelAliases: {} }],
      resolvedModel: 'pub-a',
    })
    expect(route.ok === false && route.reason).toBe('strategy_has_no_models:auto')
  })

  it('refuses when the gateway is configured but not running', () => {
    // Falling back here would re-open the bypass on the exact window where a
    // session most needs the guard: config present, process down.
    const route = resolveStrategyRoute({
      ...LIVE,
      gatewayRunning: false,
      strategyId: 'auto',
      strategies: ONE_STRATEGY,
      resolvedModel: 'pub-a',
    })
    expect(route.ok === false && route.reason).toBe('gateway_not_running')
  })

  it('routes when the gateway is usable and the strategy is good', () => {
    const route = resolveStrategyRoute({ ...LIVE, strategyId: 'auto', strategies: ONE_STRATEGY, resolvedModel: 'pub-a' })
    expect(route.ok).toBe(true)
    if (!route.ok) return
    expect(route.baseUrl).toBe('http://127.0.0.1:8787/s/auto')
    expect(route.models).toEqual(['pub-a', 'pub-b'])
    // The resolved model survives when it is one the strategy serves.
    expect(route.model).toBe('pub-a')
  })

  it('falls back to the strategy first model when the session model is not served', () => {
    const route = resolveStrategyRoute({ ...LIVE, strategyId: 'auto', strategies: ONE_STRATEGY, resolvedModel: 'other-model' })
    expect(route.ok && route.model).toBe('pub-a')
  })

  it('reports unconfigured rather than refusing, so a fresh install works', () => {
    const route = resolveStrategyRoute({
      gatewayEnabled: false,
      gatewayRunning: false,
      gatewayBaseUrl: '',
      strategyId: undefined,
      strategies: [],
      resolvedModel: 'm',
    })
    // `ok:false` here means "the caller keeps its own connection", which is the
    // one refusal that is not an error.
    expect(route.ok === false && route.reason).toBe('gateway_unconfigured')
  })
})

describe('SessionRoutingError', () => {
  it('explains the no-strategy case as a settings step', () => {
    expect(new SessionRoutingError('no_strategy_selected').message).toContain('策略组')
  })

  it('names the missing/disabled/modelless strategy', () => {
    expect(new SessionRoutingError('strategy_not_found:auto').message).toContain('auto')
    expect(new SessionRoutingError('strategy_disabled:auto').message).toContain('停用')
    expect(new SessionRoutingError('strategy_has_no_models:auto').message).toContain('模型')
  })

  it('carries the reason so callers can branch on it', () => {
    expect(new SessionRoutingError('gateway_not_running').reason).toBe('gateway_not_running')
  })

  it('degrades to a generic message for an unknown reason', () => {
    expect(new SessionRoutingError('something_new').message).toContain('something_new')
  })
})
