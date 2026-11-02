/**
 * Pure helpers for the LLM gateway settings page.
 *
 * Everything here is a function of its arguments — no React, no IPC — so the
 * unit tests in `__tests__/helpers.test.ts` can cover the parts that decide
 * what a user sees (health tone, unit labels, roster text) without mounting
 * anything.
 */

import type {
  GatewayStatus,
  LlmConfigShape,
  LlmModelOptionsShape,
  LlmProviderShape,
  LlmStrategyShape,
  ModelWindow,
  ProviderTone,
} from './types'
import { DEFAULT_PRESET_ID } from './types'

/**
 * Mask a key for display.
 *
 * Mirrors `maskKey` in `packages/shared/src/config/llm-config.ts` but keeps the
 * head instead of the tail, because in this UI the heads are what differ
 * (`sk-ab12…` vs `sk-cd34…` on the same provider) and a masked key is only
 * useful if it lets you tell two of them apart.
 */
export function maskKeyHead(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return `${key.slice(0, 6)}…`
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

/** Compact token count: 1_234 → `1.2k`, 2_500_000 → `2.5M`. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Compact request count: same shape, no unit letter. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** First-byte latency, rounded for a card that shows one number. */
export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`
  return `${Math.round(n)}ms`
}

/**
 * A cooldown's remaining time, as the prototype's inline countdown reads.
 *
 * `272000` → `4 分 32 秒后恢复`; anything ≤ 0 → `即将恢复`. Minutes or seconds
 * are dropped when zero so the label stays short enough for a card row.
 */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return '即将恢复'
  const totalSec = Math.ceil(remainingMs / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s} 秒后恢复`
  if (s === 0) return `${m} 分后恢复`
  return `${m} 分 ${s} 秒后恢复`
}

/**
 * A provider's health tone.
 *
 * Derived, never stored: the config carries `enabled`, the gateway push carries
 * cooling/open circuits, and the usage feed carries last outcome. The old page
 * had a `healthState` field in the prototype that had no real counterpart, so
 * tone is computed here instead of persisted.
 *
 * Precedence is deliberate — a disabled provider is `disabled` even if it is
 * also cooling, because "it will never be used" beats "it is resting".
 */
export function providerTone(args: {
  provider: LlmProviderShape
  status?: GatewayStatus | null
}): ProviderTone {
  const { provider, status } = args
  if (provider.enabled === false) return 'disabled'
  const anyCooling = (provider.keys ?? []).some(
    (k) => status?.keyStates?.some((s) => s.provider === provider.id && s.keyId === k.id && s.cooling),
  )
  if (anyCooling) return 'cool'
  if (provider.lastTestOk === false) return 'down'
  return 'ok'
}

/** Tone → the label the prototype shows on the card. */
export const PROVIDER_TONE_LABEL: Record<ProviderTone, string> = {
  ok: '正常',
  cool: '全部冷却',
  down: '异常',
  disabled: '已停用',
}

/**
 * Key counts for a provider: enabled / cooling / disabled.
 *
 * Cooling is a runtime fact (it is in the status push, never in the config), so
 * it is passed in rather than read off the key. Keeping it an argument keeps
 * this function pure and makes the "cool beats enabled" rule testable — a key
 * that is enabled but cooling is *not* available, and the old page's counts
 * disagreed with the scheduler about that.
 */
export function keyCounts(
  provider: LlmProviderShape,
  coolingKeyIds?: ReadonlySet<string>,
): { avail: number; cool: number; dis: number } {
  let avail = 0
  let cool = 0
  let dis = 0
  ;(provider.keys ?? []).forEach((k) => {
    if (k.enabled === false) {
      dis++
      return
    }
    if (coolingKeyIds?.has(k.id)) cool++
    else avail++
  })
  return { avail, cool, dis }
}

/** The cooling key ids on one provider, from the live status push. */
export function coolingKeyIdsFor(
  providerId: string,
  status?: GatewayStatus | null,
): ReadonlySet<string> {
  const s = new Set<string>()
  status?.keyStates?.forEach((k) => {
    if (k.provider === providerId && k.cooling) s.add(k.keyId)
  })
  return s
}

