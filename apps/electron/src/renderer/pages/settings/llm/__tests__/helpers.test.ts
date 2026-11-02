/**
 * Tests for the pure helpers behind the gateway settings page.
 *
 * The bias here is toward the decisions that are easy to get silently wrong:
 * preset inheritance (a key with an unset `preset` resolves through its
 * provider), tone precedence (disabled beats cooling beats last-test), token
 * compaction at the boundaries, and the time-window port whose contract the
 * scheduler will need to match.
 */

import { describe, expect, it } from 'bun:test'

import {
  compactCount,
  compactTokens,
  coolingKeyIdsFor,
  formatRemaining,
  inWindow,
  isValidId,
  keyCounts,
  maskKeyHead,
  ms,
  normalizeName,
  parseTokenInput,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  modelOptionsDraft,
  applyModelOptionsDraft,
  mergeModelOptions,
  modelOptionsSummary,
  presetIds,
  presetOptionIds,
  presetUsage,
  reconcileStrategyRefs,
  resolvePresetId,
  providerIdFromName,
  pickedModels,
  strategyPicks,
  toStrategyModels,
  providerNameTaken,
  providerTone,
  selectKeyRows,
  strategiesForProvider,
  strategyMemberText,
  strategyModels,
  windowSummary,
} from '../helpers'
import type { GatewayStatus, LlmConfigShape } from '../types'

function baseConfig(): LlmConfigShape {
  return {
    version: 1,
    presets: {
      default: { id: 'default', concurrency: 1 },
      fast: { id: 'fast', concurrency: 60 },
    },
    providers: [
      {
        id: 'p1',
        name: 'Local Model',
        baseUrl: 'https://p1.example.com/v1/messages',
        protocol: 'anthropic-messages',
        enabled: true,
        defaultPreset: 'default',
        keys: [
          { id: 'k1', key: 'sk-aaaaaaaaaaaa', enabled: true },
          { id: 'k2', key: 'sk-bbbbbbbbbbbb', enabled: true, preset: 'fast' },
          { id: 'k3', key: 'sk-cccccccccccc', enabled: false },
        ],
      },
      {
        id: 'p2',
        name: 'agnes',
        baseUrl: 'https://p2.example.com/v1/messages',
        protocol: 'anthropic-messages',
        enabled: true,
        defaultPreset: 'fast',
        keys: [{ id: 'k4', key: 'sk-dddddddddddd', enabled: true }],
      },
    ],
    strategies: [
      { id: 'auto', type: 'round_robin', members: [{ provider: 'p1' }] },
      { id: 'preview', type: 'weighted', members: [{ provider: 'p1' }, { provider: 'p2' }] },
    ],
    clientKeys: [{ key: 'sk-client-1', strategies: ['auto'] }],
  }
}

describe('maskKeyHead', () => {
  it('keeps a recognisable head so two keys on one provider stay tellable apart', () => {
    // 8 head chars keeps `sk-abc123…` distinguishable from `sk-abc987…`.
    expect(maskKeyHead('sk-abcdefghijklmnop')).toBe('sk-abcde…mnop')
    // The split is the point: two keys that share a prefix stay tellable.
    expect(maskKeyHead('sk-abc123deadbeef')).not.toBe(maskKeyHead('sk-abc987deadbeef'))
  })

  it('does not leak the whole key when it is short', () => {
    expect(maskKeyHead('sk-abc123')).toBe('sk-abc…')
  })

  it('handles empty input without throwing', () => {
    expect(maskKeyHead('')).toBe('')
  })
})

describe('number formatting', () => {
  it('compacts tokens at each magnitude boundary', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(999)).toBe('999')
    expect(compactTokens(1000)).toBe('1.0k')
    expect(compactTokens(12_345)).toBe('12.3k')
    expect(compactTokens(2_500_000)).toBe('2.5M')
    expect(compactTokens(3_000_000_000)).toBe('3.0B')
  })

  it('compacts request counts without a unit letter', () => {
    expect(compactCount(999)).toBe('999')
    expect(compactCount(1500)).toBe('1.5k')
    expect(compactCount(2_000_000)).toBe('2.0M')
  })

  it('switches latency from ms to s only above a second', () => {
    expect(ms(120)).toBe('120ms')
    expect(ms(999)).toBe('999ms')
    expect(ms(1500)).toBe('1.5s')
    expect(ms(25_000)).toBe('25s')
  })

  it('renders null/NaN as a dash rather than NaN', () => {
    expect(ms(null)).toBe('—')
    expect(ms(Number.NaN)).toBe('—')
    expect(compactTokens(Number.NaN)).toBe('—')
  })

  it('formats a cooldown as minutes and seconds, dropping empty parts', () => {
    expect(formatRemaining(0)).toBe('即将恢复')
    expect(formatRemaining(-5)).toBe('即将恢复')
    expect(formatRemaining(30_000)).toBe('30 秒后恢复')
    expect(formatRemaining(60_000)).toBe('1 分后恢复')
    expect(formatRemaining(272_000)).toBe('4 分 32 秒后恢复')
  })
})

