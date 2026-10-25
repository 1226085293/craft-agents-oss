/**
 * Tests for the composer's strategy label.
 *
 * The label is `策略组名 · 下一个请求将使用的模型`. The model half used to read
 * the gateway's `lastModels` — what it called *last* — which is history, not a
 * prediction, and named the upstream id rather than the public model users
 * pick. These pin the rule that replaced it, which must stay identical to
 * `resolveStrategyRoute` in server-core or the label lies about the next call.
 */

import { describe, expect, it } from 'bun:test'

import { nextStrategyModel } from '../StrategySelector'

describe('nextStrategyModel — mirrors resolveStrategyRoute', () => {
  it('keeps the session model when the group serves it', () => {
    // A group holding three models must not advertise its first one when the
    // session is already on another of them — that would name the wrong model.
    expect(nextStrategyModel(['m-a', 'm-b', 'm-c'], 'm-b')).toBe('m-b')
  })

  it('falls back to the group s first model when the session model is not served', () => {
    // resolveStrategyRoute: `models.includes(resolvedModel) ? resolvedModel : models[0]`.
    expect(nextStrategyModel(['m-a', 'm-b'], 'claude-x')).toBe('m-a')
    expect(nextStrategyModel(['m-a', 'm-b'], undefined)).toBe('m-a')
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
