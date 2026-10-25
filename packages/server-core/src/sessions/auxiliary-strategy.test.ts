/**
 * Auxiliary group resolution: no direct-connection outcome exists.
 *
 * Companion to `gateway-route-guard.test.ts`. That one covers the main chat
 * path; this covers the auxiliary backends (busy / group-chat decisions, title
 * generation, remote-transfer summaries), which used to keep a fallback to the
 * session's raw connection even after the main path was guarded.
 *
 * The fallback was the bug: those calls worked, looked fine, and never reached
 * the gateway — so they were absent from the logs, from the usage totals, and
 * from the group's rate limits and cooldowns. The decision function below
 * therefore has no "use the direct connection" branch to return. Every failure
 * is a refusal with a reason the caller can log.
 */

import { describe, expect, it } from 'bun:test'
import { resolveAuxiliaryStrategyId } from './SessionManager'

const STRATEGIES = [{ id: 'auto' }, { id: 'mini' }, { id: 'other' }]

describe('resolveAuxiliaryStrategyId — session-scoped kinds', () => {
  it("inherits the session's own group", () => {
    const r = resolveAuxiliaryStrategyId({
      kind: 'title',
      sessionStrategyId: 'auto',
      miniStrategy: 'mini',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'auto' })
  })

  it('falls back to miniStrategy when the session has no group', () => {
    const r = resolveAuxiliaryStrategyId({
      kind: 'title',
      sessionStrategyId: undefined,
      miniStrategy: 'mini',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'mini' })
  })

  it('refuses when neither is available — it must not reach for a connection', () => {
    const r = resolveAuxiliaryStrategyId({ kind: 'title', strategies: STRATEGIES })
    expect(r).toEqual({ ok: false, reason: 'no_strategy' })
  })

  it('refuses a session group that is not in the config', () => {
    // A stale id (group renamed or deleted) is a refusal, not a prompt to fall
    // back to whatever connection the session happens to hold.
    const r = resolveAuxiliaryStrategyId({
      kind: 'busy_decision',
      sessionStrategyId: 'gone',
      miniStrategy: 'mini',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: false, reason: 'strategy_not_found:gone' })
  })
})

describe('resolveAuxiliaryStrategyId — dedicated kinds', () => {
  it('ignores the session group and uses miniStrategy', () => {
    // These have no session to inherit from; borrowing the session's group
    // would spend a conversation's quota on background work.
    const r = resolveAuxiliaryStrategyId({
      kind: 'memory',
      sessionStrategyId: 'auto',
      miniStrategy: 'mini',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'mini' })
  })

  it('uses the session group when no dedicated group is configured', () => {
    // "记忆整理策略组：使用会话策略组" — the setting's default, and what an
    // unset config means.
    const r = resolveAuxiliaryStrategyId({
      kind: 'memory',
      sessionStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'auto' })
  })

  it('refuses when neither a dedicated nor a session group exists', () => {
    const r = resolveAuxiliaryStrategyId({ kind: 'memory', strategies: STRATEGIES })
    expect(r).toEqual({ ok: false, reason: 'no_strategy' })
  })

  it('falls back to the first enabled group when no miniStrategy is configured', () => {
    // Memory consolidation has no session to inherit from, so without this it
    // would simply be unavailable on a config that never set up a dedicated
    // group. Still a group, never a raw connection.
    const r = resolveAuxiliaryStrategyId({
      kind: 'memory',
      miniStrategy: undefined,
      fallbackStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'auto' })
  })

  it('prefers miniStrategy over the fallback', () => {
    const r = resolveAuxiliaryStrategyId({
      kind: 'memory',
      miniStrategy: 'mini',
      fallbackStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'mini' })
  })

  it('a session-scoped kind never uses the dedicated fallback', () => {
    // Titles and the rest must follow the session, not drift onto whatever
    // group happens to be first.
    const r = resolveAuxiliaryStrategyId({
      kind: 'title',
      sessionStrategyId: undefined,
      fallbackStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: false, reason: 'no_strategy' })
  })

  it('refuses a kind that is never routed, even with a group available', () => {
    // The connection probe is logged but must never spend a group's quota.
    const r = resolveAuxiliaryStrategyId({
      kind: 'connection_test',
      sessionStrategyId: 'auto',
      miniStrategy: 'mini',
      fallbackStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: false, reason: 'not_routed' })
  })
})

describe('resolveAuxiliaryStrategyId — unknown kinds', () => {
  it('treats an unregistered kind as session-scoped', () => {
    // A kind added to a sender before this registry knows it is far more likely
    // to be session work than global work.
    const r = resolveAuxiliaryStrategyId({
      kind: 'some_future_kind' as never,
      sessionStrategyId: 'auto',
      strategies: STRATEGIES,
    })
    expect(r).toEqual({ ok: true, strategyId: 'auto' })
  })
})

describe('resolveAuxiliaryStrategyId — no silent bypass', () => {
  it('never returns a value the caller could read as "use the raw connection"', () => {
    // The shape of the result is the guarantee: `ok: false` carries only a
    // reason string. If a future edit adds a third outcome, this fails.
    const failures = [
      resolveAuxiliaryStrategyId({ kind: 'title', strategies: STRATEGIES }),
      resolveAuxiliaryStrategyId({ kind: 'memory', strategies: STRATEGIES }),
      resolveAuxiliaryStrategyId({ kind: 'title', sessionStrategyId: 'gone', strategies: STRATEGIES }),
    ]
    for (const r of failures) {
      expect(r.ok).toBe(false)
      expect(Object.keys(r).sort()).toEqual(['ok', 'reason'])
    }
  })

  it('an empty strategy list refuses every kind', () => {
    for (const kind of ['chat', 'title', 'memory', 'transfer_summary'] as const) {
      expect(resolveAuxiliaryStrategyId({ kind, sessionStrategyId: 'auto', strategies: [] }).ok).toBe(false)
    }
  })
})
