/**
 * The type (preset) card's default-value rule.
 *
 * The prototype pre-filled all eight limit fields from a defaults table, which
 * imposed limits the user never chose — a fresh card silently carried 500 RPD
 * and 5,000,000 TPD. Only the timeouts and cooldowns are pre-filled now; the
 * quota limits render empty, where empty means "no limit".
 *
 * These tests pin that split, because it is one line of `TYPE_MANDATORY` away
 * from regressing and the failure is silent: the form still looks filled in.
 */

import { describe, expect, test } from 'bun:test'

import {
  applyTypeDrafts,
  draftFromConfig,
  MANDATORY_DEFAULTS,
  TYPE_MANDATORY,
  TYPE_META,
  type TypeDraft,
} from '../TypeCard'
import type { LlmConfigShape } from '../../types'
import { DEFAULT_PRESET_ID } from '../../types'

const CONFIG_FIELDS = TYPE_META.map(([f]) => f)

function emptyConfig(): LlmConfigShape {
  return { version: 1, presets: {}, providers: [], strategies: [], clientKeys: [] }
}

function configWithPreset(id: string, preset: Record<string, unknown>): LlmConfigShape {
  return { ...emptyConfig(), presets: { [id]: preset } as unknown as LlmConfigShape['presets'] }
}

/**
 * Pick a draft by name. Necessary because the built-in `default` row is seeded
 * into any config that lacks it, so index 0 is not always the preset a test
 * just created.
 */
function draftNamed(drafts: TypeDraft[], name: string): TypeDraft {
  const hit = drafts.find((d) => d.name === name)
  if (!hit) throw new Error(`no draft named ${name}; got ${drafts.map((d) => d.name).join(', ')}`)
  return hit
}

describe('draftFromConfig — unset fields', () => {
  test('mandatory fields get a value, quota limits stay unset', () => {
    const [draft] = draftFromConfig(configWithPreset('default', {}))
    for (const field of CONFIG_FIELDS) {
      if (TYPE_MANDATORY.has(field)) {
        expect(draft.limits[field]).toBe(MANDATORY_DEFAULTS[field])
      } else {
        expect(draft.limits[field]).toBeUndefined()
      }
    }
  })

  test('a value already in the config is never overridden by a default', () => {
    const draft = draftNamed(
      draftFromConfig(configWithPreset('custom', { rateLimitSeconds: 7, concurrency: 0 })),
      'custom',
    )
    expect(draft.limits.rateLimitSeconds).toBe(7)
    // 0 is a real value (no concurrency), not "unset".
    expect(draft.limits.concurrency).toBe(0)
  })

  test('a preset that sets a legacy quota migrates it into a custom row', () => {
    // tpm becomes a sliding token window; rpd becomes a fixed (UTC day) one.
    const draft = draftNamed(
      draftFromConfig(configWithPreset('p', { tpm: 1234, rpd: 500 })),
      'p',
    )
    // Legacy fields no longer live on `limits`; they are read into customLimits.
    expect(draft.limits.tpm).toBeUndefined()
    expect(draft.customLimits).toEqual([
      { amount: '1234', unit: 'tokens', per: '1', perUnit: 'minutes', sliding: true },
      { amount: '500', unit: 'requests', per: '24', perUnit: 'hours', sliding: false },
    ])
  })

  test('a null config yields no drafts', () => {
    expect(draftFromConfig(null)).toEqual([])
  })

  test('the built-in default row is seeded when the config lacks it', () => {
    // Every unset key already resolves to `default`, so the row must exist to
    // be editable — a config from before the built-in existed still gets one.
    expect(draftFromConfig(configWithPreset('custom', {})).map((d) => d.name)).toEqual([
      DEFAULT_PRESET_ID,
      'custom',
    ])
  })

  test('the built-in default row is not duplicated when present', () => {
    const drafts = draftFromConfig(configWithPreset(DEFAULT_PRESET_ID, { rpd: 5 }))
    expect(drafts.filter((d) => d.name === DEFAULT_PRESET_ID)).toHaveLength(1)
    // The legacy rpd migrates into a fixed 24-hour row instead of limits.rpd.
    expect(draftNamed(drafts, DEFAULT_PRESET_ID).customLimits).toEqual([
      { amount: '5', unit: 'requests', per: '24', perUnit: 'hours', sliding: false },
    ])
  })
})

