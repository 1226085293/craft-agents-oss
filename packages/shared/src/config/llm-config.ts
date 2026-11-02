/**
 * llm-config.json — the single source of truth for the built-in LLM gateway.
 *
 * Types only. Loading, validation, and hot-reload live in sibling modules
 * (`loader.ts`, `watcher.ts`) so the renderer can import this file without
 * pulling in `node:fs`.
 *
 * Replaces the old uni-api `api.yaml` (Python, external process) and the
 * `config.json` `llmConnections[]` array.
 *
 * Design rules:
 * - Every limit that has a measured upstream justification carries a comment
 *   naming the incident, so the UI tooltip and the schema never drift apart.
 * - OAuth / IAM / service-account credentials are NOT represented here. The
 *   v1 gateway is API-key only by decision (2026-10-14).
 * - Keys are stored inline as plaintext, matching the pre-existing practice in
 *   `config.json` (`llmConnections[].auth.apiKey`). Files must stay user-only.
 */

// ============================================================================
// Versioning
// ============================================================================

export const LLM_CONFIG_VERSION = 1;

// ============================================================================
// Presets — reusable per-provider/key limit templates
// ============================================================================

/**
 * A named bundle of limits and capabilities.
 *
 * Presets exist so a provider with 40+ keys does not need the same numbers
 * repeated per key, and so "default" vs "pro" can differ by a couple of fields
 * instead of a whole block.
 */
/**
 * One user-defined limit window on a preset, e.g. "500 requests / 5 hours".
 *
 * This replaced the fixed `rpm`/`rpd`/`tpm`/`tpd`/`qps` fields: those were the
 * same "N per T" shape, so keeping both meant two sources of truth and limits
 * that stayed in force while the UI no longer showed them. `rulesForModel`
 * translates this to a `RateLimitRule`.
 *
 * Window semantics: `sliding: true` (default) means the last N seconds; the
 * window slides with the clock. `sliding: false` means a fixed window that
 * resets at the UTC boundary — the 24-hour boundary is UTC midnight, matching
 * how upstreams reset daily quotas; other durations reset at multiples of
 * their period from the epoch.
 */
export interface LlmCustomLimit {
  /** Requests or tokens allowed per window. */
  amount: number;
  unit: 'requests' | 'tokens';
  /** Window length: `per` × `perUnit`. */
  per: number;
  perUnit: 'seconds' | 'minutes' | 'hours';
  /**
   * Sliding window (default) vs fixed window that resets at the UTC boundary.
   * `false` = fixed; `true` or absent = sliding.
   */
  sliding?: boolean;
}

export interface LlmPreset {
  /** --- Rate limiting --- */

  /** Tokens per single request: rejects an oversized call before dispatch. */
  tpr?: number;
  /** Max concurrent in-flight requests for one key. */
  concurrency?: number;

  /**
   * Windows this channel enforces, in the units the settings page edits.
   *
   * Additive ceilings: every rule is enforced, so a window can only make the
   * channel stricter.
   */
  customLimits?: LlmCustomLimit[];

  /** --- Model capability --- */

  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStream?: boolean;
  supportsToolCalls?: boolean;
  supportsVision?: boolean;

  /** --- Admission guards --- */

  /**
   * Largest single request this channel accepts, in tokens.
   *
   * Measured: agnes free tier 400s at ~78k–86k prompt tokens while declaring a
   * much larger window (78,841 passed; adding two ~3.6k images pushed it over).
   * Often far below `contextWindow` — drives forced compaction so a session
   * degrades instead of walling into an opaque 400.
   */
  contextTokenBudget?: number;

  /**
   * Max image parts per request. Extras are replaced with a placeholder string.
   *
   * Measured: agnes rejects >=5 `image_url` parts with 400
   * `invalid_request_error`; <=4 passes. usage also silently truncates image
   * tokens from the 5th image on, so this cannot be diagnosed downstream.
   */
  maxImageParts?: number;

