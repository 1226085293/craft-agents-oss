/**
 * `buildProviders` is the bridge between `llm-config.json` and the detail page.
 *
 * The header renders `url` and `protocol` straight off it, and the provider
 * dialog edits through it, so a field dropped here is invisible in the UI:
 * the API address the user typed at creation time simply stops being shown,
 * and the edit dialog has nothing to write back.
 */

import { describe, expect, test } from 'bun:test'

import { buildProviders } from '../proto/viewmodel'
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