describe('providerTone', () => {
  const config = baseConfig()
  const provider = (id: string) => config.providers.find((p: { id: string }) => p.id === id) as LlmConfigShape['providers'][number]

  it('reports ok for an enabled provider with no signals', () => {
    expect(providerTone({ provider: provider('p2'), status: null })).toBe('ok')
  })

  it('reports disabled when the provider is off, even while it is cooling', () => {
    const status: GatewayStatus = {
      running: true,
      port: 8000,
      baseUrl: '',
      enabled: true,
      strategies: [],
      coolingKeys: 1,
      inFlight: 0,
      keyStates: [
        {
          provider: 'p1',
          keyId: 'k1',
          cooling: true,
          cooldownRemaining: 1000,
          inFlight: 0,
          available: false,
          weight: 1,
        },
      ],
    }
    const off = { ...provider('p1'), enabled: false }
    expect(providerTone({ provider: off, status })).toBe('disabled')
  })

  it('reports cooling only when a key on that provider is cooling', () => {
    const status: GatewayStatus = {
      running: true,
      port: 8000,
      baseUrl: '',
      enabled: true,
      strategies: [],
      coolingKeys: 1,
      inFlight: 0,
      keyStates: [
        {
          provider: 'p2',
          keyId: 'k4',
          cooling: true,
          cooldownRemaining: 1000,
          inFlight: 0,
          available: true,
          weight: 1,
        },
      ],
    }
    // p1 has no cooling key of its own even though p2 does.
    expect(providerTone({ provider: provider('p1'), status })).toBe('ok')
    expect(providerTone({ provider: provider('p2'), status })).toBe('cool')
  })

  it('reports down when the last explicit test failed', () => {
    const failed = { ...provider('p2'), lastTestOk: false }
    expect(providerTone({ provider: failed, status: null })).toBe('down')
  })
})

describe('keyCounts', () => {
  const config = baseConfig()
  const p1 = config.providers[0]

  it('splits keys into available / cooling / disabled', () => {
    expect(keyCounts(p1, new Set())).toEqual({ avail: 2, cool: 0, dis: 1 })
  })

  it('counts an enabled-but-cooling key as cooling, not available', () => {
    expect(keyCounts(p1, new Set(['k1']))).toEqual({ avail: 1, cool: 1, dis: 1 })
  })

  it('keeps disabled keys out of cooling even if the push disagrees', () => {
    // A disabled key is never scheduled, so it must not be presented as
    // "resting" — that would suggest it is about to come back.
    expect(keyCounts(p1, new Set(['k3']))).toEqual({ avail: 2, cool: 0, dis: 1 })
  })
})

describe('coolingKeyIdsFor', () => {
  it('scopes key ids to one provider', () => {
    const status: GatewayStatus = {
      running: true,
      port: 8000,
      baseUrl: '',
      enabled: true,
      strategies: [],
      coolingKeys: 2,
      inFlight: 0,
      keyStates: [
        {
          provider: 'p1',
          keyId: 'k1',
          cooling: true,
          cooldownRemaining: 1,
          inFlight: 0,
          available: false,
          weight: 1,
        },
        {
          provider: 'p2',
          keyId: 'k4',
          cooling: true,
          cooldownRemaining: 1,
          inFlight: 0,
          available: true,
          weight: 1,
        },
      ],
    }
    expect([...coolingKeyIdsFor('p1', status)]).toEqual(['k1'])
    expect([...coolingKeyIdsFor('p2', status)]).toEqual(['k4'])
    expect([...coolingKeyIdsFor('p3', status)]).toEqual([])
  })

  it('returns an empty set without a status push', () => {
    expect([...coolingKeyIdsFor('p1', null)]).toEqual([])
  })
})

