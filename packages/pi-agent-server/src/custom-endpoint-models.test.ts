import { describe, expect, it } from 'bun:test'
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
} from './custom-endpoint-models.ts'

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })
  })
})

describe('buildCustomEndpointModelDef', () => {
  it('defaults custom endpoint models to text-only input', () => {
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.input).toEqual(['text'])
  })

  it('enables image input when the connection explicitly opts in', () => {
    const model = buildCustomEndpointModelDef('vision-model', { supportsImages: true })
    expect(model.input).toEqual(['text', 'image'])
  })

  it('lets per-model overrides disable image input even when the connection default is enabled', () => {
    const model = buildCustomEndpointModelDef('text-only-model', { supportsImages: true }, { supportsImages: false })
    expect(model.input).toEqual(['text'])
  })

  it('lets per-model overrides enable image input and custom context window', () => {
    const model = buildCustomEndpointModelDef('vision-model', undefined, { supportsImages: true, contextWindow: 262_144 })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.contextWindow).toBe(262_144)
  })

  it('defaults maxTokens to 65536 (was 8192, which truncated reasoning models)', () => {
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.maxTokens).toBe(65_536)
  })

  it('lets per-model overrides set a custom maxTokens cap', () => {
    const entry = normalizeCustomEndpointModelEntry({ id: 'pi/big-model', maxTokens: 65_536 })
    expect(entry).toEqual({ id: 'big-model', maxTokens: 65_536 })
    const model = buildCustomEndpointModelDef('big-model', undefined, { maxTokens: 65_536 })
    expect(model.maxTokens).toBe(65_536)
  })

  it('declares reasoning:true but disables the developer role and requires reasoning_content back (upstream 400s otherwise)', () => {
    // Layer-2 fix: reasoning:true makes the session thinkingLevel reach the
    // request, but pi-ai only emits the developer role when
    // model.reasoning && compat.supportsDeveloperRole. Our upstream relay
    // rejects the developer role with a 400, so custom endpoints must keep
    // it disabled even though reasoning is on. Separately, once reasoning is
    // on the upstream enters thinking mode and requires reasoning_content to
    // be echoed back on every assistant message in multi-turn chats, else
    // it 400s with "the reasoning_content in the thinking mode must be passed
    // back". Finally, the relay only recognizes max_tokens (not the default
    // max_completion_tokens o1/o3 field), so we pin maxTokensField.
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.reasoning).toBe(true)
    expect(model.compat?.supportsDeveloperRole).toBe(false)
    expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBe(true)
    expect(model.compat?.maxTokensField).toBe('max_tokens')
  })
})