  maxFileParts?: number;
  maxRequestBytes?: number;

  /** --- Timeouts (seconds) --- */

  firstByteSeconds?: number;
  totalSeconds?: number;

  /** --- Cooldowns (seconds) --- */

  /** Cooldown after a 429 / rate-limit response. */
  rateLimitSeconds?: number;
  /** Cooldown after a quota-exhausted response. */
  quotaExhaustedSeconds?: number;
  /** Cooldown after any other failure. */
  defaultSeconds?: number;
  /**
   * Cooldown for one (provider, model) route after the provider says it does
   * not serve that model (404 / model-not-found). The key stays healthy — only
   * the route is parked — so this is deliberately much shorter than a quota
   * cooldown. Default 300s.
   */
  routeSeconds?: number;
}

// ============================================================================
// Providers
// ============================================================================

import type { ModelWindow } from './model-window.ts';

/** Upstream wire protocol. */
export type LlmProtocol = 'openai-completions' | 'anthropic-messages';

/** One API key under a provider. */
export interface LlmKey {
  /** Stable id used in traces, usage records, and sticky-session bindings. */
  id: string;
  /** Plaintext key. Never logged; see `maskKey`. */
  key: string;
  /** Human label, e.g. `gpt03@muzzik.cc`. Used to tell 40 same-host keys apart. */
  note?: string;
  /** Preset name from `presets`. Defaults to the provider's `defaultPreset`. */
  preset?: string;
  /** Per-key preset overrides. */
  overrides?: LlmPreset;
  /** Disabled keys stay in config but are never selected. */
  enabled?: boolean;
}

/**
 * Per-model capability declaration, keyed by public model name on a provider.
 *
 * Presets describe a *channel* (rate limits, timeouts, admission guards) and
 * are attached to keys; these describe a *model*, and every key serving that
 * model inherits them. The two answer different questions — "how hard may I
 * push this account" vs "what is this model" — so they live apart.
 *
 * Everything is optional and absent means "unknown": the gateway forwards
 * without rewriting the request, exactly as it did before the field existed.
 * The values exist so the settings page can show them and so a client (Craft)
 * can size its own context budget against a declared number instead of a
 * guess.
 */
export interface LlmModelOptions {
  /** Context window in tokens, e.g. 1_000_000. Drives client-side compaction. */
  contextWindow?: number;
  /** Ceiling on generated tokens per response, e.g. 65_536. */
  maxOutputTokens?: number;
  /** Model accepts image parts. Absent = unknown, not "no". */
  supportsImages?: boolean;
  /** Model emits a reasoning/thinking trace. Absent = unknown, not "no". */
  supportsThinking?: boolean;
  /**
   * Reasoning effort levels this model actually accepts, e.g.
   * `["low", "high", "max"]`.
   *
   * Declaring them is what lets the composer's thinking level reach an
   * OpenAI-shaped upstream: the gateway sends `reasoning_effort` clamped into
   * this set, and sends nothing when it is absent (guessing an effort the relay
   * does not know would turn a cosmetic mismatch into a 400).
   *
   * Aliases are not translated: write the strings the upstream accepts
   * (`low` / `medium` / `high` / `max`, occasionally `minimal`).
   */
  reasoningEfforts?: string[];
}

export interface LlmProvider {
  id: string;
  name: string;
  /** Full upstream endpoint including path, e.g. `https://host/v1/chat/completions`. */
  baseUrl: string;
  protocol: LlmProtocol;
  /** Request-construction template hint (mirrors uni-api `engine`). */
  engine?: string;
  enabled?: boolean;

  /** Upstream model id -> public model name. */
  models?: Record<string, string>;

  keys: LlmKey[];

  /**
   * Per-model availability windows, keyed by public model name. Outside its
   * window a model is removed from scheduling rather than tried and failed.
   */
  timeWindows?: Record<string, ModelWindow>;