describe('selectKeyRows', () => {
  // Three keys on one provider whose default type is `default`:
  //   a — blank preset, inherits `default`
  //   b — explicit `default`
  //   c — explicit `fast`
  const rows = [
    { id: 'a', key: 'sk-aaa', note: '主', type: '', enabled: true, cool: false },
    { id: 'b', key: 'sk-bbb', note: '', type: 'default', enabled: true, cool: false },
    { id: 'c', key: 'sk-ccc', note: '', type: 'fast', enabled: false, cool: false },
  ]
  const base = { query: '', excludeDisabled: false, excludeCooling: false, type: 'all', inherit: 'default' }
  const ids = (f = base, sort: 'created-desc' | 'type' = 'created-desc'): string[] =>
    selectKeyRows(rows, f, sort).map((r) => r.id)

  it('shows every key when no type is selected', () => {
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('a key that inherits the default belongs under that type', () => {
    // The bug: filtering compared the stored preset, so `a` (blank) never
    // matched `default` and the list looked like the key had been deleted.
    expect(ids({ ...base, type: 'default' })).toEqual(['a', 'b'])
  })

  it('an explicit type excludes the inheriting keys when the default differs', () => {
    // Provider default is `fast` here, so `a` resolves to `fast`, not `default`.
    expect(ids({ ...base, inherit: 'fast', type: 'fast' })).toEqual(['a', 'c'])
  })

  it('sorts by the same effective type it filters on', () => {
    // Both `a` and `b` are `default`; `c` sorts after them.
    expect(ids(base, 'type')).toEqual(['a', 'b', 'c'])
    // With a `fast` default, `a` joins `c` on the right of the group.
    expect(ids({ ...base, inherit: 'fast' }, 'type')).toEqual(['b', 'a', 'c'])
  })

  it('the other filters still apply', () => {
    expect(ids({ ...base, excludeDisabled: true })).toEqual(['a', 'b'])
    expect(ids({ ...base, query: 'sk-cc' })).toEqual(['c'])
  })

  it('an unknown type id matches nothing rather than everything', () => {
    expect(ids({ ...base, type: 'gone' })).toEqual([])
  })
})

describe('strategyModels', () => {
  const providers = [
    { id: 'A', name: 'agnes-cn', modelList: ['gpt-4', 'hy3'] },
    { id: 'B', name: 'apihub', modelList: ['gpt-4', 'glm-5'] },
    { id: 'C', name: 'other', modelList: ['o1'] },
  ]

  it('offers nothing until a member is selected', () => {
    // The regression: the pool spanned every provider, so a model nobody in the
    // group serves could be picked — the preview then warned about it.
    expect(strategyModels(providers, [])).toEqual([])
  })

  it('never merges the same model from two providers', () => {
    // The core rule: gpt-4 on A and on B are two units. Deduping them made
    // turning one off drop both, and neither could say which upstream it hit.
    const opts = strategyModels(providers, ['A', 'B'])
    expect(opts.map((e) => `${e.model}·${e.providerName}`)).toEqual([
      'gpt-4·agnes-cn',
      'hy3·agnes-cn',
      'gpt-4·apihub',
      'glm-5·apihub',
    ])
    expect(opts.filter((e) => e.model === 'gpt-4')).toHaveLength(2)
    // The model name is the prominent half; the provider rides along separately
    // so the pill can render it muted (模型名 · 提供商).
    expect(opts.every((e) => !e.model.includes(':'))).toBe(true)
  })

  it('every entry is uniquely identified by provider + model', () => {
    const opts = strategyModels(providers, ['A', 'B'])
    const keys = opts.map((e) => `${e.providerId}|${e.model}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only lists models of the selected members', () => {
    expect(strategyModels(providers, ['C']).map((e) => e.model)).toEqual(['o1'])
  })
})

describe('toStrategyModels / strategyPicks', () => {
  it('groups picks into one public model with its providers pinned', () => {
    expect(toStrategyModels([
      { provider: 'A', model: 'gpt-4' },
      { provider: 'B', model: 'gpt-4' },
      { provider: 'A', model: 'hy3' },
    ])).toEqual({
      models: ['gpt-4', 'hy3'],
      modelProviders: { 'gpt-4': ['A', 'B'], hy3: ['A'] },
    })
  })

  it('writes the pin even for a single provider', () => {
    // Explicit beats implicit: the saved intent must not depend on what the
    // member list happens to be later.
    expect(toStrategyModels([{ provider: 'B', model: 'gpt-4' }])).toEqual({
      models: ['gpt-4'],
      modelProviders: { 'gpt-4': ['B'] },
    })
  })

  it('expands a pinned strategy back to exactly its picks', () => {
    const picks = strategyPicks(['gpt-4'], { 'gpt-4': ['B'] }, ['A', 'B'], [
      { id: 'A', modelList: ['gpt-4'] },
      { id: 'B', modelList: ['gpt-4'] },
    ])
    expect(picks).toEqual([{ provider: 'B', model: 'gpt-4' }])
  })

  it('a strategy written before modelProviders means every member', () => {
    const providers = [
      { id: 'A', modelList: ['gpt-4'] },
      { id: 'B', modelList: ['gpt-4'] },
    ]
    expect(strategyPicks(['gpt-4'], undefined, ['A', 'B'], providers)).toEqual([
      { provider: 'A', model: 'gpt-4' },
      { provider: 'B', model: 'gpt-4' },
    ])
  })

  it('keeps a model visible even when no member still advertises it', () => {
    // Otherwise the row could not be removed from the editor at all.
    expect(strategyPicks(['gone'], undefined, ['A'], [{ id: 'A', modelList: [] }])).toEqual([
      { provider: 'A', model: 'gone' },
    ])
  })

  it('pickedModels de-duplicates names but keeps first-seen order', () => {
    expect(pickedModels([
      { provider: 'A', model: 'gpt-4' },
      { provider: 'B', model: 'hy3' },
      { provider: 'B', model: 'gpt-4' },
    ])).toEqual(['gpt-4', 'hy3'])
  })
})

describe('presetUsage', () => {
  const config = baseConfig()

  it('counts a key with an unset preset as its provider default', () => {
    // k1 inherits p1's `default`; the disabled k3 still cites `default` too, and
    // a reference count should include it — otherwise deleting the preset would
    // report "0 keys affected" while a disabled key is silently repointed.
    expect(presetUsage('default', config)).toEqual({ providers: 1, keys: 2 })
  })

  it('counts an explicit key preset separately from the provider default', () => {
    // k2 → `fast` explicitly, plus p2's single key inherits p2's `fast` default.
    expect(presetUsage('fast', config)).toEqual({ providers: 1, keys: 2 })
  })

  it('returns zeros for an unknown preset', () => {
    expect(presetUsage('nope', config)).toEqual({ providers: 0, keys: 0 })
  })

  it('counts a key whose own type was deleted under the provider default', () => {
    const withDangling = baseConfig()
    withDangling.providers[0].keys[1].preset = 'deleted'
    // k2 no longer runs `fast`; it falls through to p1's `default`.
    expect(presetUsage('default', withDangling).keys).toBe(3)
    expect(presetUsage('fast', withDangling).keys).toBe(1)
  })

  it('returns zeros for an empty preset id', () => {
    // The unnamed card in the type editor used to claim every key whose preset
    // and provider default were both unset: resolving that chain yields '' too,
    // so an empty id has nothing to attribute.
    const withUnset = {
      ...config,
      providers: [{ ...config.providers[0], defaultPreset: '', keys: [] }],
    } as typeof config
    expect(presetUsage('', withUnset)).toEqual({ providers: 0, keys: 0 })
    expect(presetUsage('', config)).toEqual({ providers: 0, keys: 0 })
  })

  it('returns zeros without a config', () => {
    expect(presetUsage('default', null)).toEqual({ providers: 0, keys: 0 })
  })
})

describe('reconcileStrategyRefs', () => {
  it('attaches the first strategy to a key whose references are all gone', () => {
    // The reported bug: a fresh config references `auto`, the first group the
    // user creates is named something else, and saving used to fail with
    // `clientKeys[0] 引用了不存在的 strategy: auto`.
    const config = baseConfig()
    config.strategies = [{ id: 'my-group', type: 'round_robin', members: [{ provider: 'p1' }] }]
    config.clientKeys = [{ key: 'sk-client-1', strategies: ['auto'] }]
    expect(reconcileStrategyRefs(config).clientKeys).toEqual([
      { key: 'sk-client-1', strategies: ['my-group'] },
    ])
  })

  it('drops refs to deleted strategies, keeps valid ones, and de-duplicates', () => {
    const config = baseConfig()
    config.clientKeys = [{ key: 'sk-client-1', strategies: ['ghost', 'preview', 'preview'] }]
    expect(reconcileStrategyRefs(config).clientKeys).toEqual([
      { key: 'sk-client-1', strategies: ['preview'] },
    ])
  })

  it('attaches a strategy to a key that has an empty list', () => {
    const config = baseConfig()
    config.clientKeys = [{ key: 'sk-client-1', strategies: [] }]
    expect(reconcileStrategyRefs(config).clientKeys[0].strategies).toEqual(['auto'])
  })

  it('leaves the list empty when there is no strategy to attach', () => {
    const config = baseConfig()
    config.strategies = []
    config.clientKeys = [{ key: 'sk-client-1', strategies: ['auto'] }]
    expect(reconcileStrategyRefs(config).clientKeys[0].strategies).toEqual([])
  })

  it('clears a miniStrategy that names a deleted group and keeps a valid one', () => {
    const config = baseConfig()
    config.miniStrategy = 'gone'
    expect(reconcileStrategyRefs(config).miniStrategy).toBeUndefined()
    config.miniStrategy = 'preview'
    expect(reconcileStrategyRefs(config).miniStrategy).toBe('preview')
  })

  it('clears a defaultStrategy that names a deleted group and keeps a valid one', () => {
    // New sessions inherit this, so a dangling id would both mis-route them and
    // make the validator reject every subsequent save.
    const config = baseConfig()
    config.defaultStrategy = 'gone'
    expect(reconcileStrategyRefs(config).defaultStrategy).toBeUndefined()
    config.defaultStrategy = 'preview'
    expect(reconcileStrategyRefs(config).defaultStrategy).toBe('preview')
  })
})

describe('resolvePresetId', () => {
  it("uses the key's own type when it exists", () => {
    expect(resolvePresetId(baseConfig(), 'fast', 'default')).toBe('default')
  })

  it('treats an empty key type as inherit and uses the provider default', () => {
    // `preset: ''` is what the settings page writes for 继承默认; it used to
    // short-circuit the provider and run the built-in default instead.
    expect(resolvePresetId(baseConfig(), 'fast', '')).toBe('fast')
  })

  it('falls through a deleted key type to the provider default', () => {
    expect(resolvePresetId(baseConfig(), 'fast', 'deleted')).toBe('fast')
  })

  it('falls through a deleted provider default to the built-in default', () => {
    expect(resolvePresetId(baseConfig(), 'deleted')).toBe('default')
  })

  it('falls back to the built-in default when nothing is set', () => {
    expect(resolvePresetId(baseConfig(), '')).toBe('default')
    expect(resolvePresetId(null)).toBe('default')
  })
})

describe('presetIds', () => {
  it('lists only presets that exist, ignoring dangling references', () => {
    // A key pointing at a deleted type must not conjure a pickable option: the
    // resolver skips it, so offering it would select a type that cannot apply.
    const config = baseConfig()
    config.providers[0].keys[2].preset = 'ghost'
    expect(presetIds(config)).toEqual(['default', 'fast'])
  })

  it('does not duplicate a preset that is both defined and referenced', () => {
    expect(presetIds(baseConfig())).toEqual(['default', 'fast'])
  })

  it('handles a missing config', () => {
    expect(presetIds(null)).toEqual([])
  })
})

describe('presetOptionIds', () => {
  it('always offers the built-in default, even when no preset is stored', () => {
    // A fresh llm-config.json: no presets row, nothing referencing one either.
    const config = baseConfig()
    config.presets = {}
    config.providers = config.providers.map((p) => ({
      ...p,
      defaultPreset: '',
      keys: p.keys.map((k) => ({ ...k, preset: '' })),
    }))
    expect(presetOptionIds(config)).toEqual(['default'])
  })

  it('keeps the configured order and does not duplicate the default', () => {
    expect(presetOptionIds(baseConfig())).toEqual(['default', 'fast'])
  })

  it('handles a missing config', () => {
    expect(presetOptionIds(null)).toEqual([])
  })
})

describe('strategiesForProvider', () => {
  it('lists every strategy a provider belongs to', () => {
    expect(strategiesForProvider('p1', baseConfig())).toEqual(['auto', 'preview'])
    expect(strategiesForProvider('p2', baseConfig())).toEqual(['preview'])
    expect(strategiesForProvider('missing', baseConfig())).toEqual([])
  })
})

describe('strategyMemberText', () => {
  const config = baseConfig()

  it('shows weights only for weighted strategies', () => {
    const weighted = config.strategies[1]
    weighted.members = [
      { provider: 'p1', weight: 3 },
      { provider: 'p2', weight: 1 },
    ]
    expect(strategyMemberText(weighted, config)).toBe('Local Model ×3、agnes ×1')
    expect(strategyMemberText(config.strategies[0], config)).toBe('Local Model')
  })

  it('falls back to the id when the provider is gone', () => {
    const orphaned = { id: 'x', type: 'round_robin' as const, members: [{ provider: 'gone' }] }
    expect(strategyMemberText(orphaned, config)).toBe('gone')
  })
})

describe('isValidId', () => {
  it('accepts lowercase alnum with - and _', () => {
    expect(isValidId('daily')).toBe(true)
    expect(isValidId('preview-2')).toBe(true)
    expect(isValidId('a_b')).toBe(true)
  })

  it('rejects anything that is not a safe identifier', () => {
    expect(isValidId('Daily')).toBe(false)
    expect(isValidId('-lead')).toBe(false)
    expect(isValidId('_lead')).toBe(false)
    expect(isValidId('has space')).toBe(false)
    expect(isValidId('')).toBe(false)
  })
})

// A provider id is generated from the display name when the user leaves the ID
// field empty. The generated value must satisfy isValidId, or creation is
// rejected with "请填写 ID" even though the name was filled in — that is how a
// name like "测试 提供商" used to behave.
describe('normalizeName', () => {
  it('slugifies a display name into a valid id', () => {
    expect(normalizeName('My Cool 提供商')).toBe('my-cool')
    expect(normalizeName('agnes-cn')).toBe('agnes-cn')
    expect(normalizeName('  Padded Name  ')).toBe('padded-name')
  })

  it('always yields something isValidId accepts', () => {
    for (const name of ['测试', '提供商 A', 'ünïcødé', '  ', '!!!', '中'])
      expect(isValidId(normalizeName(name))).toBe(true)
  })

  it('never emits a leading or trailing separator', () => {
    expect(normalizeName('-x-')).toBe('x')
    // `_` is a legal id character, so it is kept rather than folded to `-`.
    expect(normalizeName('__a__')).toBe('__a__')
  })
})

describe('inWindow', () => {
  // 2026-10-19 is a Monday.
  const monday = new Date('2026-10-19T00:00:00Z')

  it('is always true without a window', () => {
    expect(inWindow(monday, undefined)).toBe(true)
  })

  it('is true for an empty span list (all day)', () => {
    expect(inWindow(monday, { tz: 'UTC', spans: [] })).toBe(true)
  })

  it('honours a plain daily span', () => {
    expect(inWindow(new Date('2026-10-19T02:00:00Z'), { tz: 'UTC', spans: [{ start: '00:00', end: '08:00' }] })).toBe(true)
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), { tz: 'UTC', spans: [{ start: '00:00', end: '08:00' }] })).toBe(false)
  })

  it('treats the end as exclusive', () => {
    expect(inWindow(new Date('2026-10-19T08:00:00Z'), { tz: 'UTC', spans: [{ start: '00:00', end: '08:00' }] })).toBe(false)
  })

  it('treats start > end as a cross-midnight span', () => {
    const win = { tz: 'UTC', spans: [{ start: '22:00', end: '06:00' }] }
    // 23:00Z is inside [22:00, 24:00).
    expect(inWindow(new Date('2026-10-19T23:00:00Z'), win)).toBe(true)
    // 03:00Z is inside [00:00, 06:00).
    expect(inWindow(new Date('2026-10-19T03:00:00Z'), win)).toBe(true)
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), win)).toBe(false)
  })

  it('unions multiple spans with OR', () => {
    const win = {
      tz: 'UTC',
      spans: [
        { start: '00:00', end: '08:00' },
        { start: '20:00', end: '23:00' },
      ],
    }
    expect(inWindow(new Date('2026-10-19T02:00:00Z'), win)).toBe(true)
    expect(inWindow(new Date('2026-10-19T21:00:00Z'), win)).toBe(true)
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), win)).toBe(false)
  })

  it('filters by ISO weekday (1 = Monday)', () => {
    const win = { tz: 'UTC', days: [1], spans: [{ start: '00:00', end: '23:59' }] }
    const tuesday = new Date('2026-10-20T12:00:00Z')
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), win)).toBe(true)
    expect(inWindow(tuesday, win)).toBe(false)
  })

  it('respects an effective range', () => {
    const win = {
      tz: 'UTC',
      from: '2026-10-18 00:00',
      to: '2026-10-25 23:59',
      spans: [{ start: '00:00', end: '23:59' }],
    }
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), win)).toBe(true)
    expect(inWindow(new Date('2026-10-26T12:00:00Z'), win)).toBe(false)
    expect(inWindow(new Date('2026-10-17T12:00:00Z'), win)).toBe(false)
  })

  it('reads the wall clock in the window timezone, not the host one', () => {
    // 2026-10-19T18:00:00Z is 2026-10-20 02:00 in Asia/Shanghai (+08:00).
    const win = { tz: 'Asia/Shanghai', days: [2], spans: [{ start: '00:00', end: '04:00' }] }
    expect(inWindow(new Date('2026-10-19T18:00:00Z'), win)).toBe(true)
    expect(inWindow(new Date('2026-10-19T10:00:00Z'), win)).toBe(false)
  })

  it('falls back to host time for an unknown timezone instead of never matching', () => {
    const win = { tz: 'Not/AZone', spans: [{ start: '00:00', end: '23:59' }] }
    expect(inWindow(new Date('2026-10-19T12:00:00Z'), win)).toBe(true)
  })
})

describe('windowSummary', () => {
  it('summarises spans, timezone and range', () => {
    expect(
      windowSummary({
        tz: 'Asia/Shanghai',
        spans: [
          { start: '00:00', end: '08:00' },
          { start: '20:00', end: '23:00' },
        ],
      }),
    ).toBe('00:00–08:00、20:00–23:00 · Asia/Shanghai')
  })

  it('says all day when spans are empty', () => {
    expect(windowSummary({ tz: 'UTC' })).toBe('全天 · UTC')
  })

  it('a date-only window reads all day plus the range', () => {
    // Now the default shape: 每日时段 starts at zero, so a 「限时免费到某天」
    // window is just a date bound.
    expect(windowSummary({ tz: 'Asia/Shanghai', to: '2026-10-31 23:59' })).toBe(
      '全天 · Asia/Shanghai · 立即 → 2026-10-31',
    )
  })

  it('includes a bounded range', () => {
    expect(
      windowSummary({
        tz: 'UTC',
        from: '2026-10-18 00:00',
        to: '2026-10-25 23:59',
      }),
    ).toContain('2026-10-18 → 2026-10-25')
  })

  it('names the surviving weekdays when the window excludes some', () => {
    // The dialog shows the window as a read-only line, so a Monday-only
    // window must not read as 全天 there.
    expect(windowSummary({ tz: 'UTC', days: [1, 3, 5] })).toBe('全天 · UTC · 仅 周一、三、五')
  })

  it('stays silent when every weekday is selected', () => {
    expect(windowSummary({ tz: 'UTC', days: [1, 2, 3, 4, 5, 6, 7] })).toBe('全天 · UTC')
  })

  it('is empty without a window', () => {
    expect(windowSummary(undefined)).toBe('')
  })
})

describe('providerIdFromName', () => {
  it('slugifies the name when the id is free', () => {
    expect(providerIdFromName('Agnes CN', [])).toBe('agnes-cn')
    expect(providerIdFromName('WorkBuddyCN', [])).toBe('workbuddycn')
  })

  it('suffixes when the slug is taken', () => {
    // Different names, same slug: the spaces collapse either way. (Note `_` is
    // kept, so `agnes_cn` is a *different* slug from `agnes-cn`.)
    expect(providerIdFromName('Agnes CN', ['agnes-cn'])).toBe('agnes-cn-2')
    expect(providerIdFromName('Agnes  CN', ['agnes-cn', 'agnes-cn-2'])).toBe('agnes-cn-3')
  })

  it('never blocks on naming alone — a pure non-ASCII name collapses to provider', () => {
    // Without the suffix the second Chinese-named provider would collide and
    // creation would fail for a reason the user cannot see (the id is hidden).
    expect(providerIdFromName('中转站', [])).toBe('provider')
    expect(providerIdFromName('另一个中转站', ['provider'])).toBe('provider-2')
    // An ASCII letter inside an otherwise Chinese name survives, so these two
    // do not collide in the first place.
    expect(providerIdFromName('中转站A', [])).toBe('a')
  })

  it('always yields something isValidId accepts', () => {
    for (const name of ['Agnes CN', '中文名称', '  Padded  ', 'a.b/c']) {
      expect(isValidId(providerIdFromName(name, []))).toBe(true)
    }
  })
})

describe('providerNameTaken', () => {
  const providers = [
    { id: 'agnes-cn', name: 'Agnes CN' },
    { id: 'provider', name: '中转站A' },
  ]

  it('matches the name case- and whitespace-insensitively', () => {
    expect(providerNameTaken(providers, 'agnes cn')).toBe(true)
    expect(providerNameTaken(providers, '  Agnes CN  ')).toBe(true)
    expect(providerNameTaken(providers, '中转站A')).toBe(true)
  })

  it('lets a rename keep its own name', () => {
    expect(providerNameTaken(providers, 'Agnes CN', 'agnes-cn')).toBe(false)
    expect(providerNameTaken(providers, 'Agnes CN', 'provider')).toBe(true)
  })

  it('ignores a blank name and the unnamed case', () => {
    // Blank is rejected earlier as "请填写名称"; reporting a duplicate there
    // would be a misleading second error.
    expect(providerNameTaken(providers, '   ')).toBe(false)
    expect(providerNameTaken(providers, '全新的名字')).toBe(false)
  })
})

describe('parseTokenInput', () => {
  it('reads a bare integer, grouped digits, and a k/M suffix alike', () => {
    // The three spellings a user reaches for after reading a model card. All
    // must land on the same number or the saved config drifts from the label.
    expect(parseTokenInput('1000000')).toBe(1_000_000)
    expect(parseTokenInput('1,000,000')).toBe(1_000_000)
    expect(parseTokenInput('1M')).toBe(1_000_000)
    expect(parseTokenInput('1m')).toBe(1_000_000)
    expect(parseTokenInput('256k')).toBe(256_000)
    expect(parseTokenInput('64K')).toBe(64_000)
    expect(parseTokenInput('1.5M')).toBe(1_500_000)
    expect(parseTokenInput(' 65,536 ')).toBe(65_536)
  })

  it('returns null for blank and for anything unparseable', () => {
    // Blank is "unset" and handled by the caller; garbage must be refused
    // rather than coerced to NaN, which would poison every reader.
    expect(parseTokenInput('')).toBeNull()
    expect(parseTokenInput('   ')).toBeNull()
    expect(parseTokenInput('1M tokens')).toBeNull()
    expect(parseTokenInput('abc')).toBeNull()
    expect(parseTokenInput('-5')).toBeNull()
    expect(parseTokenInput('1e6')).toBeNull()
  })
})

describe('modelOptionsDraft', () => {
  it('seeds numbers as text and defaults unknown capability flags on', () => {
    const draft = modelOptionsDraft({ contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true })
    expect(draft).toEqual({
      contextWindow: '1000000',
      maxOutputTokens: '65536',
      supportsImages: true,
      supportsThinking: true,
    })
  })

  it('seeds the default context when none is declared', () => {
    // The dialog shows the value a reader will effectively see — an empty
    // field would hide that the model still gets a budget.
    expect(modelOptionsDraft(undefined)).toEqual({
      contextWindow: '512000',
      maxOutputTokens: '',
      supportsImages: true,
      supportsThinking: true,
    })
  })

  it('honours an explicit false instead of defaulting it on', () => {
    expect(modelOptionsDraft({ supportsImages: false, supportsThinking: false })).toMatchObject({
      supportsImages: false,
      supportsThinking: false,
    })
  })

  it('defaults to a context that reads back as 512k', () => {
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(512_000)
    expect(compactTokens(DEFAULT_MODEL_CONTEXT_WINDOW)).toBe('512.0k')
  })
})

describe('mergeModelOptions', () => {
  it('keeps fields the capability form does not edit', () => {
    // The exact regression: a model declared its effort ladder, the dialog was
    // opened to change the context window, and saving replaced the record —
    // so 最大 silently became the upstream default (2026-10-30).
    const merged = mergeModelOptions(
      { contextWindow: 1_000_000, reasoningEfforts: ['low', 'high', 'max'] },
      { contextWindow: 2_000_000, supportsImages: true, supportsThinking: true },
    )
    expect(merged.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(merged.contextWindow).toBe(2_000_000)
  })

  it('lets the form override what it does edit', () => {
    const merged = mergeModelOptions(
      { supportsImages: true, supportsThinking: true },
      { supportsThinking: false },
    )
    expect(merged.supportsImages).toBe(true)
    expect(merged.supportsThinking).toBe(false)
  })

  it('works with nothing stored yet', () => {
    expect(mergeModelOptions(undefined, { supportsThinking: true })).toEqual({ supportsThinking: true })
  })
})

describe('applyModelOptionsDraft', () => {
  it('keeps declared values and drops empty numeric fields', () => {
    const result = applyModelOptionsDraft({
      contextWindow: '1M',
      maxOutputTokens: '',
      supportsImages: true,
      supportsThinking: false,
    })
    expect(result).toEqual({ ok: true, options: { contextWindow: 1_000_000, supportsImages: true, supportsThinking: false } })
  })

  it('always writes both capability flags so an off switch persists', () => {
    // The form defaults the flags on, so an off switch must be stored as an
    // explicit `false` — dropping it would flip back to on next open.
    const result = applyModelOptionsDraft({
      contextWindow: '',
      maxOutputTokens: '',
      supportsImages: false,
      supportsThinking: false,
    })
    expect(result).toEqual({ ok: true, options: { supportsImages: false, supportsThinking: false } })
  })

  it('writes a flag that was turned on even when the token fields are blank', () => {
    const result = applyModelOptionsDraft({
      contextWindow: '',
      maxOutputTokens: '',
      supportsImages: false,
      supportsThinking: true,
    })
    expect(result).toEqual({ ok: true, options: { supportsImages: false, supportsThinking: true } })
  })

  it('refuses unparseable token text with a message naming both spellings', () => {
    for (const bad of ['1M tokens', 'abc', '1e6', '-1']) {
      const result = applyModelOptionsDraft({
        contextWindow: bad,
        maxOutputTokens: '',
        supportsImages: false,
        supportsThinking: false,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('上下文')
    }
  })

  it('refuses a bad max-output independently of a good context', () => {
    const result = applyModelOptionsDraft({
      contextWindow: '1M',
      maxOutputTokens: 'lots',
      supportsImages: false,
      supportsThinking: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('最大输出')
  })
})

describe('modelOptionsSummary', () => {
  it('renders every declared field with compact units', () => {
    expect(
      modelOptionsSummary({ contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true, supportsThinking: true }),
    ).toBe('上下文 1.0M · 最大 65.5k · 图像 · 推理')
  })

  it('omits undeclared fields and stays empty for an absent block', () => {
    expect(modelOptionsSummary({ contextWindow: 256_000 })).toBe('上下文 256.0k')
    expect(modelOptionsSummary({ supportsImages: true })).toBe('图像')
    expect(modelOptionsSummary(undefined)).toBe('')
    expect(modelOptionsSummary({})).toBe('')
  })
})
