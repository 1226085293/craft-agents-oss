export type CustomEndpointInput = 'text' | 'image'

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses. */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
  /**
   * Connection-level default for whether every assistant message must carry a
   * `reasoning_content` field. See the flag's definition below.
   */
  requiresReasoningContentOnAssistantMessages?: boolean
  /**
   * Connection-level ceiling on the size of a single request, in tokens — what
   * the provider/gateway actually accepts, independent of the model's declared
   * `contextWindow`. Drives forced compaction (see forced-compaction.ts).
   */
  contextTokenBudget?: number
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  /** Per-model output token cap override. When omitted, DEFAULT_MAX_TOKENS applies. */
  maxTokens?: number
  supportsImages?: boolean
  /** Per-model override of the assistant `reasoning_content` handshake. */
  requiresReasoningContentOnAssistantMessages?: boolean
  /** Per-model override of the channel request-size ceiling. */
  contextTokenBudget?: number
}

/** Resolved per-request token ceiling for a model (0 = unknown/unbounded). */
export function resolveContextTokenBudget(
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
): number {
  const raw = overrides?.contextTokenBudget ?? defaults?.contextTokenBudget;
  return typeof raw === 'number' && raw > 0 ? raw : 0;
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
 *
 * For `openai-completions` endpoints we set `compat.supportsStore = false` so the
 * pi-ai driver omits the OpenAI-platform-specific `store` param entirely. Third-party
 * OpenAI-compatible gateways gain nothing from `store`, and strict ones reject unknown
 * params with a 400 — which made those connections unusable. See craft-agents-oss#1022.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  api?: CustomEndpointApi,
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
      // requiresReasoningContentOnAssistantMessages — some upstreams run a
      // multi-turn "thinking mode" handshake that REQUIRES every assistant
      // message to carry a reasoning_content field (the stealth/ox-alpha
      // relay 400s with "the reasoning_content in the thinking mode must be
      // passed back" without it). Other upstreams do the exact opposite and
      // reject the property outright — Groq answers
      // "property 'reasoning_content' is unsupported" (2026-09-13).
      //
      // There is therefore no universally safe value: it must be configured
      // per endpoint. Defaults to true to preserve the behavior the flag was
      // introduced for; endpoints that reject the field set it false via
      // `customEndpoint.requiresReasoningContentOnAssistantMessages` in
      // config.json (or per model via `models: [{ id, ... }]`).
      requiresReasoningContentOnAssistantMessages:
        overrides?.requiresReasoningContentOnAssistantMessages
        ?? defaults?.requiresReasoningContentOnAssistantMessages
        ?? true,
      // craft-agents-oss#1022: strict OpenAI-compatible gateways reject the
      // OpenAI-platform-specific `store` param with a 400. supportsStore:false
      // makes the pi-ai driver omit it entirely for openai-completions.
      ...(api === 'openai-completions' ? { supportsStore: false } : {}),
    },
    // thinkingLevelMap — always-thinking GLM/z.ai-style relays reject any
    // request without a valid reasoning_effort ("该模型始终思考，不支持关闭思考；
    // 请使用 low、high 或 max", 2026-09-08). The SDK only sends
    // reasoning_effort when the session level maps to a string; with no map,
    // 'medium' went through raw (invalid) and 'off' sent nothing at all —
    // both hard-400. Map every level onto the accepted set: 'off' falls to
    // 'low' (thinking cannot be disabled), 'medium' rounds up to 'high',
    // 'xhigh' to 'max'. low/high/max pass through.
    thinkingLevelMap: {
      off: 'low',
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
      max: 'max',
    },
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131_072,
    maxTokens: overrides?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}
