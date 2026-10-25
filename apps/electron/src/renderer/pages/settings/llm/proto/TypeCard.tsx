/**
 * 类型（预设）卡 — the prototype's `.typecard`, used by both the 类型 page
 * (`typesPageHtml`) and the provider-edit dialog's embedded list.
 *
 * The card is a controlled component: the parent owns the draft list, so
 * "保存类型" is a real config write (presets + renamed references) rather than
 * a DOM scrape like the prototype's `saveTypes()`.
 */

import * as React from 'react'

import type { CustomLimit, LlmConfigShape } from '../types'
import { DEFAULT_PRESET_ID } from '../types'
import { parseTokenInput } from '../helpers'

/**
 * A custom-window row while it is being edited.
 *
 * Both numbers are text: the amount box accepts `5M` / `500k` for token windows,
 * and an empty box is the honest "not filled in yet" — a fresh row must not
 * persist as a limit of 0, which the gateway would read as "allow nothing".
 * Incomplete rows stay in the form but are not written to config.
 */
export interface CustomLimitDraft {
  amount: string
  unit: CustomLimit['unit']
  per: string
  perUnit: CustomLimit['perUnit']
  /** Sliding window (default) vs fixed window that resets on the UTC boundary. */
  sliding?: boolean
}

export interface TypeDraft {
  name: string
  /**
   * Per-field limits. `undefined` means "not set" and renders as an empty
   * box — an unset limit is a real state (no cap) distinct from a limit of
   * 0, so it must stay distinguishable in the draft.
   */
  limits: Record<string, number | undefined>
  /** Limit windows (e.g. 500 次 / 5 小时); optional for older drafts. */
  customLimits?: CustomLimitDraft[]
}

/** Amount box: tokens accept `k`/`M` suffixes, request counts must be integers. */
function parseAmount(raw: string | number, unit: CustomLimit['unit']): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null
  }
  const text = raw.trim()
  if (!text) return null
  if (unit === 'tokens') {
    const tokens = parseTokenInput(text)
    return tokens !== null && tokens > 0 ? tokens : null
  }
  const n = Number(text.replace(/[,\s]/g, ''))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Window length box: positive whole number only. */
function parsePer(raw: string | number): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null
  }
  const text = raw.trim()
  if (!text) return null
  const n = Number(text)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Complete rows only: a half-filled row is a draft, not a limit. */
export function completeCustomLimits(drafts: CustomLimitDraft[] | undefined): CustomLimit[] {
  const out: CustomLimit[] = []
  for (const d of drafts ?? []) {
    const amount = parseAmount(d.amount, d.unit)
    const per = parsePer(d.per)
    if (amount === null || per === null) continue
    // Only write the flag when it differs from the sliding default, so a config
    // carries `sliding:false` only for the fixed windows that need it.
    out.push({
      amount,
      unit: d.unit,
      per,
      perUnit: d.perUnit,
      ...(d.sliding ? {} : { sliding: false }),
    })
  }
  return out
}

/**
 * Stable serialization of a draft list, for dirty checks.
 *
 * Content, not object identity: every render rebuilds the draft objects, so an
 * identity check would always report "changed".
 */
export function draftsKey(drafts: readonly TypeDraft[]): string {
  return JSON.stringify(drafts)
}

/** [field, label, description] — the typed limit fields, with real schema keys. */
export const TYPE_META: Array<[string, string, string]> = [
  ['tpr', 'TPR · Token', '单次请求的 Token 上限，超过直接拒绝（不是窗口）'],
  ['concurrency', '并发', '同时进行的请求数'],
  ['firstByteSeconds', '首字节超时 · 秒', '等待响应首字节的最长时间'],
  ['totalSeconds', '总超时 · 秒', '整个请求（含流式 body）的最长时间'],
  ['rateLimitSeconds', '限流冷却 · 秒', '首次 429 冷却到本分钟结束；连续第 2 次用此值，第 3 次 5×，第 4 次起冷却到次日'],
  ['quotaExhaustedSeconds', '配额冷却 · 秒', '配额耗尽后的冷却时长'],
  ['defaultSeconds', '其他失败冷却 · 秒', '瞬时错误重试耗尽 / 确定性错误（400/403/404）后的冷却时长'],
]