/**
 * Make every strategy reference in the config resolvable.
 *
 * A config may legitimately point at a strategy that does not exist yet: a fresh
 * install has none, and the first group the user creates is what makes routing
 * possible. Saving that stale reference back made the validator reject the whole
 * write (`clientKeys[0] 引用了不存在的 strategy: auto`), which is how
 * "新建策略组" failed.
 *
 * Rules:
 * - references to strategies that no longer exist are dropped;
 * - `miniStrategy` is dropped when it names a missing group (it then means
 *   "follow the session");
 * - a client key left with nothing to route through adopts the first remaining
 *   group: the app's own sessions use that key, and an empty list is a hard 401
 *   with no UI to repair it.
 */
export function reconcileStrategyRefs(config: LlmConfigShape): LlmConfigShape {
  const ids = config.strategies.map((s) => s.id)
  const known = new Set(ids)
  const fallback = ids[0]
  const clientKeys = (config.clientKeys ?? []).map((ck) => {
    const kept = [...new Set((ck.strategies ?? []).filter((id) => known.has(id)))]
    return { ...ck, strategies: kept.length === 0 && fallback ? [fallback] : kept }
  })
  const miniStrategy = config.miniStrategy && known.has(config.miniStrategy) ? config.miniStrategy : undefined
  // Same repair for the new-session default: a dangling id would seed every new
  // session with a group that no longer exists, and the validator would then
  // reject every later save.
  const defaultStrategy = config.defaultStrategy && known.has(config.defaultStrategy) ? config.defaultStrategy : undefined
  return { ...config, clientKeys, miniStrategy, defaultStrategy }
}

/**
 * Which preset actually applies to a key: the key's own -> the provider's
 * default -> the built-in default.
 *
 * Mirrors `resolvePresetId` in `packages/shared/src/config/llm-config.ts`. A
 * step is skipped when it is empty or names a preset whose row was deleted, so
 * the type shown on the detail page is the one the gateway schedules instead of
 * a dangling id that silently ran the built-in limits.
 */
export function resolvePresetId(
  config: LlmConfigShape | null,
  providerDefaultPreset?: string,
  keyPreset?: string,
): string {
  const presets = config?.presets ?? {}
  const candidates = [keyPreset, providerDefaultPreset, DEFAULT_PRESET_ID]
  for (const id of candidates) {
    if (id && presets[id]) return id
  }
  return DEFAULT_PRESET_ID
}

/**
 * How many providers / keys resolve to a preset.
 *
 * A key with no `preset` resolves to its provider's `defaultPreset`, so the
 * inheritance is counted here rather than at the write site — the prototype
 * shows these numbers on the collapsed preset card and they must agree with
 * what the scheduler would actually pick.
 */
export function presetUsage(
  presetId: string,
  config: LlmConfigShape | null,
): { providers: number; keys: number } {
  if (!config) return { providers: 0, keys: 0 }
  // An empty id has no type to attribute anything to. Without this guard the
  // `k.preset || p.defaultPreset` fallback resolves every unset key to '' and
  // the unnamed card in the editor would claim them all.
  if (!presetId) return { providers: 0, keys: 0 }
  let providers = 0
  let keys = 0
  ;(config.providers ?? []).forEach((p) => {
    if (p.defaultPreset === presetId) providers++
    ;(p.keys ?? []).forEach((k) => {
      const effective = resolvePresetId(config, p.defaultPreset, k.preset)
      if (effective === presetId) keys++
    })
  })
  return { providers, keys }
}

/** The minimum a row must expose for the list filter. */
interface KeyRowLike {
  type: string
  enabled: boolean
  cool: boolean
  key: string
  note: string
}

export interface KeyRowFilter {
  /** Free text, matched against the key value and the note. */
  query: string
  excludeDisabled: boolean
  excludeCooling: boolean
  /** `'all'` or a preset id, matched against the *effective* type. */
  type: string
  /** The provider default a key with a blank preset inherits. */
  inherit: string
}

export type KeyRowSort = 'created-desc' | 'type'

/**
 * The rows a provider detail page shows. Extracted from the component so the
 * rules are testable — they are the only thing between a user and a key they
 * believe is missing.
 *
 * Type filtering compares the *effective* type (`k.type || inherit`), not the
 * stored preset. A key with a blank preset runs as the provider default, so it
 * belongs under that type in the list; comparing the raw preset made every
 * 继承默认 key vanish the moment a type was selected, which reads as data loss.
 */
