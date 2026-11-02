/**
 * Tests for the composer's strategy label.
 *
 * The label is `策略组名 · 下一个请求将使用的模型`. The model half used to read
 * the gateway's `lastModels` — what it called *last* — which is history, not a
 * prediction, and named the upstream id rather than the public model. These pin
 * the rule that replaced it, which must stay identical to `pickStrategyModel`
 * in `@craft-agent/shared/config` (strategy availability) or the label lies
 * about the next call.
 *
 * The incident: 2026-10-29 (`261029-airy-orbit`). A finished title generation
 * on `hy3` set `lastModels`, so the chip said `hy3` while the conversation
 * request went to `hy4-preview` — the group's first model, chosen without
 * looking at the clock. Both halves are pinned here: predict from the session's
 * own model plus what is actually open, never from history.
 */

import { describe, expect, it } from 'bun:test'

import { nextStrategyModel } from '../StrategySelector'

describe('nextStrategyModel — mirrors the router', () => {
  it('keeps the session model when the group serves it', () => {
    // A group holding three models must not advertise its first one when the
    // session is already on another of them — that would name the wrong model.
    expect(nextStrategyModel(['m-a', 'm-b', 'm-c'], 'm-b')).toBe('m-b')
  })

  it('falls back to the group s first model when the session model is not served', () => {
    expect(nextStrategyModel(['m-a', 'm-b'], 'claude-x')).toBe('m-a')
    expect(nextStrategyModel(['m-a', 'm-b'], undefined)).toBe('m-a')
  })

  it('skips a model whose availability window is closed', () => {
    // hy4-preview is closed at 17:00; hy3 is open all day. The router skips the
    // closed one, so the label must too.
    expect(nextStrategyModel(['hy4-preview', 'hy3'], undefined, ['hy3'])).toBe('hy3')
  })

  it('ignores a session model that is outside its window right now', () => {
    // The session is pinned to hy4-preview from last night; at 17:00 the next
    // request will use hy3, so that is what the label says.
    expect(nextStrategyModel(['hy4-preview', 'hy3'], 'hy4-preview', ['hy3'])).toBe('hy3')
  })

  it('reports no model when every model is closed', () => {
    // Not a dash (that means "no configuration") and not a model name (that
    // means a request that is guaranteed to fail): the caller prints
    // 当前无可用模型.
    expect(nextStrategyModel(['hy4-preview', 'hy3'], undefined, [])).toBeNull()
    expect(nextStrategyModel(['hy4-preview', 'hy3'], 'hy3', [])).toBeNull()
  })

  it('treats an absent availability list as "no information", not "all closed"', () => {
    // Older main processes do not send `openModels`; the label must not go
    // blank on them.
    expect(nextStrategyModel(['m-a', 'm-b'], undefined, undefined)).toBe('m-a')
    expect(nextStrategyModel(['m-a', 'm-b'], 'm-b', undefined)).toBe('m-b')
  })

  it('single-model groups answer with that model', () => {
    expect(nextStrategyModel(['only'], 'other')).toBe('only')
  })

  it('a group with no models has no next model', () => {
    expect(nextStrategyModel([], 'm-b')).toBe('—')
    expect(nextStrategyModel(undefined, 'm-b')).toBe('—')
  })

  it('never invents a model for an empty name', () => {
    expect(nextStrategyModel([''], '')).toBe('')
    expect(nextStrategyModel(['m-a'], '')).toBe('m-a')
  })
})
