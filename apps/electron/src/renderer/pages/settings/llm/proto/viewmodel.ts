/**
 * View model: real gateway config + live status → the prototype's data shapes.
 *
 * The prototype renders from flat arrays (`PROVIDERS`, `KEYROWS`, `STRATEGIES`);
 * the real schema nests keys under providers and weights inside members. This
 * module is the single place that flattens one into the other, so the views can
 * stay a 1:1 port of the prototype's DOM without re-deriving state.
 *
 * Health derivation (display only, never stored):
 *   disabled ← !provider.enabled
 *   cool     ← enabled but every key is cooling or unavailable
 *   ok       ← anything else
 */

import type { GatewayStatus, LlmConfigShape, LlmKeyStateShape, LlmModelOptionsShape, ModelWindow, ProviderDetailShape, UsageOverview } from '../types'
import type { LlmUsageRecord } from '@craft-agent/shared/config'
import { resolvePresetId } from '../helpers'

export interface ProtoKeyRow {
  provider: string
  key: string
  id: string
  note: string
  /** Empty string = inherit the provider's default type (also a deleted type). */
  type: string
  enabled: boolean
  cool: boolean
  available: boolean
  coolReason?: 'rate' | 'quota'
  coolUntil?: number
  /** Daily request usage bar; undefined hides the minibar. */
  rpd?: { used: number; max: number }
}

export interface ProtoProvider {
  id: string
  name: string
  note: string
  url: string
  /**
   * Wire protocol the provider speaks. Shown on the detail header and edited
   * in the provider dialog — a mismatched protocol fails every request, so it
   * belongs where the user can see it.
   */
  protocol: string
  state: 'ok' | 'cool' | 'unavailable' | 'disabled'
  lastTest: string
  lastTestOk: boolean
  lastError: string
  defaultType: string
  quota: number
  windows: Record<string, ModelWindow>
  /** Per-model capability declarations, keyed by public model name. */
  modelOptions: Record<string, LlmModelOptionsShape>
  modelList: string[]
  keys: { avail: number; cool: number; unavailable: number; dis: number }
  keyRows: ProtoKeyRow[]
}

export interface ProtoStrategy {
  id: string
  name: string
  enabled: boolean
  type: string
  members: string[]
  models: string[]
  thinking: string
  sticky: boolean
  health: number
  cool: number
  weights: Record<string, number>
  /**
   * Switching units in evaluation order: the provider plus the model it
   * serves. A member without a model is a placeholder for "any model this
   * provider declares" and is shown with an empty `model`.
   */
  units: Array<{
    id: string
    provider: string
    providerName: string
    model: string
    upstreamModel: string
  }>
}