describe('custom limits — add / persist', () => {
  test('a configured window survives a round trip', () => {
    const config = configWithPreset('p', {
      customLimits: [{ amount: 500, unit: 'requests', per: 5, perUnit: 'hours' }],
    })
    const next = applyTypeDrafts(config, draftFromConfig(config))
    expect(next.presets.p.customLimits).toEqual([
      { amount: 500, unit: 'requests', per: 5, perUnit: 'hours' },
    ])
  })

  test('a row added in the card is written once both numbers are filled', () => {
    const drafts: TypeDraft[] = [
      { name: 'p', limits: {}, customLimits: [{ unit: 'tokens', perUnit: 'hours', amount: '5M', per: '2', sliding: true }] },
    ]
    const next = applyTypeDrafts(emptyConfig(), drafts)
    // Sliding is the default, so it is omitted from the written config.
    expect(next.presets.p.customLimits).toEqual([
      { amount: 5_000_000, unit: 'tokens', per: 2, perUnit: 'hours' },
    ])
  })

  test('a fixed window writes sliding:false explicitly', () => {
    const drafts: TypeDraft[] = [
      { name: 'p', limits: {}, customLimits: [{ unit: 'requests', perUnit: 'hours', amount: '500', per: '24', sliding: false }] },
    ]
    const next = applyTypeDrafts(emptyConfig(), drafts)
    expect(next.presets.p.customLimits).toEqual([
      { amount: 500, unit: 'requests', per: 24, perUnit: 'hours', sliding: false },
    ])
  })

  test('a half-filled row stays a draft and is not persisted', () => {
    // The 添加限制 button appends a row with no numbers; writing it would save a
    // limit of zero, which the gateway reads as "allow nothing".
    const drafts: TypeDraft[] = [
      { name: 'p', limits: {}, customLimits: [{ unit: 'requests', perUnit: 'hours', amount: '100', per: '', sliding: true }] },
    ]
    const next = applyTypeDrafts(emptyConfig(), drafts)
    expect('customLimits' in (next.presets.p as unknown as object)).toBe(false)
  })

  test('clearing every row removes the field instead of writing an empty array', () => {
    const config = configWithPreset('p', {
      customLimits: [{ amount: 1, unit: 'requests', per: 1, perUnit: 'minutes' }],
    })
    const drafts = draftFromConfig(config).map((d) => ({ ...d, customLimits: [] }))
    const next = applyTypeDrafts(config, drafts)
    expect('customLimits' in (next.presets.p as unknown as object)).toBe(false)
  })
})

describe('applyTypeDrafts — writing back', () => {
  test('unset fields are dropped rather than written as undefined', () => {
    const drafts: TypeDraft[] = [
      { name: 'fresh', limits: { firstByteSeconds: 30, totalSeconds: undefined } },
    ]
    const next = applyTypeDrafts(emptyConfig(), drafts)
    const preset = next.presets.fresh as unknown as Record<string, unknown>
    expect(preset.firstByteSeconds).toBe(30)
    expect('totalSeconds' in preset).toBe(false)
  })

  test('a round trip preserves exactly what was configured', () => {
    const config = configWithPreset('p', {
      customLimits: [{ amount: 500, unit: 'requests', per: 24, perUnit: 'hours', sliding: false }],
      firstByteSeconds: 45,
    })
    const next = applyTypeDrafts(config, draftFromConfig(config))
    // The fixed window round-trips; sliding:false stays explicit.
    expect(next.presets.p).toMatchObject({ id: 'p', firstByteSeconds: 45 })
    expect(next.presets.p.customLimits).toEqual([
      { amount: 500, unit: 'requests', per: 24, perUnit: 'hours', sliding: false },
    ])
  })

  test('editing an unset box to a value writes it', () => {
    const drafts: TypeDraft[] = [{ name: 'p', limits: { firstByteSeconds: 30 } }]
    const next = applyTypeDrafts(emptyConfig(), drafts)
    expect((next.presets.p as unknown as Record<string, unknown>).firstByteSeconds).toBe(30)
  })

  test('a cleared box (empty string → undefined) removes the field', () => {
    const config = configWithPreset('p', { firstByteSeconds: 45 })
    const next = applyTypeDrafts(config, [{ name: 'p', limits: { firstByteSeconds: undefined } }])
    expect('firstByteSeconds' in (next.presets.p as unknown as object)).toBe(false)
  })

  test('a non-finite value is not written', () => {
    const next = applyTypeDrafts(emptyConfig(), [
      { name: 'p', limits: { firstByteSeconds: Number.NaN, totalSeconds: 600 } },
    ])
    const preset = next.presets.p as unknown as Record<string, unknown>
    expect('firstByteSeconds' in preset).toBe(false)
    expect(preset.totalSeconds).toBe(600)
  })
})
