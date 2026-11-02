/**
 * `buildProviders` is the bridge between `llm-config.json` and the detail page.
 *
 * The header renders `url` and `protocol` straight off it, and the provider
 * dialog edits through it, so a field dropped here is invisible in the UI:
 * the API address the user typed at creation time simply stops being shown,
 * and the edit dialog has nothing to write back.
 */

import { describe, expect, test } from 'bun:test'

import { buildProviders, gatewaySetupSteps, keyAvailabilitySegments, shouldShowGatewaySetup } from '../proto/viewmodel'
import type { GatewayStatus, LlmConfigShape, LlmKeyStateShape, ProviderDetailShape } from '../types'

function makeConfig(overrides: Partial<LlmConfigShape['providers'][number]> = {}): LlmConfigShape {
  return {
    version: 1,
    presets: {},
    providers: [
      {
        id: 'p1',
        name: '提供商一',
        note: '',
        baseUrl: 'https://api.example.cn/v1/chat/completions',
        protocol: 'openai-completions',
        enabled: true,
        keys: [],
        defaultPreset: '',
        models: {},
        ...overrides,
      } as LlmConfigShape['providers'][number],
    ],
    strategies: [],
    clientKeys: [],
  }
}

const NO_STATUS: GatewayStatus | null = null
const NO_KEY_STATES = new Map<string, LlmKeyStateShape>()
const NO_DETAILS: Record<string, ProviderDetailShape> = {}

describe('gatewaySetupSteps', () => {
  const readyProvider = {
    id: 'p1',
    url: 'https://api.example.cn/v1',
    state: 'ok',
    lastTest: '10-31 12:00 测试成功',
    lastTestOk: true,
    keyRows: [{ enabled: true, key: 'sk-ready' }],
    modelList: ['gpt-5'],
  } as unknown as import('../proto/viewmodel').ProtoProvider
  const readyStrategy = {
    id: 's1',
    enabled: true,
    units: [{ provider: 'p1', model: 'gpt-5' }],
  } as unknown as import('../proto/viewmodel').ProtoStrategy
  const config = (): LlmConfigShape => ({
    ...makeConfig({ keys: [{ id: 'k1', key: 'sk-k1' }], models: { 'gpt-5-up': 'gpt-5' } }),
    strategies: [{ id: 's1', type: 'round_robin', members: [{ provider: 'p1' }] }],
  })

  test('requires an explicitly selected default strategy, not merely an existing strategy', () => {
    expect(gatewaySetupSteps(config(), [readyProvider], [readyStrategy])).toEqual([true, true, false])
  })

  test('marks all steps complete when a tested provider and enabled default strategy exist', () => {
    expect(gatewaySetupSteps({ ...config(), defaultStrategy: 's1' }, [readyProvider], [readyStrategy])).toEqual([true, true, true])
  })

  test('does not complete the default-group step for a disabled strategy', () => {
    expect(gatewaySetupSteps(
      { ...config(), defaultStrategy: 's1' },
      [readyProvider],
      [{ ...readyStrategy, enabled: false }],
    )).toEqual([true, true, false])
  })
})

describe('shouldShowGatewaySetup', () => {
  test('hides the card after every step is complete', () => {
    expect(shouldShowGatewaySetup([true, true, true], false)).toBe(false)
  })

  test('shows the card while a step remains and it was not dismissed', () => {
    expect(shouldShowGatewaySetup([true, true, false], false)).toBe(true)
  })

  test('keeps a manually dismissed card hidden', () => {
    expect(shouldShowGatewaySetup([false, false, false], true)).toBe(false)
  })
})

describe('keyAvailabilitySegments', () => {
  test('returns only non-zero status segments', () => {
    expect(keyAvailabilitySegments({ avail: 2, cool: 0, unavailable: 1, dis: 0 })).toEqual([
      { id: 'available', label: '可用', count: 2, color: 'var(--state-ok)' },
      { id: 'unavailable', label: '暂不可用', count: 1, color: 'var(--state-bad)' },
    ])
  })

  test('returns no segments when a provider has no keys', () => {
    expect(keyAvailabilitySegments({ avail: 0, cool: 0, unavailable: 0, dis: 0 })).toEqual([])
  })
})

describe('buildProviders — header fields', () => {
  test('carries baseUrl through as url', () => {
    const [p] = buildProviders(makeConfig(), NO_STATUS, NO_KEY_STATES, NO_DETAILS)
    expect(p.url).toBe('https://api.example.cn/v1/chat/completions')
  })

  test('carries the protocol through so the header and the editor agree', () => {
    const [openai] = buildProviders(makeConfig(), NO_STATUS, NO_KEY_STATES, NO_DETAILS)
    expect(openai.protocol).toBe('openai-completions')

    const [anthropic] = buildProviders(
      makeConfig({ protocol: 'anthropic-messages' }),
      NO_STATUS,
      NO_KEY_STATES,
      NO_DETAILS,
    )
    expect(anthropic.protocol).toBe('anthropic-messages')
  })

  test('an empty baseUrl stays empty rather than becoming a placeholder', () => {
    // The header shows "(未设置)" for this; it must not invent a URL.
    const [p] = buildProviders(makeConfig({ baseUrl: '' }), NO_STATUS, NO_KEY_STATES, NO_DETAILS)
    expect(p.url).toBe('')
  })

  test('a missing config yields an empty list instead of throwing', () => {
    expect(buildProviders(null, NO_STATUS, NO_KEY_STATES, NO_DETAILS)).toEqual([])
  })
})

