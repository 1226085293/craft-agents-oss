/**
 * 总览 (overview) — a port of the prototype's `vOverview()`:
 * onboarding card, KPI row, token chart, recent errors, session ranking,
 * key availability, provider health table.
 *
 * All numbers come from `llmGatewayGetUsage` (server-filtered per range);
 * the prototype's fake series generators are intentionally not carried over.
 */

import * as React from 'react'

import type { LlmConfigShape, UsageOverview } from '../types'
import { gatewaySetupSteps, keyAvailabilitySegments, shouldShowGatewaySetup } from './viewmodel'
import type { ProtoKpis, ProtoLogRow, ProtoProvider, ProtoRtk, ProtoStrategy } from './viewmodel'
import { Badge, Dot, Minibar, Spark, fmt } from './atoms'
import { useProtoShell } from './state'

const RANGE_META: Record<string, string> = {
  day: '过去 24 小时',
  week: '过去 7 天',
  month: '过去 30 天',
  all: '全部 90 天',
}

export type RangeKey = 'day' | 'week' | 'month' | 'all'

/** One column of the token chart. */
interface TokenBar {
  key: string
  /** Axis label under the column; empty for columns that stay unlabelled. */
  label: string
  p: number
  c: number
}

/** Calendar days each non-hourly range spans. */
const RANGE_DAYS: Record<RangeKey, number> = { day: 1, week: 7, month: 30, all: 90 }

/**
 * Chart geometry — carried over from the prototype's `chartHtml()`.
 *
 * Base column width is what makes a range look like its range: 24 hours need
 * wide columns to stay readable, 90 days need narrow ones to fit. The single
 * hardcoded `1 0 24px` every range used before is why "全部 90 天" looked like
 * "过去 7 天" apart from the column count.
 */
const BASE_W: Record<RangeKey, number> = { day: 30, week: 24, month: 16, all: 8 }
/**
 * Axis labels to keep at 1x. Zoom multiplies the column count, so the kept
 * labels must be divided by it or they overlap.
 */
const BASE_SHOW: Record<RangeKey, number> = { day: 2, week: 1, month: 5, all: 10 }
/** Every range zooms to at most 2x — past that a column is wider than the card. */
const MAX_ZOOM: Record<RangeKey, number> = { day: 2, week: 2, month: 2, all: 2 }
const ZOOMABLE = (r: RangeKey): boolean => MAX_ZOOM[r] > 1

/**
 * HTML-escape for the one place this view emits markup as a string.
 *
 * The tooltip is the only `dangerouslySetInnerHTML` here, and its inputs are
 * gateway-generated strings (a model or session id can contain anything), so
 * escaping is mandatory rather than defensive.
 */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/**
 * The chart's x-axis, fixed by the selected range and zero-filled.
 *
 * `day` plots the last 24 hours; the longer ranges plot one column per calendar
 * day. Padding matters: rendering only the days that happen to have traffic
 * made "过去 7 天" look like a single day. Zoom multiplies the bucket count
 * (never the CSS scale), so "全部 90 天" at 2x is 180 half-day buckets.
 */
function buildTokenAxis(
  range: RangeKey,
  zoom: number,
  overview: { daily?: Array<{ day: string; promptTokens: number; completionTokens: number }>; hourly?: Array<{ hour: number; prompt: number; completion: number }> } | null,
): TokenBar[] {
  const z = ZOOMABLE(range) ? zoom : 1
  if (range === 'day') {
    // 24 hours × z buckets per hour: the server sends one row per hour, so a
    // zoomed hour is split into z equal slices rather than invented — the
    // totals stay truthful.
    const hourly = overview?.hourly
    if (!hourly || hourly.length === 0) return []
    const out: TokenBar[] = []
    hourly.forEach((h) => {
      const p = Math.floor(h.prompt / z)
      const c = Math.floor(h.completion / z)
      for (let k = 0; k < z; k++) {
        const start = h.hour + k / z
        const hh = Math.floor(start)
        const mm = Math.floor((start - hh) * 60)
        const from = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
        const endTotal = start + 1 / z
        const eh = Math.floor(endTotal)
        const em = Math.floor((endTotal - eh) * 60)
        const to = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
        out.push({
          key: `h${h.hour}.${k}`,
          label: k === 0 ? `${String(hh).padStart(2, '0')}:00` : '',
          p,
          c,
        })
      }
    })
    return out
  }

  const days = RANGE_DAYS[range]
  const byDay = new Map((overview?.daily ?? []).map((d) => [d.day, d]))
  const out: TokenBar[] = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const hit = byDay.get(key)
    // A day splits into z buckets, so the same traffic occupies a wider axis at
    // 2x instead of the columns simply getting wider. Without this, zoom only
    // stretched the columns and the shape of the trend never changed.
    const p = Math.floor((hit?.promptTokens ?? 0) / z)
    const c = Math.floor((hit?.completionTokens ?? 0) / z)
    for (let k = 0; k < z; k++) {
      out.push({
        key: `${key}.${k}`,
        label: k === 0 ? key.slice(5) : '',
        p,
        c,
      })
    }
  }
  return out
}
export const KPI_DEFS: Record<
  string,
  {
    label: string
    val: (k: ProtoKpis) => string
    sub: (k: ProtoKpis) => string
    spark: (k: ProtoKpis) => [number[] | null, string | undefined]
    cls?: (k: ProtoKpis) => string
  }