export function selectKeyRows<T extends KeyRowLike>(
  rows: readonly T[],
  f: KeyRowFilter,
  sort: KeyRowSort = 'created-desc',
): T[] {
  const q = f.query.trim().toLowerCase()
  const kept = rows.filter((k) => {
    if (f.excludeDisabled && !k.enabled) return false
    if (f.excludeCooling && k.cool) return false
    if (f.type !== 'all' && (k.type || f.inherit) !== f.type) return false
    if (q && !(k.key + k.note).toLowerCase().includes(q)) return false
    return true
  })
  // Sorting by type uses the same effective value as filtering, so the keys
  // grouped under a type are the ones the filter would return for it.
  return sort === 'type'
    ? kept.sort((a, b) => (a.type || f.inherit).localeCompare(b.type || f.inherit))
    : kept
}

/***/
/** One strategy model pick; see `strategyPicks`. */

export interface StrategyModelEntry {
  providerId: string
  providerName: string
  model: string
}

/**
 * The model pills a strategy editor offers, one per (provider, model) pair.
 *
 * Filtered to the selected members, and *not* deduped by model name: the same
 * name served by two providers is two units, each toggled on its own. A merged
 * entry could not say which provider was meant, and turning it off dropped both.
 *
 * Order follows the providers as given, then each provider's own order.
 */
export function strategyModels(
  providers: readonly { id: string; name: string; modelList: readonly string[] }[],
  members: readonly string[],
): StrategyModelEntry[] {
  return providers
    .filter((p) => members.includes(p.id))
    .flatMap((p) =>
      p.modelList.map((model) => ({ providerId: p.id, providerName: p.name, model })),
    )
}

/** One selectable unit: this provider's copy of this model. */
export interface StrategyModelPick {
  provider: string
  model: string
}

