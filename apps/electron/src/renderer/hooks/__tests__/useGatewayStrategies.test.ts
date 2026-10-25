/**
 * The composer's send-gate reads `unavailable` as "the gateway cannot route at
 * all, so the legacy direct path is still serving this session — do not block".
 *
 * That reading is only correct for two of the three states a machine can be in.
 * A **running** gateway with **zero** strategy groups is the server's
 * `no_strategy_selected` refusal: there is no direct-path fallback, so sending
 * must be blocked. Folding that state into `unavailable` (as it was) let the
 * message through and it failed a round trip later — reported repeatedly as
 * "策略组无效了还能发送".
 *
 * `strategies.length` alone cannot tell these apart, which is why the rule is
 * asserted here rather than left to each call site.
 */

import { describe, expect, test } from 'bun:test'

import { projectGatewayStrategies } from '../useGatewayStrategies'

describe('projectGatewayStrategies — `unavailable` means "cannot route at all"', () => {
  test('running gateway with no groups: NOT unavailable (this is what must block)', () => {
    const out = projectGatewayStrategies({ running: true, enabled: true, strategies: [] })
    expect(out.strategies).toHaveLength(0)
    // The whole point: null here is what lets ChatPage's gate see the empty
    // list and block, instead of concluding "gateway is off, let it through".
    expect(out.unavailable).toBeNull()
  })

  test('gateway not running: unavailable', () => {
    expect(projectGatewayStrategies({ running: false, enabled: true, strategies: [] }).unavailable).toBe(
      'LLM 网关未运行',
    )
  })

  test('gateway disabled: unavailable', () => {
    expect(projectGatewayStrategies({ running: true, enabled: false, strategies: [] }).unavailable).toBe(
      'LLM 网关未运行',
    )
  })

  test('no status payload at all (older main process): unavailable', () => {
    expect(projectGatewayStrategies(null).unavailable).toBe('当前构建不支持 LLM 网关')
  })

  test('running gateway with a group: neither empty nor unavailable', () => {
    const out = projectGatewayStrategies({
      running: true,
      enabled: true,
      strategies: [{ id: 'auto', models: ['agnes-3.0-flash'], enabled: true, usable: true }],
    })
    expect(out.unavailable).toBeNull()
    expect(out.strategies.map((s) => s.id)).toEqual(['auto'])
  })

  test('carries the display name through to the picker', () => {
    // Without this the composer showed the slug, so renaming a group to 「日常主用」
    // still read `provider` — the id `normalizeName` derived from it.
    const out = projectGatewayStrategies({
      running: true,
      enabled: true,
      strategies: [{ id: 'provider', name: '日常主用', models: ['m'], enabled: true, usable: true }],
    })
    expect(out.strategies[0]?.name).toBe('日常主用')
    expect(out.strategies[0]?.id).toBe('provider')
  })

  test('an older payload without a name leaves it undefined for the id fallback', () => {
    const out = projectGatewayStrategies({
      running: true,
      enabled: true,
      strategies: [{ id: 'auto', models: ['m'], enabled: true, usable: true }],
    })
    expect(out.strategies[0]?.name).toBeUndefined()
  })
})