> = {
  tok: {
    label: '总 Token',
    val: (k) => fmt(k.tok),
    sub: (k) => `↑ ${fmt(k.tokIn)} in · ↓ ${fmt(k.tokOut)} out`,
    spark: (k) => [k.sparkTok, undefined],
  },
  req: {
    label: '请求数',
    val: (k) => k.req.toLocaleString('en-US'),
    sub: (k) => `重试 ${k.retry} · 会话 ${k.sessions} · 平均 ${fmt(k.avgSessTok)}`,
    spark: (k) => [k.sparkReq, undefined],
  },
  rate: {
    label: '成功率',
    // `successRate` arrives as a 0..1 ratio (see `rate()` in llm-usage-aggregate),
    // so it must be scaled before the % sign — printing the raw value showed
    // "1%" for a perfect run and graded every range as rate-bad.
    val: (k) => (k.rate == null ? '—' : Math.round(k.rate * 1000) / 10 + '%'),
    cls: (k) => (k.rate == null ? '' : k.rate >= 0.95 ? 'rate-ok' : k.rate >= 0.8 ? 'rate-warn' : 'rate-bad'),
    sub: (k) => `失败 ${k.fail}`,
    spark: (k) => [k.sparkRate, 'var(--state-ok)'],
  },
  cache: {
    label: '缓存复用',
    val: (k) => (k.cacheRate == null ? '—' : k.cacheRate + '%'),
    sub: (k) => `缓存复用 ${fmt(k.cacheTokens)} tokens`,
    spark: (k) => [k.sparkCache, 'var(--color-accent)'],
  },
  fb: {
    label: '首字节',
    val: (k) => (k.fb == null ? '—' : Math.round(k.fb) + 'ms'),
    sub: (k) => (k.fbP95 == null ? 'p95 —' : `p95 ${Math.round(k.fbP95)}ms`),
    // No sparkline: the daily buckets carry no first-byte measurement, and the
    // prototype's line here was generated noise. A card that cannot show a
    // trend is better off not drawing one than drawing fiction.
    spark: () => [null, 'var(--state-ok)'],
  },
  quota: {
    label: '配额消耗',
    val: (k) => k.quotaAvg + '%',
    sub: () => '提供商平均',
    spark: (k) => [k.sparkRate, 'var(--state-warn)'],
  },
  sessions: {
    label: '会话数',
    val: (k) => String(k.sessions),
    sub: (k) => `平均 ${fmt(k.avgSessTok)} tokens / 会话`,
    spark: (k) => [k.sparkReq, undefined],
  },
}

const RANGE_NAMES: Array<[RangeKey, string]> = [
  ['day', '日'],
  ['week', '周'],
  ['month', '月'],
  ['all', '全部'],
]

interface Props {
  config: LlmConfigShape | null
  overview: UsageOverview | null
  kpis: ProtoKpis
  providers: ProtoProvider[]
  strategies: ProtoStrategy[]
  logs: ProtoLogRow[]
  /** RTK's own savings ledger; null when the settings channel is unavailable. */
  rtk: ProtoRtk | null
  range: RangeKey
  onRange: (r: RangeKey) => void
  kpiConfig: string[]
  onKpiConfig: (i: number, id: string) => void
  onOpenSession: (sid: string) => void
  onSeeAllErrors: () => void
}