/**
 * Which fields must have a value for a type to be usable.
 *
 * The prototype pre-filled every box from a defaults table. That is wrong for a
 * card the user just created: a prefilled request/token cap silently imposes a
 * limit they never asked for, and an empty box is the honest "unset" — the
 * schema treats every one of these as optional (`validatePreset` skips
 * undefined).
 *
 * Only the timeouts and cooldowns are pre-filled: without them a hung upstream
 * has nothing to time out and a 429/配额 response has no cooldown to back off
 * into, so the gateway would either hang forever or hammer an upstream that
 * already said no. The throughput limits stay empty, where empty means "no cap".
 */
export const TYPE_MANDATORY: ReadonlySet<string> = new Set([
  'firstByteSeconds',
  'totalSeconds',
  'rateLimitSeconds',
  'quotaExhaustedSeconds',
  'defaultSeconds',
])

/**
 * Values for the mandatory fields, taken from the backend's DEFAULT_PRESET so
 * the form and the gateway agree on what "unset" falls back to at runtime.
 */
export const MANDATORY_DEFAULTS: Record<string, number> = {
  firstByteSeconds: 30,
  totalSeconds: 600,
  rateLimitSeconds: 60,
  quotaExhaustedSeconds: 2592000,
  defaultSeconds: 60,
}

/** Draft list from a real config: one entry per preset, values from limits. */
export function draftFromConfig(config: LlmConfigShape | null): TypeDraft[] {
  if (!config) return []
  // A config written before the built-in default existed has no such row, yet
  // every unset key already resolves to it. Seed it so the effective default
  // is visible and editable instead of a silent constant.
  const entries = Object.entries(config.presets)
  if (!entries.some(([id]) => id === DEFAULT_PRESET_ID)) {
    entries.unshift([DEFAULT_PRESET_ID, { id: DEFAULT_PRESET_ID }])
  }
  return entries.map(([id, p]) => {
    const limits: Record<string, number | undefined> = {}
    TYPE_META.forEach(([field]) => {
      const v = (p as unknown as Record<string, unknown>)[field]
      if (typeof v === 'number') {
        limits[field] = v
        return
      }
      // Not in the config: pre-fill only the fields the gateway cannot run
      // without. Everything else stays undefined so the box renders empty.
      limits[field] = TYPE_MANDATORY.has(field) ? MANDATORY_DEFAULTS[field] : undefined
    })
    const customLimits: CustomLimitDraft[] = Array.isArray(p.customLimits)
      ? p.customLimits.map((l) => ({
          amount: String(l.amount),
          unit: l.unit,
          per: String(l.per),
          perUnit: l.perUnit,
          sliding: l.sliding !== false,
        }))
      : []
    // The fixed windows this card used to expose (qps/rpm/tpm/rpd/tpd) are read
    // as equivalent rows, so opening and saving migrates the preset instead of
    // silently dropping limits the gateway still enforces. The daily fields
    // (rpd/tpd) kept the UTC calendar-day reset, so they become fixed 24-hour
    // rows; the rest were already sliding windows.
    const legacy: Array<[number | undefined, CustomLimit['unit'], number, CustomLimit['perUnit'], boolean]> = [
      [p.qps, 'requests', 1, 'seconds', true],
      [p.rpm, 'requests', 1, 'minutes', true],
      [p.tpm, 'tokens', 1, 'minutes', true],
      [p.rpd, 'requests', 24, 'hours', false],
      [p.tpd, 'tokens', 24, 'hours', false],
    ]
    for (const [amount, unit, per, perUnit, sliding] of legacy) {
      if (typeof amount !== 'number' || !(amount > 0)) continue
      customLimits.push({ amount: String(amount), unit, per: String(per), perUnit, sliding })
    }
    return { name: id, limits, customLimits }
  })
}

