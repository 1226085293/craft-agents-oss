/**
 * Gateway-routed connections must carry each model's capabilities, not just its
 * name.
 *
 * The bug (2026-10-29, reported as "deepseek-v4.1-flash 我设置的是 1M，但是
 * 310k 就占据 60% 的上下文"): the group declared
 * `modelOptions["deepseek-v4.1-flash"].contextWindow = 1000000`, but the
 * rewrite replaced `connection.models` with the bare public names. The
 * subprocess then built the model definition without a window and fell back to
 * `config.json → defaultContextWindow` (512k) — so 310k rendered as 60%, and
 * forced compaction would have fired at half the real budget.
 */

import { describe, expect, it } from 'bun:test'

import { routedConnectionModels } from './SessionManager.ts'

const providers = [
  {
    id: 'wb',
    modelOptions: {
      hy3: { contextWindow: 960_000, supportsImages: true, supportsThinking: true },
      'deepseek-v4.1-flash': { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true },
    },
  },
]

const strategy = {
  members: [
    { provider: 'wb', model: 'deepseek-v4.1-flash' },
    { provider: 'wb', model: 'hy3' },
  ],
}

describe('routedConnectionModels', () => {
  it('carries the window the group declares for each public model', () => {
    const models = routedConnectionModels(
      ['deepseek-v4.1-flash', 'hy3'],
      strategy,
      providers,
      undefined,
    )
    expect(models).toEqual([
      { id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxTokens: 65_536, supportsImages: true },
      { id: 'hy3', contextWindow: 960_000, supportsImages: true },
    ])
  })

  it('keeps the declared order of the route', () => {
    const models = routedConnectionModels(['hy3', 'deepseek-v4.1-flash'], strategy, providers, undefined)
    expect(models.map((m) => (typeof m === 'string' ? m : m.id))).toEqual(['hy3', 'deepseek-v4.1-flash'])
  })

  it('falls back to the entry the connection already had', () => {
    // A direct connection being put behind the gateway: its own metadata is
    // better than nothing, and the group says nothing about this model.
    const models = routedConnectionModels(
      ['auto'],
      { members: [{ provider: 'wb', model: 'auto' }] },
      providers,
      [{ id: 'auto', contextWindow: 1_000_000 }],
    )
    expect(models).toEqual([{ id: 'auto', contextWindow: 1_000_000 }])
  })

  it('falls back to the bare id when nobody declared anything', () => {
    // The subprocess then applies `defaultContextWindow`, which is the honest
    // answer for an unknown model.
    expect(routedConnectionModels(['mystery'], strategy, providers, undefined)).toEqual(['mystery'])
    expect(routedConnectionModels(['mystery'], strategy, undefined, undefined)).toEqual(['mystery'])
  })

  it('prefers the member that serves the model over an unrelated provider', () => {
    const twoProviders = [
      { id: 'other', modelOptions: { shared: { contextWindow: 128_000 } } },
      { id: 'wb', modelOptions: { shared: { contextWindow: 1_000_000 } } },
    ]
    const models = routedConnectionModels(
      ['shared'],
      { members: [{ provider: 'wb', model: 'shared' }] },
      twoProviders,
      undefined,
    )
    expect(models).toEqual([{ id: 'shared', contextWindow: 1_000_000 }])
  })

  it('ignores a disabled provider when reading capabilities', () => {
    const models = routedConnectionModels(
      ['shared'],
      { members: [{ provider: 'wb', model: 'shared' }] },
      [{ id: 'wb', enabled: false, modelOptions: { shared: { contextWindow: 256_000 } } }],
      undefined,
    )
    expect(models).toEqual(['shared'])
  })
})
