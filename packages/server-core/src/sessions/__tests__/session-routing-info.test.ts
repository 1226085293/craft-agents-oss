/**
 * What `get_session_info` reports as a session's routing identity.
 *
 * The regression this pins: an agent asked "what is this session's status"
 * answered 「LLM 连接：anthropic-api-4」 for a session that had been switched to a
 * strategy group. The record still holds the connection the session was created
 * with, but nothing routes through it — the gateway does, via /s/<strategy>.
 */

import { describe, expect, it } from 'bun:test'

import { sessionRoutingInfo } from '../SessionManager.ts'

const strategies = [
  { id: 'provider', name: '默认', modelAliases: { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'agnes-3.0-flash': 'agnes-3.0-flash' } },
  { id: 'provider-2', name: '备用', modelAliases: { 'agnes-3.0-flash': 'agnes-3.0-flash' } },
  { id: 'anon' },
]

describe('sessionRoutingInfo', () => {
  it('a gateway session reports the strategy, not its stale connection', () => {
    const out = sessionRoutingInfo(
      { strategy: 'provider', llmConnection: 'anthropic-api-4', model: 'agnes-3.0-flash' },
      strategies,
    )
    expect(out.llmConnection).toBeUndefined()
    expect(out.llmStrategy).toBe('provider')
    expect(out.strategyName).toBe('默认')
  })

  it('reports the model the next request will use', () => {
    // The session's stored model is not served by this group, so the router
    // falls back to the group's first model — the same rule as the composer.
    expect(
      sessionRoutingInfo({ strategy: 'provider', model: 'gpt-x' }, strategies).model,
    ).toBe('deepseek-v4.1-flash')
    expect(
      sessionRoutingInfo({ strategy: 'provider', model: 'agnes-3.0-flash' }, strategies).model,
    ).toBe('agnes-3.0-flash')
  })

  it('a session without a strategy keeps reporting its connection', () => {
    // Direct connections still exist when the gateway is off; dropping the
    // field there would lose the only routing fact the session has.
    const out = sessionRoutingInfo(
      { llmConnection: 'anthropic-api-4', model: 'agnes-3.0-flash' },
      strategies,
    )
    expect(out).toEqual({ llmConnection: 'anthropic-api-4', model: 'agnes-3.0-flash' })
    expect(out.llmStrategy).toBeUndefined()
  })

  it('a strategy id that no longer exists still hides the stale connection', () => {
    // Pointing at a deleted group is a broken route, not a reason to claim the
    // old connection is serving.
    const out = sessionRoutingInfo({ strategy: 'gone', llmConnection: 'anthropic-api-4' }, strategies)
    expect(out.llmConnection).toBeUndefined()
    expect(out.llmStrategy).toBe('gone')
    expect(out.strategyName).toBeUndefined()
  })

  it('a strategy with no models keeps the session model rather than inventing one', () => {
    const out = sessionRoutingInfo({ strategy: 'anon', model: 'm-1' }, strategies)
    expect(out.model).toBe('m-1')
  })
})