/**
 * Write a draft list back into a config: rebuild `presets`, and remap every
 * reference when a card was renamed (otherwise keys point at a preset id the
 * server no longer knows — the save would succeed and silently drop limits).
 */
export function applyTypeDrafts(config: LlmConfigShape, drafts: TypeDraft[]): LlmConfigShape {
  const oldIds = Object.keys(config.presets)
  const kept = drafts.filter((d) => d.name.trim())
  const seen = new Set<string>()
  const uniq = kept.filter((d) => {
    const n = d.name.trim()
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })
  const presets: LlmConfigShape['presets'] = {}
  uniq.forEach((d) => {
    // Drop unset fields rather than writing `undefined`: the schema skips
    // undefined, so a preset with no request cap means "unlimited", and writing
    // the key explicitly would make that indistinguishable from a typo.
    const limits: Record<string, number> = {}
    Object.entries(d.limits).forEach(([field, v]) => {
      if (typeof v === 'number' && Number.isFinite(v)) limits[field] = v
    })
    // Half-filled custom rows stay in the form but are not persisted: an
    // incomplete limit has no meaning to the scheduler.
    const customLimits = completeCustomLimits(d.customLimits)
    presets[d.name.trim()] = {
      id: d.name.trim(),
      ...limits,
      ...(customLimits.length ? { customLimits } : {}),
    }
  })
  const renameMap = new Map<string, string>()
  drafts.forEach((d, i) => {
    const oldId = oldIds[i]
    // The built-in row is locked in the UI; ignore any rename that arrives
    // anyway rather than remapping every unset reference to a stray name.
    if (oldId === DEFAULT_PRESET_ID) return
    if (oldId && oldId !== d.name.trim()) renameMap.set(oldId, d.name.trim())
  })
  const providers = config.providers.map((p) => ({
    ...p,
    defaultPreset:
      p.defaultPreset && renameMap.has(p.defaultPreset) ? renameMap.get(p.defaultPreset) : p.defaultPreset,
    keys: p.keys.map((k) => ({
      ...k,
      preset: k.preset && renameMap.has(k.preset) ? renameMap.get(k.preset) : k.preset,
    })),
  }))
  return { ...config, presets, providers }
}