describe('buildProviders — live Key availability', () => {
  test('uses live availability and omits phantom available counts', () => {
    const config = makeConfig({
      keys: [
        { id: 'ready', key: 'sk-ready' },
        { id: 'cooling', key: 'sk-cooling' },
        { id: 'blocked', key: 'sk-blocked' },
        { id: 'disabled', key: 'sk-disabled', enabled: false },
      ],
    })
    const state = (keyId: string, cooling: boolean, available: boolean): LlmKeyStateShape => ({
      provider: 'p1', keyId, cooling, available, cooldownRemaining: cooling ? 30 : 0, inFlight: 0, weight: 1,
    })
    const liveStates = new Map([
      ['p1/ready', state('ready', false, true)],
      ['p1/cooling', state('cooling', true, false)],
      ['p1/blocked', state('blocked', false, false)],
      ['p1/disabled', state('disabled', false, true)],
    ])
    const status: GatewayStatus = {
      running: true, port: 8000, baseUrl: 'http://127.0.0.1:8000', enabled: true,
      strategies: [], coolingKeys: 1, inFlight: 0,
    }

    const [provider] = buildProviders(config, status, liveStates, NO_DETAILS)
    expect(provider.keys).toEqual({ avail: 1, cool: 1, unavailable: 1, dis: 1 })
  })

  test('shows enabled keys as unavailable while the gateway is stopped', () => {
    const config = makeConfig({ keys: [{ id: 'k1', key: 'sk-k1' }] })
    const status: GatewayStatus = {
      running: false, port: 0, baseUrl: '', enabled: true, strategies: [], coolingKeys: 0, inFlight: 0,
    }

    const [provider] = buildProviders(config, status, NO_KEY_STATES, NO_DETAILS)
    expect(provider.keys).toEqual({ avail: 0, cool: 0, unavailable: 1, dis: 0 })
  })
})

describe('buildProviders — key type resolution', () => {
  const detailWithKey = (keyId: string): ProviderDetailShape =>
    ({ provider: 'p1', keys: [{ keyId, requests: 5, success: 5, failed: 0 }] }) as ProviderDetailShape

  test('a deleted key type reads as inherit', () => {
    // The select has no option for a deleted id, and the gateway skips it, so
    // showing it would claim a type that cannot apply.
    const [p] = buildProviders(
      makeConfig({ keys: [{ id: 'k1', key: 'sk-x', preset: 'deleted' }] }),
      NO_STATUS,
      NO_KEY_STATES,
      NO_DETAILS,
    )
    expect(p.keyRows[0].type).toBe('')
  })

  test('an empty key type keeps the provider default for the RPD bar', () => {
    const config = makeConfig({
      defaultPreset: 'fast',
      keys: [{ id: 'k1', key: 'sk-x', preset: '' }],
    })
    config.presets = { fast: { id: 'fast', rpd: 100 } }
    const [p] = buildProviders(config, NO_STATUS, NO_KEY_STATES, { p1: detailWithKey('k1') })
    expect(p.keyRows[0].type).toBe('')
    expect(p.keyRows[0].rpd?.max).toBe(100)
  })
})

describe('buildProviders — model options', () => {
  test('carries per-model capability declarations through keyed by public name', () => {
    // The detail page edits these and writes them straight back, so a field
    // dropped here is invisible: the pill loses its summary and the dialog
    // reopens blank, silently discarding what the user just saved.
    const [p] = buildProviders(
      makeConfig({
        modelOptions: {
          'step-5-preview': { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true },
          'deepseek-v4-flash': { supportsThinking: true },
        },
      }),
      NO_STATUS,
      NO_KEY_STATES,
      NO_DETAILS,
    )
    expect(p.modelOptions['step-5-preview']).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      supportsImages: true,
    })
    expect(p.modelOptions['deepseek-v4-flash']).toEqual({ supportsThinking: true })
  })

  test('a provider with no modelOptions reads as an empty map, not undefined', () => {
    // Every consumer indexes it by model name; undefined there would throw on
    // a provider created before the field existed.
    const [p] = buildProviders(makeConfig(), NO_STATUS, NO_KEY_STATES, NO_DETAILS)
    expect(p.modelOptions).toEqual({})
  })
})
