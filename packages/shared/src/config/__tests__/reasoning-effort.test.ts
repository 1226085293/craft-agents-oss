/**
 * Thinking level → `reasoning_effort`.
 *
 * The incident (2026-10-29): the composer said 最大, the relay's usage log said
 * `reasoning_effort: high`. Two independent losses stacked:
 *
 * 1. pi-ai's `clampReasoning()` folds `xhigh`/`max` into `high`, so a
 *    budget-based request carries the same `budget_tokens: 16384` for both;
 * 2. `transcodeRequestToOpenAI()` dropped `thinking` entirely, so the OpenAI
 *    upstream got no effort at all and used its own default
 *    (`defaultEffort: high` for deepseek-v4.1-flash).
 *
 * Fix: gateway-routed endpoints ask the SDK for the adaptive shape (level as a
 * string in `output_config.effort`), and the gateway turns that into
 * `reasoning_effort`, clamped to what the model declares it accepts.
 */

import { describe, it, expect } from 'bun:test'

import {
  clampEffort,
  effortCandidates,
  isEffortRejection,
  levelForBudget,
  parseEffortsCatalog,
  requestedEffort,
  thinkingForEffort,
} from '../reasoning-effort.ts'
import { transcodeRequestToOpenAI } from '../llm-transcode-request.ts'

describe('requestedEffort', () => {
  it('reads the adaptive shape, which is the only one that keeps "max"', () => {
    expect(requestedEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } })).toBe('max')
  })

  it('falls back to the budget for budget-based clients', () => {
    // pi-ai's DEFAULT_THINKING_BUDGETS: minimal 1024, low 2048, medium 8192,
    // high 16384. `max` is indistinguishable from `high` here — that loss
    // happens inside the SDK and cannot be recovered.
    expect(requestedEffort({ thinking: { type: 'enabled', budget_tokens: 1024 } })).toBe('low')
    expect(requestedEffort({ thinking: { type: 'enabled', budget_tokens: 2048 } })).toBe('low')
    expect(requestedEffort({ thinking: { type: 'enabled', budget_tokens: 8192 } })).toBe('medium')
    expect(requestedEffort({ thinking: { type: 'enabled', budget_tokens: 16384 } })).toBe('high')
  })

  it('reports an explicit off as "none"', () => {
    expect(requestedEffort({ thinking: { type: 'disabled' } })).toBe('none')
  })

  it('says nothing when the request says nothing', () => {
    expect(requestedEffort({})).toBeUndefined()
    expect(requestedEffort({ thinking: { type: 'adaptive' } })).toBeUndefined()
  })
})

describe('levelForBudget', () => {
  it('maps the pi-ai budget ladder onto levels', () => {
    expect(levelForBudget(512)).toBe('low')
    expect(levelForBudget(2048)).toBe('low')
    expect(levelForBudget(4096)).toBe('medium')
    expect(levelForBudget(16384)).toBe('high')
  })
})

describe('clampEffort', () => {
  it('passes an accepted level through', () => {
    expect(clampEffort('max', ['low', 'high', 'max'])).toBe('max')
    expect(clampEffort('high', ['low', 'high', 'max'])).toBe('high')
  })

  it('clamps downward to the nearest declared level', () => {
    // A relay that tops out at high must not be sent "max".
    expect(clampEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('xhigh', ['low', 'high'])).toBe('high')
    expect(clampEffort('medium', ['low', 'high'])).toBe('low')
  })

  it('sends nothing when the model declares nothing', () => {
    // The declaration is the permission: guessing an effort a relay does not
    // know would turn a cosmetic mismatch into a 400.
    expect(clampEffort('max', undefined)).toBeUndefined()
    expect(clampEffort('max', [])).toBeUndefined()
    expect(clampEffort(undefined, ['max'])).toBeUndefined()
  })
})

describe('thinkingForEffort', () => {
  it('translates an effort back into a budget block for anthropic relays', () => {
    expect(thinkingForEffort('high')).toEqual({ type: 'enabled', budget_tokens: 16384 })
    expect(thinkingForEffort('max')).toEqual({ type: 'enabled', budget_tokens: 32768 })
    expect(thinkingForEffort('none')).toEqual({ type: 'disabled' })
    expect(thinkingForEffort(undefined)).toBeUndefined()
  })
})

