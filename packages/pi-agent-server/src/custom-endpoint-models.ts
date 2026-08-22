export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  /** Per-model output token cap override. When omitted, DEFAULT_MAX_TOKENS applies. */
  maxTokens?: number
  supportsImages?: boolean
}

/**
 * Default output token cap for synthetic custom-endpoint models.
 *
 * Historical value was 8_192, which silently truncated reasoning-style models:
 * hidden reasoning consumed the whole budget → finish_reason=length with an
 * empty visible reply (2026-08-22 incident). This default is intentionally
 * moderate: some strict OpenAI-compatible backends reject oversized
 * `max_tokens` parameters outright, so a huge global default would break
 * them. Users with generous endpoints should override per model via
 * `models: [{ id, maxTokens }]` in config.
 */
export const DEFAULT_MAX_TOKENS = 65_536

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  }
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. Image support must be
 * explicitly enabled either at the connection level or per-model.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  // reasoning: true — declare the model as reasoning-capable so the user's
  // session thinkingLevel actually reaches the request (getSupportedThinkingLevels
  // returns only ['off'] when this is false, clamping e.g. 'medium' to off and
  // dropping the reasoning_effort param entirely). pi-ai maps reasoning_content
  // deltas to visible thinking blocks unconditionally, so streamed reasoning
  // stays visible either way; declaring true just makes the REQUEST honest.
  //
  // compat.supportsDeveloperRole: false — pi-ai emits the developer role only
  // when model.reasoning && compat.supportsDeveloperRole. Our upstream relay
  // terminates at a model (stealth/ox-alpha) that rejects the developer role
  // with a 400 ("developer is not one of [system,assistant,user,tool,function]").
  // Detected compat leaves it enabled for standard OpenAI-compatible URLs, so we
  // must explicitly disable it for custom endpoints to avoid that 400.
  return {
    id,
    name: id,
    reasoning: true,
    compat: {
      supportsDeveloperRole: false,
      // maxTokensField: 'max_tokens' — pi-ai's detectCompat defaults to
      // max_completion_tokens (o1/o3 family) for unknown endpoints, but our
      // upstream relay (stealth/ox-alpha) only recognizes max_tokens and
      // 400s with "Invalid max_tokens value, the valid range is [1, 393216]"
      // when given max_completion_tokens.
      maxTokensField: 'max_tokens',
      // requiresReasoningContentOnAssistantMessages: true — the upstream
      // relay (stealth/ox-alpha) enables thinking mode when the model
      // declares reasoning:true, and its multi-turn handshake requires
      // every assistant message to carry a reasoning_content field.
      // Without this flag, pi-ai omits reasoning_content from assistant
      // messages, and the upstream 400s with
      // "the reasoning_content in the thinking mode must be passed back".
      requiresReasoningContentOnAssistantMessages: true,
    },
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131_072,
    maxTokens: overrides?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}