  /**
   * Per-model capability declarations, keyed by public model name — context
   * window, max output, image / reasoning support. Advisory: nothing here
   * gates a request, it is what the settings page edits and what a client
   * reads back. See {@link LlmModelOptions}.
   */
  modelOptions?: Record<string, LlmModelOptions>;

  /** Preset applied to keys that do not name one. */
  defaultPreset?: string;
  /** Provider-wide preset overrides, applied above the named preset. */
  overrides?: LlmPreset;

  /** --- Active verification (written by the settings page, read back by it) --- */

  /**
   * When the settings page last ran an explicit "test connection" against this
   * provider, epoch ms. Absent means "never actively tested" — the usage-derived
   * state is then the only signal.
   */
  lastVerifiedAt?: number;
  /** Outcome of that explicit test. Drives the card's status dot over usage. */
  lastTestOk?: boolean;
}

// ============================================================================
// Strategy groups
// ============================================================================

export type LlmStrategyType =
  | 'round_robin'
  | 'sequential'
  | 'weighted'
  | 'least_busy'
  | 'failover_only';

export interface LlmStrategyMember {
  provider: string;
  /**
   * Public model this member serves. Absent means "any model the provider
   * declares", which is what every member meant before this existed.
   *
   * With `model` set, a member is a switching unit of its own: three models on
   * one provider become three ordered units instead of one, and a failure on
   * the first can fall through to the second. `modelProviders` is the older,
   * request-time way to pin a model to providers; when both exist the member
   * wins (see `planRequest`).
   */
  model?: string;
  /**
   * Upstream model id for this member, overriding `modelAliases`.
   *
   * Needed because one public name may be a different upstream id per provider
   * (A 家的 A1 vs B 家的 A1), which a strategy-wide alias cannot express.
   */
  upstreamModel?: string;
  /** Weight for `weighted`. */
  weight?: number;
  /** Absent means enabled. Lets one unit be parked without deleting it. */
  enabled?: boolean;
}

/** Scope a sticky-session binding is keyed on. */
export type LlmStickyScope = 'session' | 'session+model';

/**
 * What to do after one classified upstream failure.
 *
 * The switch unit is a `(provider, model)` route; inside it the pool rotates
 * keys. `retry-same` spends the same-key budget, `next-key` cools the key and
 * hands back the provider's next account, `next-unit` abandons the route for
 * the next one, `stop` ends the request.
 */
export type LlmSwitchAction = 'retry-same' | 'next-key' | 'next-unit' | 'stop';

/** The failure classes a strategy can route around. */
export type LlmSwitchFailure =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'model_not_found'
  | 'transport'
  | 'server_error';

export type LlmSwitchPolicy = Partial<Record<LlmSwitchFailure, LlmSwitchAction>>;

export interface LlmStrategy {
  id: string;

  /**
   * Display name. The id is a slug (`日常主用` normalises to `provider`), so the
   * two are not interchangeable: the composer, the cards and the logs all show
   * this, falling back to the id for strategies written before it existed.
   */
  name?: string;

  type: LlmStrategyType;
  members: LlmStrategyMember[];

  /**
   * Disabled strategies stay in the config but are not offered in the
   * composer and refuse to route. Absent means enabled.
   */
  enabled?: boolean;

  stickySession?: {
    enabled: boolean;
    ttlSeconds?: number;
    maxEntries?: number;
    scope?: LlmStickyScope;
  };

  /**
   * Compact the session's context after the gateway switches the key, provider
   * or upstream model it is served by. Default true.
   *
   * A switched key/model has no prompt cache, so the next full prompt is billed
   * at cache-miss rates. The gateway only *observes* the switch; compaction is
   * performed by the agent through its existing `/compact` path (zero-LLM
   * checkpoint first, LLM summary only when over the threshold), after the turn
   * finishes — never mid-stream.
   */
  compactAfterSwitch?: boolean;