describe('transcodeRequestToOpenAI — reasoning effort', () => {
  const body = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 16384 },
  } as never

  it('carries the effort to the upstream', () => {
    const out = transcodeRequestToOpenAI(body, { upstreamModel: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
    expect(out.reasoning_effort).toBe('max')
  })

  it('omits the field when no effort was resolved', () => {
    const out = transcodeRequestToOpenAI(body, { upstreamModel: 'deepseek-v4.1-flash' })
    expect('reasoning_effort' in out).toBe(false)
  })
})

describe('effortCandidates — step down instead of giving up', () => {
  it('starts at the requested level and walks down through the ladder', () => {
    // The ladder a relay advertises for deepseek-v4.1-flash, in order.
    expect(effortCandidates('max', ['low', 'high', 'max'])).toEqual(['max', 'high', 'low', undefined])
  })

  it('never starts above what the ladder has', () => {
    // 最大 on a model that tops out at medium is medium — not max, not nothing.
    expect(effortCandidates('max', ['low', 'medium'])[0]).toBe('medium')
  })

  it('keeps "no field at all" as the last resort', () => {
    expect(effortCandidates('high', ['high'])).toEqual(['high', undefined])
  })

  it('asks for nothing when the request asks for nothing', () => {
    expect(effortCandidates(undefined, ['low', 'high'])).toEqual([undefined])
  })

  it('honours a learned ceiling', () => {
    // A route that already rejected high+ starts at the level it accepted.
    expect(effortCandidates('max', ['low', 'high', 'max'], 'low')).toEqual(['low', undefined])
    expect(effortCandidates('max', ['low', 'high', 'max'], 'none')).toEqual([undefined])
  })
})

describe('parseEffortsCatalog', () => {
  it('reads the OpenAI `data` shape and normalises levels', () => {
    const out = parseEffortsCatalog({
      data: [
        { id: 'deepseek-v4-pro', reasoning_efforts: ['high', 'xhigh'] },
        { id: 'hy3', reasoning_efforts: ['Low', 'HIGH'] },
      ],
    })
    expect(out.get('deepseek-v4-pro')).toEqual(['high', 'xhigh'])
    expect(out.get('hy3')).toEqual(['low', 'high'])
  })

  it('accepts the camelCase field and the `models` wrapper', () => {
    const out = parseEffortsCatalog({
      models: [{ model: 'm1', reasoningEfforts: ['high', 'max'] }],
    })
    expect(out.get('m1')).toEqual(['high', 'max'])
  })

  it('drops models with no usable ladder', () => {
    const out = parseEffortsCatalog({
      data: [
        { id: 'no-efforts' },
        { id: 'empty', reasoning_efforts: [] },
        { id: 'bad', reasoning_efforts: ['', '  '] },
        { id: 'good', reasoning_efforts: ['high'] },
      ],
    })
    expect([...out.keys()]).toEqual(['good'])
  })

  it('returns an empty map for degenerate input', () => {
    expect(parseEffortsCatalog(undefined).size).toBe(0)
    expect(parseEffortsCatalog(null).size).toBe(0)
    expect(parseEffortsCatalog('not json').size).toBe(0)
  })
})

describe('isEffortRejection', () => {
  it('recognises the relay complaining about the level', () => {
    expect(isEffortRejection(400, 'unsupported reasoning_effort: max')).toBe(true)
    expect(isEffortRejection(422, 'thinking.budget_tokens is invalid')).toBe(true)
    expect(isEffortRejection(400, '{"error":{"message":"不支持的推理档位"}}')).toBe(true)
  })

  it('does not mistake an unrelated 400 — or another status — for it', () => {
    expect(isEffortRejection(400, 'messages: invalid role')).toBe(false)
    expect(isEffortRejection(404, 'reasoning_effort unknown')).toBe(false)
    expect(isEffortRejection(429, 'reasoning_effort')).toBe(false)
  })
})