export function TypeCard(props: {
  draft: TypeDraft
  usage?: { providers: number; keys: number }
  onChange: (next: TypeDraft) => void
  onRemove?: () => void
  defaultOpen?: boolean
  /**
   * The built-in fallback type. It cannot be deleted or renamed: every
   * provider/key with no explicit preset resolves to it, so removing the row
   * would leave those references pointing at nothing while still displaying
   * as if they had a type.
   */
  locked?: boolean
}): React.JSX.Element {
  const [open, setOpen] = React.useState(props.defaultOpen ?? false)
  const { draft } = props
  const customLimits = draft.customLimits ?? []
  const patchCustom = (index: number, patch: Partial<CustomLimitDraft>): void => {
    props.onChange({
      ...draft,
      customLimits: customLimits.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    })
  }
  const removeCustom = (index: number): void => {
    props.onChange({ ...draft, customLimits: customLimits.filter((_, i) => i !== index) })
  }
  const usageHtml = props.usage ? (
    <span className="tc-usage">
      {props.usage.providers ? <span className="badge accent">{props.usage.providers} 个提供商默认使用</span> : null}
      {props.usage.keys ? <span className="badge gray">{props.usage.keys} 个 key 使用</span> : null}
    </span>
  ) : null

  return (
    <div className={`typecard ${open ? 'open' : ''}`}>
      <div className="tc-head" onClick={() => setOpen((o) => !o)}>
        {props.onRemove && !props.locked ? (
          <button
            type="button"
            className="btn ghost sm tc-del"
            style={{ padding: '2px 8px', color: 'var(--state-bad)' }}
            title="删除该类型"
            onClick={(e) => {
              e.stopPropagation()
              props.onRemove?.()
            }}
          >
            ✕
          </button>
        ) : null}
        <input
          type="text"
          className="tc-name"
          placeholder="类型名称（必填）"
          value={draft.name}
          readOnly={props.locked}
          title={props.locked ? '内置默认类型：不可重命名或删除' : undefined}
          style={props.locked ? { cursor: 'default', opacity: 0.85 } : undefined}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => props.onChange({ ...draft, name: e.target.value })}
        />
        {props.locked ? <span className="badge gray" title="未指定类型的 key 自动继承此类型">内置默认</span> : null}
        {usageHtml}
        <button type="button" className="tc-caret" aria-hidden tabIndex={-1}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
          </svg>
        </button>
      </div>
      <div className="tc-body">
        <div className="tgrid" style={{ paddingTop: 10 }}>
          {TYPE_META.map(([field, label, desc]) => (
            <div key={field}>
              <label>{label}</label>
              <input
                type="number"
                // An unset limit shows as an empty box, not 0 and not a
                // default: 0 would read as "zero requests allowed" and a
                // pre-filled default imposes a limit the user never chose.
                value={draft.limits[field] ?? ''}
                placeholder="不限"
                onChange={(e) => {
                  const raw = e.target.value
                  const next = raw === '' ? undefined : Number(raw)
                  props.onChange({ ...draft, limits: { ...draft.limits, [field]: next } })
                }}
              />
              <div className="desc">{desc}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="xs muted">限流窗口（可不填；填满一行才生效）</div>
        </div>
        {customLimits.map((limit, i) => (
          <div className="limrow" key={i}>
            <input
              type="text"
              inputMode="numeric"
              style={{ width: 88 }}
              placeholder={limit.unit === 'tokens' ? '数量 5M' : '数量'}
              title={limit.unit === 'tokens' ? 'Token 数量，可用 k / M 简写（5M = 5,000,000）' : '请求次数'}
              value={limit.amount}
              onChange={(e) => patchCustom(i, { amount: e.target.value })}
            />
            <select
              className="sm"
              value={limit.unit}
              onChange={(e) => patchCustom(i, { unit: e.target.value as CustomLimitDraft['unit'] })}
            >
              <option value="requests">次</option>
              <option value="tokens">Token</option>
            </select>
            <span className="lim-eq">每</span>
            <input
              type="number"
              min={1}
              placeholder="时长"
              value={limit.per}
              onChange={(e) => patchCustom(i, { per: e.target.value })}
            />
            <select
              className="sm"
              value={limit.perUnit}
              onChange={(e) => patchCustom(i, { perUnit: e.target.value as CustomLimitDraft['perUnit'] })}
            >
              <option value="seconds">秒</option>
              <option value="minutes">分</option>
              <option value="hours">时</option>
            </select>
            {/* Window kind is a choice, not a flag: an unlabelled switch hid the
                state entirely. Both options say what they do in their tooltip. */}
            <div
              className="limseg"
              role="group"
              title="滑动 = 最近 N 时间滚动窗口；UTC 边界 = 固定窗口，在周期 UTC 边界清零（24 小时 = UTC 0 点）"
            >
              <button
                type="button"
                className={limit.sliding !== false ? 'on' : ''}
                title="滑动窗口：最近 N 时间内滚动计算"
                onClick={() => patchCustom(i, { sliding: true })}
              >
                滑动
              </button>
              <button
                type="button"
                className={limit.sliding === false ? 'on' : ''}
                title="固定窗口：在周期 UTC 边界清零（24 小时 = UTC 0 点）"
                onClick={() => patchCustom(i, { sliding: false })}
              >
                UTC 边界
              </button>
            </div>
            <button
              type="button"
              className="btn ghost sm lim-del"
              title="删除这条限制"
              onClick={() => removeCustom(i)}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="skel"
          style={{ padding: 8, marginTop: 6 }}
          onClick={() =>
            props.onChange({
              ...draft,
              customLimits: [...customLimits, { amount: '', unit: 'requests', per: '', perUnit: 'minutes', sliding: true }],
            })
          }
        >
          ＋ 添加限制
        </button>
      </div>
    </div>
  )
}