export interface ProtoLogRow {
  id: number
  ts: string
  tsMs: number
  provider: string
  key: string
  model: string
  /** Two outcomes only: a request that needed a retry still succeeded. */
  status: 'success' | 'failed'
  code: string | number
  /**
   * The gateway refused before contacting an upstream (no healthy account, no
   * route, every member outside its window). Such a row has no provider and no
   * upstream status, and must not be read as one.
   */
  local?: boolean
  p: number
  c: number
  fb: number
  dur: number
  session: string
  /**
   * Where the request came from: a session, or app-level work with none.
   *
   * Named `scope`, not `kind`: `kind` now means the request type
   * (对话 / 记忆 / 标题 …) everywhere else, and two different meanings for one
   * word in the same view is how a reader ends up reading the wrong one.
   */
  scope: 'session' | 'memory'
  /** Strategy group the request was routed through, '—' when none matches. */
  strategy: string
  error?: string
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

function fmtTs(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** ISO weekday (1=Mon…7=Sun) → prototype weekday (0=Sun…6=Sat). */
export function isoToProtoDay(iso: number): number {
  return iso % 7
}

export function protoToIsoDay(proto: number): number {
  return proto === 0 ? 7 : proto
}

/** Public model names for a provider (`models` maps upstream→public). */
function publicModels(models: Record<string, string> | undefined): string[] {
  if (!models) return []
  return Object.values(models).filter(Boolean)
}

export function gatewaySetupSteps(
  config: LlmConfigShape | null,
  providers: ProtoProvider[],
  strategies: ProtoStrategy[],
): [boolean, boolean, boolean] {
  const configuredProvider = providers.some((provider) =>
    provider.state !== 'disabled' &&
    provider.url.trim().length > 0 &&
    provider.keyRows.some((key) => key.enabled && key.key.trim().length > 0),
  )
  const providerTested = providers.some((provider) => provider.state !== 'disabled' && provider.lastTestOk)
  const defaultId = config?.defaultStrategy
  const defaultConfig = config?.strategies.find((strategy) => strategy.id === defaultId && strategy.enabled !== false)
  const defaultView = strategies.find((strategy) => strategy.id === defaultId && strategy.enabled)
  const defaultHasRoute = Boolean(defaultConfig && defaultView && defaultConfig.members.some((member) => {
    if (member.enabled === false) return false
    const providerConfig = config!.providers.find((provider) => provider.id === member.provider)
    const providerView = providers.find((provider) => provider.id === member.provider)
    if (!providerConfig || providerConfig.enabled === false || !providerView || providerView.state === 'disabled') return false
    if (!providerConfig.keys.some((key) => key.enabled !== false && key.key.trim().length > 0)) return false
    return Boolean(member.model || member.upstreamModel || providerView.modelList.length > 0 || Object.keys(defaultConfig.modelAliases ?? {}).length > 0)
  }))

  return [configuredProvider, providerTested, defaultHasRoute]
}

export function buildProviders(
  config: LlmConfigShape | null,
  status: GatewayStatus | null,
  keyStates: Map<string, LlmKeyStateShape>,
  details: Record<string, ProviderDetailShape>,
): ProtoProvider[] {
  if (!config) return []
  return config.providers.map((p) => {
    const modelList = publicModels(p.models)
    const keyRows: ProtoKeyRow[] = p.keys.map((k) => {
      const live = keyStates.get(`${p.id}/${k.id}`)
      const cooling = live?.cooling ?? false
      const gatewayReady = status?.running === true && status.enabled === true
      const available = p.enabled !== false && k.enabled !== false && gatewayReady && live?.available === true && !cooling
      const remainingMs = (live?.cooldownRemaining ?? 0) * 1000
      // Same chain the gateway uses, so the RPD bar reflects the limits that
      // actually apply when the key inherits or its own type was deleted.
      const presetId = resolvePresetId(config, p.defaultPreset, k.preset)
      const preset = config.presets[presetId]
      const detail = details[p.id]
      const detailKey = detail ? detail.keys.find((dk) => dk.keyId === k.id) : undefined
      const rpdMax = preset?.rpd
      return {
        provider: p.id,
        key: k.key,
        id: k.id,
        note: k.note ?? '',
        // A deleted type reads as "inherit" (empty), never as a dangling id the
        // picker cannot display — the gateway would ignore it and fall through
        // to the provider default anyway.
        type: k.preset && config.presets[k.preset] ? k.preset : '',
        enabled: k.enabled !== false,
        cool: p.enabled !== false && k.enabled !== false && gatewayReady && cooling,
        available,
        ...(p.enabled !== false && k.enabled !== false && gatewayReady && cooling
          ? { coolReason: 'rate' as const, coolUntil: Date.now() + remainingMs }
          : {}),
        ...(rpdMax && detailKey
          ? { rpd: { used: detailKey.requests, max: rpdMax } }
          : {}),
      }
    })
    const avail = keyRows.filter((k) => k.available).length
    const coolN = keyRows.filter((k) => k.cool).length
    const dis = keyRows.filter((k) => !k.enabled).length
    const unavailable = keyRows.filter((k) => k.enabled && !k.available && !k.cool).length
    // Only call the provider "all cooling" when every enabled, usable key is
    // actually cooling. A stopped gateway, rate-limited key, or missing live
    // status is unavailable — never counted as available or mislabeled cooling.
    const state: ProtoProvider['state'] = p.enabled === false
      ? 'disabled'
      : avail > 0
        ? 'ok'
        : coolN > 0 && unavailable === 0
          ? 'cool'
          : 'unavailable'
    const lastVerified = p.lastVerifiedAt ? new Date(p.lastVerifiedAt) : null
    const lastTest = lastVerified
      ? `${lastVerified.getMonth() + 1}-${lastVerified.getDate()} ${pad2(lastVerified.getHours())}:${pad2(lastVerified.getMinutes())} ${p.lastTestOk ? '测试成功' : '测试失败'}`
      : '从未测试'
    const lastError =
      p.lastTestOk === false && lastVerified ? '最近一次测试失败' : ''
    // windows: the real schema stores them keyed by public model name already
    const windows: Record<string, ModelWindow> = {}
    Object.entries(p.timeWindows ?? {}).forEach(([m, w]) => {
      windows[m] = w
    })
    // modelOptions: same keying, and dropped entries read as "unknown" — the
    // detail page shows an empty form rather than a wrong capability.
    const modelOptions: Record<string, LlmModelOptionsShape> = {}
    Object.entries(p.modelOptions ?? {}).forEach(([m, o]) => {
      modelOptions[m] = o
    })
    return {
      id: p.id,
      name: p.name,
      note: p.note ?? '',
      url: p.baseUrl,
      protocol: p.protocol,
      state,
      lastTest,
      lastTestOk: p.lastTestOk === true,
      lastError,
      defaultType: p.defaultPreset ?? '',
      quota: 0,
      windows,
      modelOptions,
      modelList,
      keys: { avail, cool: coolN, unavailable, dis },
      keyRows,
    }
  })
}

export function buildStrategies(
  config: LlmConfigShape | null,
  providers: ProtoProvider[],
): ProtoStrategy[] {
  if (!config) return []
  return config.strategies.map((s) => {
    const name = s.name ?? s.id
    const models = Object.keys(s.modelAliases ?? {})
    const weights: Record<string, number> = {}
    s.members.forEach((m) => {
      weights[m.provider] = m.weight ?? 1
    })
    const thinking = (s as { thinking?: string }).thinking ?? 'medium'
    return {
      id: s.id,
      name,
      enabled: s.enabled !== false,
      type: s.type,
      members: s.members.map((m) => m.provider),
      models,
      thinking,
      sticky: s.stickySession?.enabled !== false,
      health: 0,
      cool: 0,
      weights,
      units: (s.members ?? []).map((m) => {
        const provider = providers.find((p) => p.id === m.provider)
        const model = m.model ?? ''
        const upstreamModel = m.upstreamModel ?? model
        return {
          id: `${m.provider}::${upstreamModel || model}`,
          provider: m.provider,
          providerName: provider?.name ?? m.provider,
          model,
          upstreamModel,
        }
      }),
    }
  })
}

/** Flatten per-provider recent requests into one prototype-shaped log list. */
export function buildLogs(
  details: Array<{ provider: string; detail: ProviderDetailShape }>,
  keyLabel: (provider: string, keyId: string) => string = (_p, id) => id,
): ProtoLogRow[] {
  const rows: ProtoLogRow[] = []
  let id = 0
  details.forEach(({ provider, detail }) => {
    detail.recent.forEach((r) => {
      const status: ProtoLogRow['status'] = r.status === 'success' ? 'success' : 'failed'
      rows.push({
        id: id++,
        ts: fmtTs(r.startedAt ?? r.ts),
        tsMs: r.ts,
        provider,
        key: keyLabel(provider, r.keyId),
        model: r.model,
        status,
        code: r.statusCode ?? 0,
        p: r.promptTokens,
        c: r.completionTokens,
        fb: r.firstByteMs ?? 0,
        dur: r.totalMs ?? 0,
        session: r.sessionId ? r.sessionId : '—',
        scope: r.sessionId ? 'session' : 'memory',
        // The group that actually served it, not one inferred from
        // provider+model: two groups can carry the same pair, and a connection
        // probe carries none at all. `||` rather than `??` because a probe
        // stores an empty string, which must read as unattributed.
        strategy: r.strategy || '—',
        ...(r.error ? { error: r.error } : {}),
      })
    })
  })
  return rows.sort((a, b) => b.tsMs - a.tsMs)
}

/**
 * Rows that name no provider — the gateway refused before choosing one.
 *
 * The per-provider detail endpoint can never return these (it filters by
 * provider id), so a local refusal was invisible to the error aggregate: the
 * one failure whose cause is a *configuration* the user just changed. They come
 * from the raw log query instead.
 */
export function buildOrphanLogs(records: ReadonlyArray<LlmUsageRecord>): ProtoLogRow[] {
  return records
    .filter((r) => !r.provider)
    .map((r, i) => ({
      id: -1 - i,
      ts: fmtTs(r.startedAt ?? r.ts),
      tsMs: r.ts,
      provider: '—',
      key: r.keyId || '—',
      model: r.publicModel,
      status: 'failed' as const,
      code: r.statusCode ?? 0,
      p: r.promptTokens ?? 0,
      c: r.completionTokens ?? 0,
      fb: r.firstByteMs ?? 0,
      dur: r.totalMs ?? 0,
      session: r.sessionId ? r.sessionId : '—',
      scope: r.sessionId ? ('session' as const) : ('memory' as const),
      strategy: r.strategy || '—',
      local: true,
      ...(r.error ? { error: r.error } : {}),
    }))
    .sort((a, b) => b.tsMs - a.tsMs)
}

/**
 * RTK's own cumulative savings summary (`rtk gain --format json`).
 *
 * Not derived from the gateway's usage log: rtk measures the bytes it kept out
 * of the model's context before the request is ever built, so the number cannot
 * be reconstructed from token counts after the fact.
 */
export interface ProtoRtk {
  /** Whether the user has the toggle on. */
  enabled: boolean
  /** Whether a runnable rtk binary was found (bundled or on PATH). */
  installed: boolean
  version: string | null
  commands: number
  totalInput: number
  totalOutput: number
  totalSaved: number
  /** Share of input tokens rtk removed, 0..100. */
  savingsPct: number
}

/**
 * Assemble the RTK card from the three settings RPCs.
 *
 * `gain` is null whenever rtk is missing or its ledger is empty, which the card
 * has to distinguish from "savings really are zero" — the former means the
 * feature never ran, the latter just means it has not saved anything yet.
 */
export function buildRtk(
  enabled: boolean | undefined,
  status: { installed: boolean; version: string | null } | null | undefined,
  gain:
    | {
        totalCommands: number
        totalInput: number
        totalOutput: number
        totalSaved: number
        avgSavingsPct: number
      }
    | null
    | undefined,
): ProtoRtk {
  return {
    enabled: enabled !== false,
    installed: Boolean(status?.installed),
    version: status?.version ?? null,
    commands: gain?.totalCommands ?? 0,
    totalInput: gain?.totalInput ?? 0,
    totalOutput: gain?.totalOutput ?? 0,
    totalSaved: gain?.totalSaved ?? 0,
    savingsPct: gain ? Math.max(0, Math.min(100, gain.avgSavingsPct)) : 0,
  }
}

/** Usage-overview totals shaped into the prototype's KPI inputs. */
export interface ProtoKpis {
  tok: number
  tokIn: number
  tokOut: number
  req: number
  /** Requests that succeeded; `retried` is a subset of these, never additive. */
  ok: number
  retry: number
  sessions: number
  avgSessTok: number
  rate: number | null
  fail: number
  cacheRate: number | null
  cacheTokens: number
  fb: number | null
  fbP95: number | null
  quotaAvg: number
  sparkTok: number[]
  sparkReq: number[]
  sparkRate: number[]
  sparkCache: number[]
  sparkFb: number[]
}

/**
 * Sparkline series for the KPI cards, sliced to the selected range.
 *
 * Two bugs lived here. The series came from `overview.daily` unfiltered, so
 * "过去 24 小时" drew 90 points and the last one was the only nonzero — a flat
 * line with a flick at the end. And days with no traffic were given a 100%
 * success rate, which normalized to a perfectly straight line even when the
 * range did have failures in it.
 *
 * The prototype's sparklines are generated for the active range for the same
 * reason: a sparkline is a trend of *this* range, not of all time.
 */
export function buildSparks(
  overview: UsageOverview | null,
  days: number,
): { sparkTok: number[]; sparkReq: number[]; sparkRate: number[]; sparkCache: number[]; sparkFb: number[] } {
  // "过去 24 小时" is finer than a day: at day granularity the range collapses to
  // a single point and a sparkline needs at least two. `hourly` is the same
  // source the token chart uses, so the two agree.
  if (days === 1) {
    const hourly = overview?.hourly ?? []
    const sparkTok = hourly.map((h) => h.prompt + h.completion)
    const sparkReq = hourly.map((h) => h.success + h.failed)
    const sparkRate = hourly.map((h) => {
      const total = h.success + h.failed
      return total ? (h.success / total) * 100 : 0
    })
    const sparkCache = hourly.map((h) => h.cached ?? 0)
    const sparkFb = hourly.map((h) => h.failed)
    return {
      sparkTok: sparkTok.length > 1 ? sparkTok : [0, 0],
      sparkReq: sparkReq.length > 1 ? sparkReq : [0, 0],
      sparkRate: sparkRate.length > 1 ? sparkRate : [0, 0],
      sparkCache: sparkCache.length > 1 ? sparkCache : [0, 0],
      sparkFb: sparkFb.length > 1 ? sparkFb : [0, 0],
    }
  }
  const all = overview?.daily ?? []
  // Zero-fill to the range width, exactly like the token chart's axis.
  //
  // `daily` only carries days that have traffic, so a range whose traffic all
  // landed on one day produced a single-point series — and a sparkline of one
  // point is a flat line, which is what made the cards look broken next to a
  // chart that correctly showed the quiet days as zero.
  const width = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 90
  const byDay = new Map(all.map((d) => [d.day, d]))
  const today = new Date()
  const series = { sparkTok: [] as number[], sparkReq: [] as number[], sparkRate: [] as number[], sparkCache: [] as number[], sparkFb: [] as number[] }
  for (let i = width - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const hit = byDay.get(key)
    series.sparkTok.push((hit?.promptTokens ?? 0) + (hit?.completionTokens ?? 0))
    series.sparkReq.push((hit?.success ?? 0) + (hit?.failed ?? 0))
    const total = (hit?.success ?? 0) + (hit?.retried ?? 0) + (hit?.failed ?? 0)
    // A day with no requests has no rate. Reusing 100% here is what made the
    // card's line flat on a range whose traffic all landed on one day.
    series.sparkRate.push(total ? ((hit?.success ?? 0) / total) * 100 : 0)
    series.sparkCache.push(hit?.cachedTokens ?? 0)
    series.sparkFb.push(hit?.failed ?? 0)
  }
  return series
}

export function shouldShowGatewaySetup(steps: readonly boolean[], dismissed: boolean): boolean {
  return !dismissed && steps.some((done) => !done)
}

export function keyAvailabilitySegments(keys: ProtoProvider['keys']): Array<{
  id: 'available' | 'cooling' | 'unavailable' | 'disabled'
  label: string
  count: number
  color: string
}> {
  return ([
    { id: 'available', label: '可用', count: keys.avail, color: 'var(--state-ok)' },
    { id: 'cooling', label: '冷却', count: keys.cool, color: 'var(--state-warn)' },
    { id: 'unavailable', label: '暂不可用', count: keys.unavailable, color: 'var(--state-bad)' },
    { id: 'disabled', label: '禁用', count: keys.dis, color: 'var(--state-unknown)' },
  ] as const).filter((segment) => segment.count > 0)
}

export function buildKpis(
  overview: UsageOverview | null,
  _providerCount: number,
  rangeDays: number = Infinity,
  providerProtocols: Record<string, string> = {},
): ProtoKpis {
  const daily = overview?.daily ?? []
  const tok = overview?.totals.totalTokens ?? 0
  // `retried` counts successes that needed a retry, so it is already inside
  // `success` — adding it inflated the request count by the retry count.
  const ok = overview?.outcomes.success ?? 0
  const req = ok + (overview?.outcomes.failed ?? 0)
  const sessions = overview?.sessionCount ?? 0
  const rate = overview?.successRate ?? null
  const cacheTokens = overview?.totals.cachedTokens ?? 0
  // OpenAI's promptTokens already include cached tokens, whereas Anthropic's
  // promptTokens exclude them. Aggregate provider-specific denominators so the
  // cache-hit rate is accurate for mixed-protocol gateways too. Old overview
  // payloads without provider cache totals retain the legacy bounded fallback.
  const providerRows = overview?.byProvider ?? []
  const hasProviderCacheTotals = providerRows.length > 0 && providerRows.every((p) => typeof p.cachedTokens === 'number')
  const cacheBase = hasProviderCacheTotals
    ? providerRows.reduce((sum, p) => {
        const cached = p.cachedTokens ?? 0
        return sum + p.promptTokens + (providerProtocols[p.provider] === 'openai-completions' ? 0 : cached)
      }, 0)
    : (overview?.totals.promptTokens ?? 0) + cacheTokens
  const sparks = buildSparks(overview, rangeDays)
  return {
    tok,
    tokIn: Math.round(tok * 0.7),
    tokOut: tok - Math.round(tok * 0.7),
    req,
    ok,
    retry: overview?.outcomes.retried ?? 0,
    sessions,
    avgSessTok: sessions ? Math.round(tok / sessions) : 0,
    rate,
    fail: overview?.outcomes.failed ?? 0,
    cacheRate: cacheBase > 0 ? Math.min(100, Math.round((cacheTokens / cacheBase) * 1000) / 10) : null,
    cacheTokens,
    fb: overview?.firstByte.p50 ?? null,
    fbP95: overview?.firstByte.p95 ?? null,
    quotaAvg: 0,
    sparkTok: sparks.sparkTok,
    sparkReq: sparks.sparkReq,
    sparkRate: sparks.sparkRate,
    sparkCache: sparks.sparkCache,
    sparkFb: sparks.sparkFb,
  }
}