/** Public model names in first-pick order. */
export function pickedModels(picked: readonly StrategyModelPick[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  picked.forEach((p) => {
    if (seen.has(p.model)) return
    seen.add(p.model)
    out.push(p.model)
  })
  return out
}

/**
 * What a save writes: the public model list plus the per-model provider pin.
 *
 * `modelProviders` is always explicit — even when a model is pinned to every
 * member — so the saved intent never depends on what the member list happens
 * to be later.
 */
export function toStrategyModels(picked: readonly StrategyModelPick[]): {
  models: string[]
  modelProviders: Record<string, string[]>
} {
  const models = pickedModels(picked)
  const modelProviders: Record<string, string[]> = {}
  models.forEach((model) => {
    modelProviders[model] = picked.filter((p) => p.model === model).map((p) => p.provider)
  })
  return { models, modelProviders }
}

/**
 * Expand a saved strategy back into picks.
 *
 * Strategies written before `modelProviders` existed mean "every member may
 * serve this model", so each configured model expands across the members that
 * actually list it. Falling back to all members keeps a model visible (and
 * removable) even when no current member advertises it.
 */
export function strategyPicks(
  models: readonly string[],
  modelProviders: Record<string, string[]> | undefined,
  members: readonly string[],
  providers: readonly { id: string; modelList: readonly string[] }[],
): StrategyModelPick[] {
  const out: StrategyModelPick[] = []
  models.forEach((model) => {
    const pinned = modelProviders?.[model]
    if (pinned?.length) {
      pinned.forEach((provider) => out.push({ provider, model }))
      return
    }
    const owners = members.filter((id) => providers.find((p) => p.id === id)?.modelList.includes(model))
    const fallback = owners.length ? owners : [...members]
    fallback.forEach((provider) => out.push({ provider, model }))
  })
  return out
}

/** The strategy ids a provider belongs to — shown on the provider card. */export function strategiesForProvider(
  providerId: string,
  config: LlmConfigShape | null,
): string[] {
  if (!config) return []
  return (config.strategies ?? [])
    .filter((s) => (s.members ?? []).some((m) => m.provider === providerId))
    .map((s) => s.id)
}

/** A strategy's members as `name × weight` / `name`, for the summary line. */
export function strategyMemberText(
  strategy: LlmStrategyShape,
  config: LlmConfigShape | null,
): string {
  const nameOf = (id: string) =>
    (config?.providers ?? []).find((p) => p.id === id)?.name || id
  return (strategy.members ?? [])
    .map((m) => {
      const n = nameOf(m.provider)
      if (strategy.type === 'weighted' && m.weight !== undefined) return `${n} ×${m.weight}`
      return n
    })
    .join('、')
}

/** A strategy's models, from its alias map. Empty = "inherits every model". */
export function strategyModelText(strategy: LlmStrategyShape): string {
  const names = Object.keys(strategy.modelAliases ?? {})
  if (names.length === 0) return '全部模型'
  return names.join('、')
}

export const STRATEGY_TYPE_LABEL: Record<string, string> = {
  round_robin: '轮询',
  sequential: '顺序',
  weighted: '加权',
  least_busy: '最少并发',
  failover_only: '仅故障转移',
}

/**
 * Whether a time window is currently satisfied.
 *
 * A port of the prototype's `(now, windows[], tz) → bool` contract
 * (`window-vectors.json`, 8 vectors) — the scheduler needs the same answer, so
 * this is the function both sides should converge on. `days` uses ISO numbering
 * (1 = Monday).
 *
 * Two traps this deliberately handles:
 *
 * 1. **Cross-midnight spans.** `start > end` means `[start, 24:00) ∪ [00:00,
 *    end)`, not an empty interval. A plain `t >= start && t < end` silently
 *    makes a 22:00–06:00 window never match, which reads as "this model is
 *    always off" rather than as a bug.
 *
 * 2. **Mixed granularity in the date bounds.** `from`/`to` are full datetimes
 *    (`2026-10-18 00:00`) while spans are wall-clock times (`22:00`), so they
 *    cannot be compared as strings in one pass — the date part goes against a
 *    `YYYY-MM-DD` slice and the time part against the wall clock.
 */
export function inWindow(now: Date, win: ModelWindow | undefined): boolean {
  if (!win) return true
  if (!win.tz) return true

  // Wall-clock parts in the window's timezone — never the host's.
  const parts = wallClockIn(now, win.tz)
  const hhmm = `${pad2(parts.hour)}:${pad2(parts.minute)}`
  const ymd = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`

  // Date bounds first, then weekday, then the spans.
  const fromDate = win.from ? win.from.slice(0, 10) : ''
  const fromTime = win.from && win.from.length > 10 ? win.from.slice(11, 16) : ''
  const toDate = win.to ? win.to.slice(0, 10) : ''
  const toTime = win.to && win.to.length > 10 ? win.to.slice(11, 16) : ''

  if (fromDate && ymd < fromDate) return false
  if (toDate && ymd > toDate) return false
  // On the boundary day the time of day still governs, otherwise `from`
  // 2026-10-18 00:00 would exclude the whole of 10-18 after 00:00.
  if (fromDate && fromTime && ymd === fromDate && hhmm < fromTime) return false
  if (toDate && toTime && ymd === toDate && hhmm > toTime) return false

  if (win.days && win.days.length > 0 && !win.days.includes(parts.isoWeekday)) return false

  const spans = win.spans ?? []
  if (spans.length === 0) return true
  return spans.some((s) => inSpan(hhmm, s.start, s.end))
}

/**
 * Whether `hhmm` falls in `[start, end)` on the wall clock.
 *
 * When `start > end` the two endpoints are wrapped, so the match is
 * `t >= start || t < end` instead of an always-false `t >= start && t < end`.
 */
function inSpan(hhmm: string, start: string, end: string): boolean {
  if (start <= end) return hhmm >= start && hhmm < end
  // Cross-midnight: [start, 24:00) ∪ [00:00, end).
  return hhmm >= start || hhmm < end
}

/**
 * Wall-clock reading of `now` in `tz`.
 *
 * Uses `Intl` so DST is handled by the platform rather than by us — the
 * prototype deliberately stores an IANA name, not a fixed UTC offset, and this
 * is where that pays off.
 */
function wallClockIn(
  now: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; isoWeekday: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    })
    const parts = fmt.formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const weekday = get('weekday')
    const isoWeekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] ?? 1
    // `hour: '2-digit'` with hour12:false yields "24" for midnight in some ICU
    // builds; normalise rather than produce an impossible hour.
    const hour = Number(get('hour')) % 24
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      hour,
      minute: Number(get('minute')),
      isoWeekday,
    }
  } catch {
    // Unknown tz: fall back to host time so the row still reads rather than
    // disappearing, which would look like "this model is never available".
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
      isoWeekday: ((now.getDay() + 6) % 7) + 1,
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO weekday (1=Mon…7=Sun) → 中文单字，按 ISO 下标取。 */
const DAY_CN = ['', '一', '二', '三', '四', '五', '六', '日']

/**
 * Human summary of a window, for the card, the tooltip, and the model
 * dialog's read-only 限时启用 row.
 *
 * Must be complete on its own: with the editor gone from the dialog, this
 * line is the only place a user sees which weekdays survive, so a window
 * that is Monday-only must not read as 「全天」.
 */
export function windowSummary(win: ModelWindow | undefined): string {
  if (!win) return ''
  const spans = (win.spans ?? []).length
    ? (win.spans ?? []).map((s) => `${s.start}–${s.end}`).join('、')
    : '全天'
  const bits = [spans, win.tz || '']
  // All seven days (or absent) is the default and stays silent; a subset
  // names itself rather than hiding behind 全天.
  if (win.days && win.days.length > 0 && win.days.length < 7) {
    bits.push(`仅 周${win.days.slice().sort((a, b) => a - b).map((d) => DAY_CN[d] ?? d).join('、')}`)
  }
  if (win.from || win.to) {
    const from = win.from ? win.from.slice(0, 10) : '立即'
    const to = win.to ? win.to.slice(0, 10) : '无限期'
    bits.push(`${from} → ${to}`)
  }
  return bits.filter(Boolean).join(' · ')
}

/**
 * Parse a token count the way the capability form accepts it.
 *
 * A bare integer, grouped digits (`1,000,000`) or a `k`/`M` suffix
 * (`1M`, `256k`, `1.5M`) all mean the same number — the alternative is a text
 * input that rejects the value the user just read off a model card. Returns
 * null for anything unparseable so the caller can refuse the save instead of
 * writing NaN into the config.
 */
export function parseTokenInput(raw: string): number | null {
  const s = raw.trim().replace(/[,_\s]/g, '')
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(s)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const mult = m[2] ? (m[2].toLowerCase() === 'm' ? 1e6 : 1e3) : 1
  return Math.round(n * mult)
}

/**
 * Context window a model gets when it declares none.
 *
 * `modelOptions` is advisory, but every reader still has to size a budget
 * against something, and this page is where that something is chosen. Seeding
 * the form with it makes the dialog display the value a consumer will
 * effectively see, so what the user reads is what the model gets — clearing
 * the field remains the way to say "not declared".
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 512_000

/** Form draft for one model's capability block; empty string = unset. */
export interface ModelOptionsDraft {
  contextWindow: string
  maxOutputTokens: string
  supportsImages: boolean
  supportsThinking: boolean
}

/**
 * Seed the form from stored options. Unknown capability flags start ON (most
 * models accept images / emit reasoning); only an explicit `false` shows off.
 */
export function modelOptionsDraft(opts: LlmModelOptionsShape | undefined): ModelOptionsDraft {
  return {
    contextWindow: opts?.contextWindow ? String(opts.contextWindow) : String(DEFAULT_MODEL_CONTEXT_WINDOW),
    maxOutputTokens: opts?.maxOutputTokens ? String(opts.maxOutputTokens) : '',
    supportsImages: opts?.supportsImages !== false,
    supportsThinking: opts?.supportsThinking !== false,
  }
}

export type ModelOptionsDraftResult =
  | { ok: true; options: LlmModelOptionsShape }
  | { ok: false; error: string }

/**
 * Clean a form draft into the shape that gets written to the config.
 *
 * Numeric fields are dropped rather than stored as 0: "unknown" and
 * "explicitly zero" must stay distinguishable, because the validator accepts
 * 0 while every reader treats a missing field as "not declared". Capability
 * flags are always written as an explicit boolean — the form defaults them to
 * on, so turning one off must persist as `false` ("declared unsupported")
 * instead of being dropped and silently reverting to on.
 */
export function applyModelOptionsDraft(draft: ModelOptionsDraft): ModelOptionsDraftResult {
  const ctx = parseTokenInput(draft.contextWindow)
  if (draft.contextWindow.trim() && ctx === null) {
    return { ok: false, error: '上下文格式无效，可用 1000000、1,000,000、1.5M 或 32k' }
  }
  if (ctx !== null && ctx < 0) return { ok: false, error: '上下文不能为负' }
  const out = parseTokenInput(draft.maxOutputTokens)
  if (draft.maxOutputTokens.trim() && out === null) {
    return { ok: false, error: '最大输出格式无效，可用 65536、65,536 或 64k' }
  }
  if (out !== null && out < 0) return { ok: false, error: '最大输出不能为负' }
  const options: LlmModelOptionsShape = {
    ...(ctx !== null ? { contextWindow: ctx } : {}),
    ...(out !== null ? { maxOutputTokens: out } : {}),
    supportsImages: draft.supportsImages,
    supportsThinking: draft.supportsThinking,
  }
  return { ok: true, options }
}

/**
 * Merge the form's four fields onto the stored capability record.
 *
 * The dialog edits `contextWindow`, `maxOutputTokens` and the two flags — and
 * nothing else on the record. Replacing the whole object made every save delete
 * fields the form does not show, which is how a model's `reasoningEfforts`
 * vanished and 最大 fell back to the upstream default (2026-10-30). Merging
 * keeps the dialog honest about what it owns.
 */
export function mergeModelOptions(
  existing: LlmModelOptionsShape | undefined,
  applied: LlmModelOptionsShape,
): LlmModelOptionsShape {
  return { ...(existing ?? {}), ...applied }
}

/**
 * One-line capability summary for a model pill and its tooltip.
 *
 * Empty when nothing is declared, so a pill that carries no options looks
 * exactly like one from before the field existed.
 */
export function modelOptionsSummary(opts: LlmModelOptionsShape | undefined): string {
  if (!opts) return ''
  const bits: string[] = []
  if (opts.contextWindow) bits.push(`上下文 ${compactTokens(opts.contextWindow)}`)
  if (opts.maxOutputTokens) bits.push(`最大 ${compactTokens(opts.maxOutputTokens)}`)
  if (opts.supportsImages) bits.push('图像')
  if (opts.supportsThinking) bits.push('推理')
  return bits.join(' · ')
}

/**
 * Preset ids that actually exist, in config order.
 *
 * Ids that are only *referenced* (a key or provider pointing at a type that was
 * deleted) are deliberately absent: `resolvePresetId` skips them, so offering
 * one in a picker would let the user choose a type that can never apply.
 */
export function presetIds(config: LlmConfigShape | null): string[] {
  if (!config) return []
  return Object.keys(config.presets ?? {})
}

/**
 * Options for a "默认类型" picker: the built-in `default` first, then every
 * configured or referenced preset.
 *
 * `resolvePreset` ends its chain with `?? 'default'`, so the built-in type
 * always exists at runtime even when the config carries no `presets` row for
 * it — a config written before that row was seeded, which is the common case
 * for a fresh `llm-config.json` (`presets: {}`). Listing only the stored keys
 * left the provider dialog's 默认类型 dropdown with zero options, so the field
 * could not be set at all.
 */
export function presetOptionIds(config: LlmConfigShape | null): string[] {
  if (!config) return []
  const ids = presetIds(config)
  return ids.includes(DEFAULT_PRESET_ID) ? ids : [DEFAULT_PRESET_ID, ...ids]
}

/** Trim, then reject anything empty — shared by every name field. */
/**
 * Derive a provider id from a display name.
 *
 * Ids end up in URLs, config keys and the client's X-Strategy header, so they
 * must match isValidId. A Chinese or space-padded name used to pass through
 * untouched, which produced an id the validator then rejected.
 *
 * Kept is [a-z0-9_-]; everything else collapses to a single `-` so
 * "My Cool 提供商" becomes "my-cool" rather than being dropped or rejected.
 * An empty result falls back to "provider", so creation is never blocked by
 * naming alone — `providerIdFromName` then suffixes it to keep ids unique.
 */
export function normalizeName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'provider'
}

export function isValidId(raw: string): boolean {
  // Ids appear in URLs, config keys, and the client's X-Strategy header, so
  // keep them boring: lowercase alnum plus `-` and `_`, must start alnum.
  return /^[a-z0-9][a-z0-9_-]*$/.test(raw)
}

/**
 * The provider id a create dialog should commit, derived from the name.
 *
 * There is no id field any more: the name is what the user manages and what
 * must be unique. The id is the internal slug the config and the strategy
 * members reference, so it still has to be unique — two different names can
 * slugify the same (`Agnes CN` / `agnes_cn`), and every non-ASCII name collapses
 * to `provider`. Suffixing rather than refusing keeps the promise that any
 * unused name works.
 *
 * Existing providers keep their id when renamed: strategies reference it, so a
 * rename must not repoint them.
 */
export function providerIdFromName(name: string, takenIds: readonly string[]): string {
  const taken = new Set(takenIds)
  const base = normalizeName(name)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * Whether a provider name is already taken.
 *
 * Checked instead of the id because the name is the only field the user edits;
 * reporting a collision on a slug they never saw ("provider 已存在" for two
 * Chinese names) explains nothing. `exceptId` lets a rename keep its own name.
 */
export function providerNameTaken(
  providers: readonly { id: string; name: string }[],
  name: string,
  exceptId?: string,
): boolean {
  const want = name.trim().toLowerCase()
  if (!want) return false
  return providers.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === want)
}
