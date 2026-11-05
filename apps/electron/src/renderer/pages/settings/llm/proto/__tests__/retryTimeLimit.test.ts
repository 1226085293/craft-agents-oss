import { describe, expect, it } from 'bun:test'

import { DEFAULT_FIRST_BYTE_SECONDS, retryTimeLimitWarning, slowestFirstByte } from '../retryTimeLimit'
import type { LlmPresetShape } from '../../types'
import type { ProtoProvider } from '../viewmodel'

function provider(over: Partial<ProtoProvider> & { id: string }): ProtoProvider {
  return {
    name: over.id,
    note: '',
    url: '',
    protocol: 'openai-completions',
    state: 'ok',
    lastTest: '',
    lastTestOk: true,
    lastError: '',
    defaultType: 'default',
    quota: 0,
    windows: {},
    modelOptions: {},
    modelList: [],
    keys: { avail: 1, cool: 0, unavailable: 0, dis: 0 },
    keyRows: [],
    ...over,
  }
}

function key(id: string, type: string, enabled = true): ProtoProvider['keyRows'][number] {
  return {
    provider: 'p',
    key: `sk-${id}`,
    id,
    note: '',
    type,
    enabled,
    cool: false,
    available: enabled,
  }
}

function presets(map: Record<string, number>): Record<string, LlmPresetShape> {
  return Object.fromEntries(
    Object.entries(map).map(([id, firstByteSeconds]) => [id, { id, firstByteSeconds }]),
  )
}

describe('slowestFirstByte', () => {
  it('returns null when no member can be resolved', () => {
    expect(slowestFirstByte({ members: [], providers: [provider({ id: 'p1' })], presets: {} })).toBeNull()
    expect(
      slowestFirstByte({ members: ['ghost'], providers: [provider({ id: 'p1' })], presets: {} }),
    ).toBeNull()
  })

  it('falls back to the built-in default when the provider type is unknown', () => {
    const slowest = slowestFirstByte({
      members: ['p1'],
      providers: [provider({ id: 'p1', defaultType: 'missing' })],
      presets: {},
    })
    expect(slowest?.seconds).toBe(DEFAULT_FIRST_BYTE_SECONDS)
  })

  it('uses the provider default type for a keyless provider', () => {
    const slowest = slowestFirstByte({
      members: ['p1'],
      providers: [provider({ id: 'p1', defaultType: 'slow' })],
      presets: presets({ slow: 90 }),
    })
    expect(slowest).toEqual({ seconds: 90, providerName: 'p1' })
  })

  it('lets a key-level type override the provider default and reports the slowest', () => {
    const slowest = slowestFirstByte({
      members: ['p1', 'p2'],
      providers: [
        provider({ id: 'p1', defaultType: 'fast', keyRows: [key('k1', '')] }),
        provider({ id: 'p2', name: 'slow-relay', defaultType: 'slow', keyRows: [key('k2', 'slow')] }),
      ],
      presets: presets({ fast: 30, slow: 120 }),
    })
    expect(slowest).toEqual({ seconds: 120, providerName: 'slow-relay' })
  })

  it('ignores disabled keys, which never carry a request', () => {
    const slowest = slowestFirstByte({
      members: ['p1'],
      providers: [
        provider({
          id: 'p1',
          defaultType: 'fast',
          keyRows: [key('k1', 'fast'), key('k2', 'deadturtle', false)],
        }),
      ],
      presets: presets({ fast: 30, deadturtle: 600 }),
    })
    expect(slowest?.seconds).toBe(30)
  })
})

describe('retryTimeLimitWarning', () => {
  const providers = [provider({ id: 'p1', name: 'amd', defaultType: 'amd', keyRows: [key('k1', '')] })]
  const base = { members: ['p1'], providers, presets: presets({ amd: 30 }) }

  it('says nothing when the limit outlives one slow attempt', () => {
    expect(retryTimeLimitWarning({ ...base, maxDurationSeconds: 31 })).toBeNull()
    expect(retryTimeLimitWarning({ ...base, maxDurationSeconds: 300 })).toBeNull()
  })

  it('warns at exactly the first-byte timeout (the deadline is already spent)', () => {
    const message = retryTimeLimitWarning({ ...base, maxDurationSeconds: 30 })
    expect(message).toContain('本组最慢的首字节超时是 30 秒（amd）')
    expect(message).toContain('「无限」实际等于不重试')
    expect(message).toContain('建议至少 90 秒')
  })

  it('warns below the first-byte timeout', () => {
    // The incident: 30s first byte, 5s limit → the budget is gone before the
    // first attempt can even finish.
    expect(retryTimeLimitWarning({ ...base, maxDurationSeconds: 5 })).toContain('一次超时就会耗尽预算')
  })

  it('stays quiet for an invalid value (the field has its own error)', () => {
    expect(retryTimeLimitWarning({ ...base, maxDurationSeconds: Number.NaN })).toBeNull()
    expect(retryTimeLimitWarning({ ...base, maxDurationSeconds: 0 })).toBeNull()
  })

  it('stays quiet for a group with no resolvable member', () => {
    expect(
      retryTimeLimitWarning({ ...base, members: [], maxDurationSeconds: 5 }),
    ).toBeNull()
  })
})