  retry?: {
    /** Max transient retries on the SAME key before it is cooled and switched. */
    maxAttempts?: number;
    onStatusCodes?: number[];
    /** Backoff between same-key transient retries (ms). */
    backoffMs?: number;
  };

  cooldown?: {
    /**
     * Return a cooled-down key to its original queue position instead of the
     * tail. This is the existing uni-api default and matches the documented
     * requirement that a 429'd key comes back where it was, not at the end.
     *
     * Durations are not configured here: they belong to the key's preset
     * (`rateLimitSeconds` / `quotaExhaustedSeconds` / `defaultSeconds`), which
     * is what `KeyPool` actually reads.
     */
    returnToOriginalPosition?: boolean;
  };

  /**
   * Fallback strategy: when every provider in this strategy is unavailable
   * (all keys cooling / rate-limited / failed), the request transfers to this
   * strategy instead of failing. Cycle detection runs at request time — a
   * fallback chain that revisits a strategy already in the current chain is a
   * terminal error.
   */
  fallbackStrategyId?: string;

  /** Public model name -> upstream model name, resolved per provider. */
  modelAliases?: Record<string, string>;

  /**
   * Public model name -> the provider ids allowed to serve it.
   *
   * Absent means "any member", which is what a strategy meant before this
   * existed. Present but shorter than the member list pins the model: the same
   * model name offered by two providers becomes two independently selectable
   * units instead of one merged entry, and a pinned model never falls back to
   * a member that merely happens to speak the same upstream name.
   */
  modelProviders?: Record<string, string[]>;

  /**
   * Per-failure switching policy. Absent entries keep the built-in defaults
   * (`DEFAULT_SWITCH_POLICY` in `llm-gateway.ts`), which are the behaviour the
   * gateway shipped with:
   *
   *   rate_limit → next-key   quota → next-key   auth → next-key
   *   model_not_found → next-unit   transport → next-unit
   *   server_error → retry-same
   */
  switchPolicy?: LlmSwitchPolicy;
}

// ============================================================================
// Client keys (inbound auth)
// ============================================================================

export interface LlmClientKey {
  key: string;
  /** Strategy ids this client key may use. */
  strategies: string[];
  autoRetry?: boolean;
}

// ============================================================================
// Root
// ============================================================================

export interface LlmConfig {
  /**
   * Request-log retention. `persist: false` keeps only the current session's
   * log (cleared at startup); `persist: true` also writes one file per local
   * day. The overview's own counters are independent of this switch.
   */
  usage?: {
    persist?: boolean;
    /** Days of detail files to keep when persistence is on. */
    retainDays?: number;
  };

  $schema?: string;
  version: number;
  presets: Record<string, LlmPreset>;
  providers: LlmProvider[];
  strategies: LlmStrategy[];
  clientKeys: LlmClientKey[];
  /**
   * Strategy group used for auxiliary model calls — title generation, busy /
   * group-chat decisions, summarization, the verification judge.
   *
   * These used to run on the session's own connection, which meant a slice of
   * the app's traffic never appeared in the gateway's logs or usage stats and
   * was not subject to its rate limits or cooldowns. There is no direct
   * fallback any more: a kind that cannot resolve a group fails instead of
   * bypassing the gateway. When this is unset, such work falls back to the
   * first enabled group (see `resolveAuxiliaryStrategyId`).
   */
  miniStrategy?: string;
  /**
   * Strategy group new sessions route through when the caller does not name one.
   *
   * This lives in the gateway config — not in the renderer's localStorage and not
   * only in a workspace's `defaults` — because sessions are created server-side
   * by scheduled automations, messaging and the API, none of which see a
   * renderer preference. A local-only default left every one of those on
   * 未选择策略组, which the gateway then refuses to route (2026-10-25).
   *
   * Resolution: caller → workspace `defaults.strategy` → this field.
   */
  defaultStrategy?: string;
}