export function OverviewView(props: Props): React.JSX.Element {
  const [onboardVisible, setOnboardVisible] = React.useState(true)
  const shell = useProtoShell()
  const { kpis, providers, logs, range, overview } = props

  const rangeMs = range === 'day' ? 864e5 : range === 'week' ? 7 * 864e5 : range === 'month' ? 30 * 864e5 : Infinity
  const nowTs = Date.now()
  const inRange = (l: ProtoLogRow): boolean => nowTs - l.tsMs <= rangeMs

  const stepStates = gatewaySetupSteps(props.config, providers, props.strategies)
  const steps: Array<{ t: string; done: boolean; go: () => void }> = [
    { t: '添加提供商', done: stepStates[0], go: () => shell.go('providers') },
    { t: '探测模型并测试连接', done: stepStates[1], go: () => shell.go('providers') },
    { t: '设置默认策略组', done: stepStates[2], go: () => shell.go('strategies') },
  ]
  const doneCount = steps.filter((s) => s.done).length
  const showOnboarding = shouldShowGatewaySetup(steps.map((step) => step.done), !onboardVisible)

  // Token chart. The axis is fixed by the range, not by the data: a range with
  // one busy day used to render one column, which reads as a broken chart
  // rather than as a quiet week.
  const [zoom, setZoom] = React.useState(1)
  // Changing range resets zoom: 1x of "过去 24 小时" is not the same density as
  // 1x of "全部 90 天", and carrying the multiplier over made the ranges feel
  // like one another.
  const prevRange = React.useRef<RangeKey>(range)
  React.useEffect(() => {
    if (prevRange.current !== range) {
      prevRange.current = range
      setZoom(1)
    }
  }, [range])

  const axis = React.useMemo(() => buildTokenAxis(range, zoom, overview), [range, zoom, overview])
  const max = Math.max(...axis.map((b) => b.p + b.c), 1)
  const bw = BASE_W[range]
  const chartBars = axis.map((b) => {
    const ph = b.p > 0 ? Math.max(1, Math.round((b.p / max) * 102)) : 0
    const ch = b.c > 0 ? Math.max(1, Math.round((b.c / max) * 102)) : 0
    return (
      <div
        key={b.key}
        className="bcol"
        style={{ flex: `1 0 ${bw}px` }}
        data-date={b.key}
        data-p={b.p}
        data-c={b.c}
        data-t={b.p + b.c}
        data-label={b.label}
      >
        <div style={{ height: ph, background: 'var(--chart-prompt)' }} />
        <div style={{ height: ch, background: 'var(--chart-completion)' }} />
      </div>
    )
  })
  // Keep ~BASE_SHOW labels at 1x; zoom multiplies columns, so divide by it.
  const labEvery = Math.max(1, Math.ceil(axis.length / Math.max(1, BASE_SHOW[range] * zoom)))
  const chartLabs = axis.map((b, i) => (
    <div key={b.key} className="lcell" style={{ flex: `1 0 ${bw}px` }}>
      {i % labEvery === 0 ? b.label : ''}
    </div>
  ))

  /* ---- chart interaction (the prototype's chartWheel/chartDown/chartMove) ---- */

  // A column set wider than the card means the axis overflows and can be
  // panned; below that the cursor stays normal and dragging does nothing.
  const scrollable = axis.length * (bw + 3) > 700
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const panRef = React.useRef<{ x: number; left: number } | null>(null)
  const [tip, setTip] = React.useState<{ x: number; y: number; html: string } | null>(null)

  // Wheel = zoom, like the prototype. `passive: false` is the only way to keep
  // preventDefault working in React, so this one listener is native.
  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!ZOOMABLE(range) || e.shiftKey) return
      e.preventDefault()
      setZoom((z) => {
        const nz = z + (e.deltaY < 0 ? 1 : -1)
        return nz < 1 || nz > MAX_ZOOM[range] ? z : nz
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [range])

  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Panning wins over hovering: while dragging the columns under the cursor
    // change constantly and the tooltip would flicker.
    if (panRef.current) {
      const el = wrapRef.current
      if (el) el.scrollLeft = panRef.current.left - (e.clientX - panRef.current.x)
      return
    }
    const col = (e.target as HTMLElement).closest('.bcol') as HTMLElement | null
    if (!col) {
      if (tip) setTip(null)
      return
    }
    const p = Number(col.dataset.p ?? 0)
    const c = Number(col.dataset.c ?? 0)
    const date = range === 'day' ? '' : (col.dataset.date ?? '').split('.')[0]
    // `data-hour` only carries a value for the hourly range, where the label is
    // a clock time rather than a date — printing it for the day ranges repeated
    // the date ("2026-10-22 10-22").
    const hour = range === 'day' ? (col.dataset.label ?? '') : ''
    // Same three-part body as the prototype: date, then ↑ prompt · ↓ completion
    // · 合计. Clamped so the tip never leaves the viewport.
    const html =
      `<b>${esc(date)}${hour ? ` ${esc(hour)}` : ''}</b>` +
      `<span style="color:#b9b9f8">↑ ${fmt(p)}</span> · ` +
      `<span style="color:#8f8ff8">↓ ${fmt(c)}</span> · 合计 ${fmt(p + c)}`
    const x = Math.min(Math.max(e.clientX + 14, 8), window.innerWidth - 220)
    const y = Math.max(e.clientY - 56, 8)
    if (!tip || tip.x !== x || tip.y !== y || tip.html !== html) setTip({ x, y, html })
  }

  const onDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!scrollable) return
    if ((e.target as HTMLElement).closest('.chart-zoom')) return
    panRef.current = { x: e.clientX, left: wrapRef.current?.scrollLeft ?? 0 }
    e.currentTarget.style.cursor = 'grabbing'
  }

  const onUp = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!panRef.current) return
    panRef.current = null
    e.currentTarget.style.cursor = scrollable ? 'grab' : 'default'
  }

  const onLeave = (): void => {
    panRef.current = null
    setTip(null)
    const el = wrapRef.current
    if (el) el.style.cursor = scrollable ? 'grab' : 'default'
  }

  const errorRows = logs.filter((l) => l.status !== 'success' && inRange(l)).sort((a, b) => b.tsMs - a.tsMs).slice(0, 4)
  const sessRank = React.useMemo(() => {
    const m = new Map<string, { id: string; tok: number; req: number; fail: number }>()
    logs.forEach((l) => {
      if (l.scope !== 'session' || !inRange(l) || l.session === '—') return
      const o = m.get(l.session) ?? { id: l.session, tok: 0, req: 0, fail: 0 }
      o.tok += l.p + l.c
      o.req++
      if (l.status !== 'success') o.fail++
      m.set(l.session, o)
    })
    return [...m.values()].sort((a, b) => b.tok - a.tok).slice(0, 5)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, range])

  return (
    <>
      <div className="page-title">LLM 管理</div>
      <div className="page-desc">多上游路由、密钥池与用量</div>

      {showOnboarding ? (
        <div className="card" style={{ borderColor: 'var(--color-accent)' }}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <b style={{ fontSize: 13 }}>三步启用网关</b>
              <span className="xs muted">{`已完成 ${doneCount}/${steps.length}`}</span>
            </div>
            <button
              type="button"
              className="btn ghost sm"
              style={{ padding: '2px 8px' }}
              onClick={() => setOnboardVisible(false)}
            >
              ✕
            </button>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((s, i) => (
              <div key={s.t} className="row spread" style={{ padding: '2px 0' }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={`ostep ${s.done ? 'done' : ''}`}>{s.done ? '✓' : i + 1}</span>
                  <span className={`small ${s.done ? 'muted' : ''}`} style={s.done ? { textDecoration: 'line-through' } : undefined}>
                    {s.t}
                  </span>
                </div>
                {s.done ? (
                  <Badge kind="green">已完成</Badge>
                ) : (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ padding: '2px 10px', fontSize: 12 }}
                    onClick={s.go}
                  >
                    去完成
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="spread" style={{ marginBottom: 14, marginTop: showOnboarding ? 14 : 0 }}>
        <div className="sec-title" style={{ margin: 0 }}>用量总览</div>
        <div className="seg">
          {RANGE_NAMES.map(([r, name]) => (
            <button
              key={r}
              type="button"
              className={range === r ? 'on' : ''}
              aria-pressed={range === r}
              onClick={() => props.onRange(r)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        {props.kpiConfig.map((id, i) => {
          const d = KPI_DEFS[id] ?? KPI_DEFS.tok
          const [ptsArr, color] = d.spark(kpis)
          const cls = d.cls ? ' ' + d.cls(kpis) : ''
          return (
            <div key={id + i} className="card kpi">
              <div className="lab">{d.label}</div>
              <div className={`val${cls}`}>{d.val(kpis)}</div>
              <div className="sub">{d.sub(kpis)}</div>
              {ptsArr ? <Spark values={ptsArr} color={color} /> : null}
            </div>
          )
        })}
      </div>

      {/* RTK is not a gateway metric: it shrinks Bash output before the request
          is built, so its savings never appear in the token log. Reading them
          from rtk's own ledger is the only way the card can be non-zero. */}
      {props.rtk ? (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="spread">
            <b style={{ fontSize: 13 }}>
              RTK 输出压缩
              <span className="xs muted" style={{ fontWeight: 400 }}>（rtk 自身统计 · 全部时间）</span>
            </b>
            {!props.rtk.installed ? (
              <Badge kind="amber">未安装 rtk</Badge>
            ) : !props.rtk.enabled ? (
              <Badge kind="gray">已关闭</Badge>
            ) : (
              <Badge kind="green">{props.rtk.version ? `v${props.rtk.version}` : '已启用'}</Badge>
            )}
          </div>
          <div className="row" style={{ marginTop: 12, gap: 32, alignItems: 'flex-end' }}>
            <div style={{ minWidth: 0 }}>
              <div className="xs muted">累计节省</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {fmt(props.rtk.totalSaved)}
                <span className="xs muted" style={{ fontWeight: 400 }}> tokens</span>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="xs muted">压缩率</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>
                {props.rtk.commands ? `${props.rtk.savingsPct.toFixed(1)}%` : '—'}
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="xs muted">命中命令</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{props.rtk.commands}</div>
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <Minibar pct={props.rtk.savingsPct} tone={props.rtk.savingsPct >= 50 ? 'ok' : 'warn'} />
              <div className="xs faint" style={{ marginTop: 6 }}>
                {`输入 ${fmt(props.rtk.totalInput)} → 输出 ${fmt(props.rtk.totalOutput)} tokens`}
              </div>
            </div>
          </div>
          {!props.rtk.installed || !props.rtk.enabled ? (
            <div className="xs muted" style={{ marginTop: 10 }}>
              {props.rtk.installed
                ? 'RTK 已关闭：在 设置 → 性能 中开启后，Bash 输出会被压缩后再交给模型。'
                : '未找到 rtk 可执行文件：Bash 输出不会被压缩。'}
            </div>
          ) : props.rtk.commands === 0 ? (
            <div className="xs muted" style={{ marginTop: 10 }}>
              还没有被压缩的命令：只有能被 rtk 改写的 Bash 命令才会进入这张卡。
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="stack" style={{ marginTop: 12 }}>
        <div className="card">
          <b style={{ fontSize: 13 }}>
            Token 用量<span className="xs muted" style={{ fontWeight: 400 }}>{`（${RANGE_META[range]}）`}</span>
          </b>
          <div style={{ marginTop: 12 }}>
            {axis.length ? (
              <div className="chart-outer">
                <div
                  className="chart-wrap"
                  ref={wrapRef}
                  style={{ cursor: scrollable ? 'grab' : 'default' }}
                  onMouseMove={onMove}
                  onMouseLeave={onLeave}
                  onMouseDown={onDown}
                  onMouseUp={onUp}
                >
                  <div className="chart-scroll">
                    <div className="chart-bars">{chartBars}</div>
                    <div className="chart-labs">{chartLabs}</div>
                  </div>
                </div>
                {/* Hover panel. A native `title` was unreadable here: it takes
                    ~1s to appear, shows no ↑/↓ split, and follows the OS theme
                    instead of the card. The prototype's positioned tip is what
                    the design calls for. */}
                {tip ? (
                  <div className="chart-tip show" style={{ left: tip.x, top: tip.y }} dangerouslySetInnerHTML={{ __html: tip.html }} />
                ) : null}
                {ZOOMABLE(range) ? (
                  <div className="chart-zoom">
                    <button type="button" title="缩小" disabled={zoom === 1} onClick={() => setZoom(zoom - 1)}>
                      −
                    </button>
                    <span style={{ width: 20, textAlign: 'center' }}>{zoom}x</span>
                    <button type="button" title="放大" disabled={zoom >= MAX_ZOOM[range]} onClick={() => setZoom(zoom + 1)}>
                      ＋
                    </button>
                    {zoom > 1 ? (
                      <button type="button" onClick={() => setZoom(1)}>
                        重置
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div
                className="xs muted"
                style={{ height: 132, display: 'grid', placeItems: 'center' }}
              >
                暂无用量数据
              </div>
            )}
          </div>
        </div>

        <div className="grid2">
          <div className="card">
            <div className="spread">
              <b style={{ fontSize: 13 }}>
                最近异常<span className="xs muted" style={{ fontWeight: 400 }}>{`（${RANGE_META[range]}）`}</span>
              </b>
              <button type="button" className="btn ghost sm" style={{ padding: '2px 8px', fontSize: 12 }} onClick={props.onSeeAllErrors}>
                查看全部
              </button>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {errorRows.length ? (
                errorRows.map((l) => (
                  <div key={l.id} className="row spread small">
                    <span className="row" style={{ gap: 8 }}>
                      <Badge kind={l.status === 'failed' ? 'red' : 'amber'}>{String(l.code)}</Badge>
                      <span className="mono xs">{l.model}</span>
                      <span className="xs muted">{l.provider}</span>
                    </span>
                    <span className="xs faint">{l.ts}</span>
                  </div>
                ))
              ) : (
                <span className="xs muted">最近没有失败请求</span>
              )}
            </div>
          </div>
          <div className="card">
            <div className="spread">
              <b style={{ fontSize: 13 }}>会话 Token 排行</b>
              <span className="xs faint">{`Top 5 · ${RANGE_META[range]}`}</span>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sessRank.length ? (
                sessRank.map((o) => (
                  <div key={o.id} className="row spread small">
                    <button type="button" className="linkbtn mono xs" onClick={() => props.onOpenSession(o.id)}>
                      {o.id}
                    </button>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="num xs">{fmt(o.tok)}</span>
                      <span className="xs faint">{o.req} 次</span>
                      {o.fail ? <Badge kind="red">{o.fail} 失败</Badge> : null}
                    </span>
                  </div>
                ))
              ) : (
                <span className="xs muted">暂无会话日志</span>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="spread">
            <b style={{ fontSize: 13 }}>Key 可用性</b>
            <span className="xs muted">点击行进入详情</span>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {providers.map((p) => {
              const segments = keyAvailabilitySegments(p.keys)
              const summary = [
                `${p.keys.avail} 可用`,
                `${p.keys.cool} 冷却`,
                `${p.keys.unavailable} 暂不可用`,
                `${p.keys.dis} 禁用`,
              ].join(' · ')
              return (
                <div
                  key={p.id}
                  className="availrow spread"
                  style={{ cursor: 'pointer' }}
                  title={summary}
                  onClick={() => shell.gotoDetail(p.id)}
                >
                  <span style={{ width: 120 }}>{p.name}</span>
                  <span className="avail" role="img" aria-label={segments.length ? segments.map((s) => `${s.count} ${s.label}`).join('、') : '无 Key'}>
                    {segments.map((segment) => (
                      <span
                        key={segment.id}
                        title={`${segment.count} ${segment.label}`}
                        style={{ flex: segment.count, background: segment.color }}
                      />
                    ))}
                  </span>
                  <span className="xs muted">{summary}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="card">
          <div className="spread">
            <b style={{ fontSize: 13 }}>提供商健康</b>
            <span className="xs muted">点击行进入详情</span>
          </div>
          <table className="tbl" style={{ marginTop: 6 }}>
            <tbody>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>请求</th>
                <th>Token</th>
                <th>冷却 key</th>
              </tr>
              {providers.map((p) => {
                const usage = (overview?.byProvider ?? []).find((b) => b.provider === p.id)
                const stateLabel = p.state === 'ok' ? '正常' : p.state === 'cool' ? '全部冷却' : p.state === 'unavailable' ? '暂不可用' : '禁用'
                const dotc = p.state === 'ok' ? 'green' : p.state === 'cool' ? 'amber' : p.state === 'unavailable' ? 'red' : 'gray'
                return (
                  <tr key={p.id} className="rowclick" onClick={() => shell.gotoDetail(p.id)}>
                    <td>{p.name}</td>
                    <td>
                      <Dot color={dotc as 'green' | 'amber' | 'red' | 'gray'} /> {stateLabel}
                    </td>
                    <td>{usage?.requests ?? 0}</td>
                    <td>{fmt(usage?.totalTokens ?? 0)}</td>
                    <td>{p.keys.cool}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