/**
 * A config with nothing configured yet.
 *
 * Distinct from `null`: `loadLlmConfig()` returns `null` when the file is
 * absent, which the settings page cannot distinguish from "the gateway is
 * broken" — it showed an error with no way to create anything, leaving a fresh
 * install unable to configure the gateway at all. Returning this instead lets
 * the page render its normal empty state with its create buttons.
 *
 * A fresh object each call, so a caller that mutates it cannot poison the next
 * reader.
 */
/**
 * The reserved preset id every provider/key falls back to.
 *
 * It is built in rather than created by the user because the fallback has to
 * exist for the fallback to mean anything: `resolvePreset` already ended its
 * chain with `?? 'default'`, so a config without that id silently resolved to
 * `DEFAULT_PRESET` with no preset row to edit — the limits were real but
 * invisible and unchangeable. Seeding it makes the effective default a first
 * class, editable row.
 *
 * Non-deletable: deleting it would leave every unset key with a reference to
 * an id that no longer resolves.
 */
export const DEFAULT_PRESET_ID = 'default';

export function emptyLlmConfig(): LlmConfig {
  return {
    version: 1,
    presets: { [DEFAULT_PRESET_ID]: { ...DEFAULT_PRESET } },
    providers: [],
    strategies: [],
    clientKeys: [],
  }
}

/**
 * Default preset. Deliberately conservative: every value here has either a
 * measured basis (see field comments) or is a safe no-op.
 */
export const DEFAULT_PRESET: LlmPreset = {
  concurrency: 1,
  supportsStream: true,
  supportsToolCalls: true,
  supportsVision: false,
  maxImageParts: 4,
  firstByteSeconds: 30,
  totalSeconds: 600,
  defaultSeconds: 60,
  rateLimitSeconds: 60,
  quotaExhaustedSeconds: 2592000,
  routeSeconds: 300,
};

/** Defaults mirroring uni-api's current `api.yaml` values. */
export const DEFAULT_STRATEGY_DEFAULTS = {
  stickyTtlSeconds: 3600,
  stickyMaxEntries: 128,
  retryMaxAttempts: 3,
  retryBackoffMs: 500,
} as const;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Mask a key for display and logs.
 *
 * uni-api's equivalent masks the head; this keeps a recognizable tail too,
 * because the practical need here is telling `gpt03` from `gpt43` apart.
 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Origin of a base URL — the grouping key for "same provider".
 *
 * Path is dropped on purpose: uni-api base URLs carry a full path
 * (`/v1/chat/completions`) while the same host may serve several paths.
 */
export function baseUrlOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.trim().replace(/\/+$/, '');
  }
}

/**
 * Which preset actually applies to a key.
 *
 * Chain: the key's own preset -> the provider's `defaultPreset` -> the built-in
 * `default`. A step is skipped when it is empty or names a preset that no
 * longer exists — deleting a type on the settings page leaves the reference
 * behind, and the old `??` chain treated `''` as a valid name, so it resolved
 * to `DEFAULT_PRESET` directly: the page said "inherit (fast)" while the
 * gateway silently ran the built-in limits. Falling through instead keeps the
 * displayed type and the scheduled type the same thing.
 */
export function resolvePresetId(
  config: LlmConfig,
  provider: LlmProvider,
  key?: LlmKey,
): string {
  // `presets` is required by the type but a hand-written file may omit it.
  const presets = config.presets ?? {};
  const candidates = [key?.preset, provider.defaultPreset, DEFAULT_PRESET_ID];
  for (const id of candidates) {
    if (id && presets[id]) return id;
  }
  return DEFAULT_PRESET_ID;
}

/** Effective limits for one key: preset -> provider overrides -> key overrides. */
export function resolvePreset(
  config: LlmConfig,
  provider: LlmProvider,
  key: LlmKey,
): LlmPreset {
  const presetName = resolvePresetId(config, provider, key);
  const base = config.presets?.[presetName] ?? DEFAULT_PRESET;
  return { ...base, ...(provider.overrides ?? {}), ...(key.overrides ?? {}) };
}
