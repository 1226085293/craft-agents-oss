/**
 * 日志 — request detail from the usage store.
 *
 * Reads through `llmGatewayQueryLogs` (tag filters, time order, hard cap applied
 * after filtering) instead of merging per-provider snapshots: the store knows
 * about the session log and the persisted day files, the view only renders.
 *
 * Filters that cannot be expressed as tags (成功 / 失败) are applied to the
 * returned rows — they are a narrowing view over at most 5000 matches, not a
 * second source of truth.
 */

import * as React from 'react'

import type { LlmUsageRecord, UsageTag, UsageTagField } from '@craft-agent/shared/config'
// Leaf module, not the `@craft-agent/shared/config` barrel: the barrel re-exports
// the usage store, which imports `paths.ts` and `os.homedir` — fatal in the
// renderer, where Vite externalizes node built-ins.
import { allKinds, kindLabel } from '@craft-agent/shared/config/model-request-kind'
import type { ProtoLogRow, ProtoProvider, ProtoStrategy } from './viewmodel'
import { Badge, fmt } from './atoms'
import { useProtoShell } from './state'
import {
  columnLimits,
  displayWidths,
  fillerWidth,
  HARD_MAX,
  HARD_MIN,
  letterSpacingWidth,
  monoTextWidth,
  reconcileWidths,
  WIDTH_RULE_VERSION,
} from './logWidths'
import type { ColumnMetrics, WidthLimits } from './logWidths'
import { DEFAULT_FILTER, filterLogs, logLevel, normalizeLevel } from './logFilters'
import type { LogsFilter } from './logFilters'
import { maskKeyHead } from '../helpers'
import { COLUMNS, normalizeColumns } from './logColumns'
import type { ColumnId } from './logColumns'

export { DEFAULT_FILTER }
export type { LogsFilter }

const COLUMNS_KEY = 'llm-proto.log-columns'
const TOUCHED_KEY = 'llm-proto.log-widths-touched'
const WIDTHS_KEY = 'llm-proto.log-widths'
const RULE_VERSION_KEY = 'llm-proto.log-widths-rule'

/**
 * Whether persisted widths were derived by the current measurement rules.
 *
 * Read before the width state initialises, and false when nothing was stored:
 * a first visit has no widths to invalidate.
 */
function widthsFromCurrentRule(): boolean {
  try {
    const raw = localStorage.getItem(RULE_VERSION_KEY)
    if (raw === null) return false
    return Number(raw) === WIDTH_RULE_VERSION
  } catch {
    return false
  }
}

/** Horizontal padding (8px each side) plus the 1px cell border plus slack. */
const CELL_PAD = 20

/**
 * A refusal the gateway made without contacting an upstream: no healthy
 * account, no route, a window that excludes every member.
 *
 * Such a row has no provider, no key and no upstream status. Showing its own
 * 503 made it indistinguishable from an upstream 503 — the one thing the log
 * must not do, since the two need opposite responses.
 */
function isLocalRefusal(r: LlmUsageRecord): boolean {
  return r.status === 'no_healthy_account'
}

/** One label per outcome, shared by the badge and the column measurement. */
const STATUS_TEXT = { success: '成功', failed: '失败' } as const

/**
 * What the 状态码 column shows for a row.
 *
 * A transport failure has no HTTP status at all, and a bare "—" in a column
 * called 状态码 reads as "the gateway forgot to record it" rather than "the
 * upstream never answered" — which is exactly the distinction an operator needs
 * (2026-10-25: three rows, one blank, reported as "一个没错误码"). Name the
 * failure instead of printing a dash.
 */
function codeText(r: LlmUsageRecord): string {
  if (isLocalRefusal(r)) return '本地'
  if (r.statusCode) return String(r.statusCode)
  const err = r.error ?? ''
  if (err.includes('first byte timeout')) return '超时'
  if (err.includes('transport error')) return '连接失败'
  return '—'
}

/**
 * Bounds for every column, measured with canvas instead of the DOM (a 5000-row
 * table would otherwise need 50k layout reads).
 *
 * `fit` comes from all rows: the default width should hold the widest value the
 * table contains, not just whatever happens to be on screen.
 *
 * `min` comes from `visibleRows` only — the rows the reader can actually see.
 * Taking it from the whole history was the bug behind "the minimum width is
 * narrower than the text": `min` is the floor of the drag, and a floor derived
 * from a row on page 300 (a short provider name, a short model) let the column
 * shrink to a width at which every row on the current page is truncated — model
 * measured 119px against a visible-page shortest of 238px, so the whole column
 * elided at its own minimum. The floor only has to guarantee what is on screen.
 */
function measureLimits(
  rows: ReadonlyArray<LlmUsageRecord>,
  visibleRows: ReadonlyArray<LlmUsageRecord>,
  providerName: (id: string) => string,
  keyLabel: (id: string) => string,
): Record<ColumnId, WidthLimits> {
  const canvas = document.createElement('canvas').getContext('2d')
  const out = {} as Record<ColumnId, WidthLimits>
  /**
   * The text a cell shows, or `null` when it shows a placeholder dash.
   *
   * Placeholders are reported as absent rather than as `'—'` so they cannot
   * define the column minimum: 45% of usage rows carry no key, and a 6px dash
   * dragged the Key column down to the 40px floor where the real values
   * (`sk-e8F…xR4z`, 68px) were all elided.
   */
  const textFor = (c: (typeof COLUMNS)[number], r: LlmUsageRecord): string | null => {
    switch (c.id) {
      case 'time':
        return stamp(r.startedAt ?? r.ts)
      case 'provider':
        return r.provider ? providerName(r.provider) : null
      case 'key':
        // Measure what is rendered (the masked key), not the stored id.
        return r.keyId ? keyLabel(r.keyId) : null
      case 'model':
        return r.upstreamModel || r.publicModel || null
      case 'code':
        // 0 means "no HTTP response" — see `codeText`. Every row has one.
        return codeText(r)
      case 'status':
        // The badge adds its own padding; 30px covers it.
        return `${STATUS_TEXT[logLevel(r)]}____`
      case 'tokens':
        return `${fmt(r.promptTokens ?? 0)} / ${fmt(r.completionTokens ?? 0)}`
      case 'firstByte':
        return r.firstByteMs != null ? `${r.firstByteMs}ms` : null
      case 'dur':
        return r.totalMs != null ? `${(r.totalMs / 1000).toFixed(1)}s` : null
      case 'session':
        return r.sessionId || null
      case 'strategy':
        return r.strategy || null
      case 'kind':
        return kindLabel(r.kind) || null
      default:
        return ''
    }
  }

  const typo = cellTypography()
  for (const c of COLUMNS) {
    // Same font the cell is rendered in: family and size both come from the
    // stylesheet (--font-mono / --font-sans, --text-xs / --text-md), so a theme
    // or CSS change cannot leave the measurement drifting from the paint.
    const font = c.mono ? typo.mono : c.small ? typo.small : typo.body
    if (canvas) canvas.font = font
    // Monospace columns need no per-value measurement: every ASCII glyph has the
    // same advance, so a value's width depends only on its length. Without this
    // the 时间 column alone contributed 5000 unique `measureText` calls on every
    // 3s tail poll (timestamps never repeat). `advanceSpread` disables the
    // shortcut when the resolved font is not really monospace; `monoTextWidth`
    // disables it per value for wide glyphs such as 连接失败.
    const advance = canvas && c.mono ? canvas.measureText('0').width : 0
    const spread =
      canvas && c.mono
        ? Math.max(
            Math.abs(canvas.measureText('W').width - advance),
            Math.abs(canvas.measureText('i').width - advance),
            Math.abs(canvas.measureText('.').width - advance),
          )
        : 0
    // Other columns repeat heavily (provider, status, model, key…), so their
    // measured widths are memoized per column. Bounded, and cleared when full
    // rather than frozen: a full memo that stops accepting entries would silently
    // go back to measuring every value.
    const memo = widthMemo(c.id)
    const width = (text: string): number => {
      // Letter-spacing is not part of a canvas advance (see letterSpacingWidth).
      const spacing = letterSpacingWidth(text, typo.letterSpacingPx)
      const mono = monoTextWidth(text, advance, spread)
      if (mono !== null) return mono + spacing
      const cached = memo.get(text)
      if (cached !== undefined) return cached + spacing
      const w = canvas ? canvas.measureText(text).width : text.length * 7
      if (memo.size >= WIDTH_MEMO_LIMIT) memo.clear()
      memo.set(text, w)
      return w + spacing
    }

    // The heading is `.tbl th` at --text-xs in the *sans* family, not in the
    // column's own font: `Key` is 21px there but only 18px in 11px mono, and the
    // 40px floor would then cut the title it promises never to truncate. Its own
    // font means it cannot share the column's memo or its monospace advance.
    const headerText = c.label
    const header =
      (canvas ? measureIn(canvas, typo.header, headerText) : headerText.length * 7) +
      letterSpacingWidth(headerText, typo.letterSpacingPx) +
      CELL_PAD
    const measure = (source: ReadonlyArray<LlmUsageRecord>): Array<number | null> => {
      const values: Array<number | null> = []
      for (const r of source) {
        const text = textFor(c, r)
        // A placeholder dash is not a value: measuring it would make `min` the
        // width of a dash (see textFor). Kept in the array so "this column has
        // no real value at all" still reads as "use the heading" rather than
        // "no rows".
        values.push(text === null ? null : width(text) + CELL_PAD)
      }
      return values
    }

    const all = measure(rows)
    // Same rows unless a filter or a page change moved the window; measuring
    // twice costs a full pass, so reuse when the sets are identical.
    const visibleValues = visibleRows === rows ? all : measure(visibleRows)
    if (!all.length) all.push(header)

    out[c.id] = columnLimits({
      header,
      values: all,
      floorValues: visibleValues.length ? visibleValues : all,
    } satisfies ColumnMetrics)
  }
  return out
}

/**
 * The fonts a cell is actually painted in.
 *
 * Hardcoding these was the bug: an `.xs` cell renders at --text-xs (11px), yet
 * measurement assumed 12px mono / 13px sans, so every bound was off by the ratio
 * between the two — and an 11px cell measured at 13px still reported a min above
 * its own text while a 13px cell measured at 12px reported one below. Reading the
 * resolved values keeps measurement and paint in step, including for themes that
 * change --font-mono.
 */
interface CellTypography {
  /** Font shorthand for a `.mono` cell. */
  mono: string
  /** Font shorthand for an `.xs` cell that is not monospace. */
  small: string
  /** Font shorthand for a regular (--text-md) cell. */
  body: string
  /** Font shorthand for a heading cell: `.tbl th` is --text-xs at weight 500. */
  header: string
  /** Resolved size of `.xs` cells, in px (letter-spacing is em-based). */
  smallPx: number
  /** Resolved size of regular cells, in px. */
  bodyPx: number
  /** Computed letter-spacing, in px per character, inherited from `.llm-proto`. */
  letterSpacingPx: number
}

/* Fallbacks mirror proto.css; they only apply before the page root is mounted. */
const FALLBACK_TYPOGRAPHY: CellTypography = {
  mono: '11px ui-monospace, "SF Mono", SFMono-Regular, Consolas, monospace',
  small: '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  body: '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  header: '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  smallPx: 11,
  bodyPx: 13,
  // `.llm-proto{letter-spacing:.01em}` at the 13px body size.
  letterSpacingPx: 0.13,
}

function px(value: string, fallback: number): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function cellTypography(): CellTypography {
  const root = document.querySelector('.llm-proto')
  if (!root) return FALLBACK_TYPOGRAPHY
  const cs = window.getComputedStyle(root)
  const varOf = (name: string): string => cs.getPropertyValue(name).trim()
  const sans = varOf('--font-sans') || FALLBACK_TYPOGRAPHY.small.split(' ').slice(1).join(' ')
  const monoFamily = varOf('--font-mono') || 'ui-monospace, monospace'
  const smallPx = px(varOf('--text-xs'), FALLBACK_TYPOGRAPHY.smallPx)
  const bodyPx = px(varOf('--text-md'), FALLBACK_TYPOGRAPHY.bodyPx)
  // `letter-spacing: .01em` resolves to an absolute px length in computed
  // style, so it is already per-character — no em conversion, and "normal"
  // parses to NaN which `px` turns back into the fallback ratio.
  const spacingPx = px(cs.letterSpacing, Number.NaN)
  return {
    mono: `${smallPx}px ${monoFamily}`,
    small: `${smallPx}px ${sans}`,
    body: `${bodyPx}px ${sans}`,
    header: `500 ${smallPx}px ${sans}`,
    smallPx,
    bodyPx,
    letterSpacingPx: Number.isFinite(spacingPx) ? spacingPx : 0,
  }
}

/**
 * `measureText` under a specific font, restoring the context's own font after:
 * the surrounding loop keeps one font set for the whole column and a measurement
 * in another font must not leak into it.
 */
function measureIn(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const prev = ctx.font
  ctx.font = font
  const w = ctx.measureText(text).width
  ctx.font = prev
  return w
}

/** Per-column text→width cache, shared across measurements. */
const widthMemos = new Map<ColumnId, Map<string, number>>()
/** Bounded so a very long history cannot grow the cache without limit. */
const WIDTH_MEMO_LIMIT = 20_000

function widthMemo(id: ColumnId): Map<string, number> {
  let memo = widthMemos.get(id)
  if (!memo) {
    memo = new Map()
    widthMemos.set(id, memo)
  }
  return memo
}

/**
 * Persisted widths, clamped to the sanity bounds on read. The fallback is the
 * floor only: the real default comes from the measured content, applied once
 * the rows arrive.
 */
function readWidths(): Record<ColumnId, number> {
  const out = Object.fromEntries(COLUMNS.map((c) => [c.id, HARD_MIN])) as Record<ColumnId, number>
  // Stored widths come from the previous rules: they are not user choices and
  // baking them in would keep the columns at widths this build no longer
  // measures. Start from the floor and let the rows decide `fit`.
  if (!widthsFromCurrentRule()) return out
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const c of COLUMNS) {
      const v = parsed[c.id]
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[c.id] = Math.min(HARD_MAX, Math.max(HARD_MIN, Math.round(v)))
      }
    }
  } catch {
    // Corrupt preference: defaults.
  }
  return out
}

/** Visible columns, persisted; unknown ids (including the removed unit column) are dropped. */
function readColumns(): ColumnId[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY)
    if (raw) return normalizeColumns(JSON.parse(raw) as unknown)
  } catch {
    // Corrupt preference: all columns.
  }
  return normalizeColumns(undefined)
}

/**
 * Fields offered by the tag composer. 提供商 and 状态 are deliberately absent:
 * both already have a dedicated dropdown, and a tag would silently fight it
 * (two AND-ed conditions on one dimension, with no way to see which won).
 */
const FIELD_OPTIONS: Array<{ value: UsageTagField | 'strategy'; label: string }> = [
  { value: 'any', label: '全部字段' },
  { value: 'key', label: 'Key' },
  { value: 'model', label: '模型' },
  { value: 'code', label: '状态码' },
  { value: 'session', label: '会话' },
]

const FIELD_LABEL: Record<string, string> = Object.fromEntries(FIELD_OPTIONS.map((f) => [f.value, f.label]))

interface Props {
  logs: ProtoLogRow[]
  providers: ProtoProvider[]
  strategies: ProtoStrategy[]
  filter: LogsFilter
  onFilter: (f: LogsFilter) => void
  onRefresh: () => void
  onOpenSession: (sid: string) => void
  onOpenErrorAgg: () => void
}

function stamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => `${n}`.padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function LogsView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const f = props.filter
  const [pageSize, setPageSize] = React.useState(10)
  const [page, setPage] = React.useState(1)
  // Row id (see `rowIds`), not the timestamp: several requests can share one
  // millisecond, and keying by time expanded every one of them at once.
  const [expanded, setExpanded] = React.useState<string | null>(null)
  // On by default: the log is now the single source the overview reads, so
  // watching it live is the normal way to use the page.
  const [tail, setTail] = React.useState(true)
  const [columns, setColumns] = React.useState<ColumnId[]>(readColumns)
  const [widths, setWidths] = React.useState<Record<ColumnId, number>>(readWidths)
  const [columnsOpen, setColumnsOpen] = React.useState(false)

  const [rows, setRows] = React.useState<LlmUsageRecord[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  // Labels only change when the *config* changes, but `providers` gets a new
  // array identity on every 2s status push (live key state). Keying on that
  // identity dragged the 5000-row width measurement along with it, so a push
  // that changed nothing visible still re-measured the whole table. Memoize on a
  // cheap signature of the parts the labels actually read.
  const labelKey = React.useMemo(
    () =>
      props.providers
        .map((p) => `${p.id}\u0000${p.name}\u0000${p.keyRows.map((k) => `${k.id}=${k.key}`).join(',')}`)
        .join('\u0001'),
    [props.providers],
  )
  const labels = React.useMemo(() => {
    const providerNames = new Map<string, string>()
    const keyNames = new Map<string, string>()
    for (const p of props.providers) {
      providerNames.set(p.id, p.name)
      for (const k of p.keyRows) if (k.key) keyNames.set(k.id, maskKeyHead(k.key))
    }
    return { providerNames, keyNames }
    // `labelKey` is the identity that matters; `providers` is the *content*
    // behind it and is deliberately not a dependency (see the comment above).
  }, [labelKey])

  const providerName = React.useCallback(
    (id: string): string => labels.providerNames.get(id) ?? id,
    [labels],
  )
  /**
   * Masked key for a usage row.
   *
   * The row stores the key *id*; the recognizable form is the key itself, so the
   * id is resolved through the provider list and masked the same way the
   * provider page masks it. Unknown id (config edited since) falls back to the
   * id rather than an empty cell.
   */
  const keyLabel = React.useCallback(
    (keyId: string): string => labels.keyNames.get(keyId) ?? keyId,
    [labels],
  )
  // Filtering and paging live here rather than further down because the visible
  // page is an *input* to the column bounds: `min` is the floor of the drag and
  // has to keep the rows on screen readable (see measureLimits).
  const list = React.useMemo(() => filterLogs(rows, f), [rows, f])
  const pages = Math.max(1, Math.ceil(list.length / pageSize))
  const cur = Math.min(page, pages)
  const slice = React.useMemo(
    () => list.slice((cur - 1) * pageSize, cur * pageSize),
    [list, cur, pageSize],
  )
  const limits = React.useMemo(
    () => measureLimits(rows, slice, providerName, keyLabel),
    [rows, slice, providerName, keyLabel],
  )
  // Requests carry the strategy id; the card should show its name.
  const strategyName = React.useCallback(
    (id: string | undefined): string | null => {
      if (!id || id === '—') return null
      return props.strategies.find((s) => s.id === id)?.name ?? id
    },
    [props.strategies],
  )

  // Columns the user dragged. Auto-fill must not hand slack back to them (that
  // would undo the drag the moment the pane has room), and the set is persisted
  // because a ref would forget it on reload.
  const [touched, setTouched] = React.useState<ColumnId[]>(() => {
    // Same reasoning as readWidths: a drag recorded under the old rules referred
    // to widths those rules computed, so honouring it would pin the column to a
    // number nobody chose.
    if (!widthsFromCurrentRule()) return []
    try {
      const raw = localStorage.getItem(TOUCHED_KEY)
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(arr) ? arr.filter((x): x is ColumnId => COLUMNS.some((c) => c.id === x)) : []
    } catch {
      return []
    }
  })

  // Reconcile the rendered widths with the data they have to hold.
  //
  // A column the user has not dragged always sits at its content width (`fit`).
  // This table is a tail — a poll every 3s brings new rows, so the widest value
  // changes on its own. Deciding the width once, on first mount, left every
  // column pinned to the value measured then: once `min` was computed from a
  // placeholder dash (see `measureLimits`) the pinned width was narrower than
  // the text and no amount of new data widened it back, which is exactly what
  // "the column minimum is smaller than the text" looked like on screen.
  //
  // A dragged column keeps the width the user chose, clamped to the range the
  // current data allows.
  React.useEffect(() => {
    // Before the rows arrive the limits only know the headings, so reconciling
    // now would throw away the user's widths (a 194px model column collapsing
    // to its 73px heading floor). Wait for real data.
    if (!rows.length) return
    setWidths((prev) =>
      reconcileWidths({ widths: prev, limits, touched, ids: COLUMNS.map((c) => c.id) }),
    )
  }, [limits, rows.length, touched])

  // Tag composer
  const [field, setField] = React.useState<UsageTagField | 'strategy'>('any')
  const [draft, setDraft] = React.useState('')

  const set = (patch: Partial<LogsFilter>): void => {
    props.onFilter({ ...f, ...patch })
    setPage(1)
  }

  // Only the free-text narrowing goes to the store as tags. The dropdowns are
  // applied to the returned rows by `filterLogs`, so what the UI says is
  // selected is exactly what the table shows. Provider is still sent as a tag
  // because it narrows the scan cheaply; `filterLogs` re-checks it exactly.
  const tags = React.useMemo<UsageTag[]>(() => {
    const out: UsageTag[] = [...f.tags]
    if (f.q.trim()) out.push({ field: 'any', value: f.q.trim() })
    if (f.provider !== 'all') out.push({ field: 'provider', value: f.provider })
    return out
  }, [f.tags, f.q, f.provider])

  // Bumped by the tail timer; part of the query effect's deps so polling
  // actually re-reads the log instead of only refreshing the parent's cards.
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    const id = window.setTimeout(() => {
      void window.electronAPI
        .llmGatewayQueryLogs?.({ tags, sort: f.sort, limit: 5000 })
        .then((res) => {
          if (cancelled || !res) return
          setRows(res.rows)
          setTruncated(res.truncated)
        })
        .catch(() => {
          // Keep the rows on screen: a failed poll must not blank the log.
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [tags, f.sort, tick])

  // Tail: re-query this table on the same cadence as the status push.
  React.useEffect(() => {
    if (!tail) return
    const id = window.setInterval(() => setTick((n) => n + 1), 3000)
    return () => window.clearInterval(id)
  }, [tail])

  React.useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns))
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
      localStorage.setItem(TOUCHED_KEY, JSON.stringify(touched))
      // Stamped only once the widths on disk are the ones this build computed.
      localStorage.setItem(RULE_VERSION_KEY, String(WIDTH_RULE_VERSION))
    } catch {
      // Preference only.
    }
  }, [columns, widths, touched])

  const visible = COLUMNS.filter((c) => columns.includes(c.id))

  // Fill the pane: leftover space goes to columns that still have headroom
  // (max - width); a column never grows past its content width. Whatever is
  // still left becomes the trailing filler cell.
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const [containerW, setContainerW] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth))
    ro.observe(el)
    setContainerW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Leftover space becomes one trailing filler cell: the table still spans the
  // card (no visual gap) while every data column stays within its content max.
  const visibleIds = React.useMemo(() => visible.map((c) => c.id), [visible])
  const display = React.useMemo(
    () => displayWidths({ widths, limits, ids: visibleIds, touched, containerW }),
    [widths, limits, visibleIds, touched, containerW],
  )
  /**
   * A stable id per row for React keys and for "which row is expanded".
   *
   * Records carry no id, and `ts` alone is not unique — concurrent requests can
   * finish in the same millisecond, which used to open several detail rows on
   * one click. The occurrence counter disambiguates without depending on the
   * row's position: a new record arriving at the top must not renumber the
   * others, or the expanded row would jump to a different request.
   */
  const rowIds = React.useMemo(() => {
    const counts = new Map<string, number>()
    const ids = new Map<LlmUsageRecord, string>()
    for (const r of rows) {
      const base = `${r.ts}|${r.provider ?? ''}|${r.keyId ?? ''}|${r.status}|${r.statusCode}`
      const n = (counts.get(base) ?? 0) + 1
      counts.set(base, n)
      ids.set(r, `${base}#${n}`)
    }
    return ids
  }, [rows])

  const tableWidth = visible.reduce((sum, c) => sum + display[c.id], 0)
  const spacer = fillerWidth(display, visibleIds, containerW)

  // Content that does not fit its column is left-aligned; centred otherwise.
  // Measured after layout because CSS cannot compare content width to the cell.
  //
  // Two passes on purpose: `scrollWidth` forces a layout, and interleaving that
  // read with a class write per cell forced one layout per cell (hundreds of
  // them on a 10-row table). All reads first, then all writes — one layout.
  // The key is content-derived rather than `slice` (a fresh array every render),
  // so an unrelated re-render does not re-run the sweep at all.
  const pageKey = slice.map((r) => `${r.ts}:${r.statusCode}`).join('|')
  React.useLayoutEffect(() => {
    const cells = document.querySelectorAll<HTMLElement>('.llm-proto table.logtbl td[data-cell]')
    const overflowing: Array<[HTMLElement, boolean]> = []
    cells.forEach((td) => {
      overflowing.push([td, td.scrollWidth > td.clientWidth + 1])
    })
    for (const [td, over] of overflowing) td.classList.toggle('over', over)
  }, [pageKey, widths, columns, f.sort])


  const lastDown = React.useRef<{ id: ColumnId | null; t: number }>({ id: null, t: 0 })

  // Double-click a divider: drop that column back to its content width and let
  // the filler cell / headroom redistribution re-take the slack.
  const resetWidth = (id: ColumnId): void => {
    setTouched((prev) => prev.filter((x) => x !== id))
    setWidths((prev) => ({ ...prev, [id]: limits[id]?.fit ?? prev[id] }))
  }

  const startResize = (id: ColumnId, e: React.PointerEvent): void => {
    // Double-click detection lives here rather than in onDoubleClick:
    // preventDefault() on pointerdown suppresses the compatibility mouse
    // events, so a real dblclick never reaches the element.
    const now = Date.now()
    const again = lastDown.current.id === id && now - lastDown.current.t < 350
    lastDown.current = { id, t: now }
    if (again) {
      lastDown.current = { id: null, t: 0 }
      resetWidth(id)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const l = limits[id]
    if (!l) return
    const startX = e.clientX
    // Freeze the current layout into explicit widths first so the drag only
    // ever affects the column being dragged.
    const frozen: Record<ColumnId, number> = { ...widths }
    for (const c of visible) frozen[c.id] = Math.round(display[c.id])
    const startW = frozen[id]
    const move = (ev: PointerEvent): void => {
      // Floor = the shortest value (or the heading, if wider): narrower than
      // that and even one row truncates. Ceiling = 1.5x the longest value, the
      // headroom the user is allowed to spend; the table overflows and scrolls
      // rather than squeezing its neighbours.
      const next = Math.min(l.max, Math.max(l.min, startW + ev.clientX - startX))
      setTouched((prev) => (prev.includes(id) ? prev : [...prev, id]))
      setWidths({ ...frozen, [id]: Math.round(next) })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addTag = (): void => {
    const value = draft.trim()
    if (!value) return
    if (f.tags.some((t) => t.field === field && t.value.toLowerCase() === value.toLowerCase())) {
      setDraft('')
      return
    }
    set({ tags: [...f.tags, { field: field as UsageTagField, value }] })
    setDraft('')
  }

  return (
    <>
      <div className="page-title">日志</div>
      <div className="page-desc">网关请求明细：标签过滤、状态、提供商、会话</div>

      <div className="sticky card">
        <div className="spread" style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {/* Column picker */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn sm"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => setColumnsOpen((v) => !v)}
            >
              {`列 (${columns.length}/${COLUMNS.length})`}
            </button>
            {columnsOpen ? (
              <div
                className="card colpop"
                onMouseLeave={() => setColumnsOpen(false)}
              >
                {COLUMNS.map((c) => (
                  <label key={c.id} className="row small" style={{ gap: 6, padding: '3px 0', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={columns.includes(c.id)}
                      onChange={(e) =>
                        setColumns((prev) =>
                          e.target.checked ? COLUMNS.map((x) => x.id).filter((id) => id === c.id || prev.includes(id)) : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>

          {/* Tag composer */}
          <div className="row" style={{ flex: 1, minWidth: 260, gap: 6 }}>
            <select
              className="sm"
              value={field}
              onChange={(e) => setField(e.target.value as UsageTagField | 'strategy')}
              style={{ width: 96, flexShrink: 0 }}
            >
              {FIELD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="输入后回车添加标签…"
              style={{ flex: 1, minWidth: 120 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addTag()
                } else if (e.key === 'Backspace' && !draft && f.tags.length > 0) {
                  set({ tags: f.tags.slice(0, -1) })
                }
              }}
            />
          </div>

          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <select className="sm" value={normalizeLevel(f.level)} onChange={(e) => set({ level: e.target.value as LogsFilter['level'] })}>
              <option value="all">全部状态</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
            </select>
            <select className="sm" value={f.provider} onChange={(e) => set({ provider: e.target.value })}>
              <option value="all">全部提供商</option>
              {props.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="sm" value={f.strategy} onChange={(e) => set({ strategy: e.target.value })}>
              <option value="all">全部策略组</option>
              {props.strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {/* One option per kind in the registry. An option that can never
                match a row reads as a broken filter, which is why the registry
                only lists kinds that something actually emits. */}
            <select className="sm" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
              <option value="all">全部类型</option>
              {allKinds().map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn sm"
              style={{
                padding: '4px 10px',
                fontSize: 12,
                ...(tail ? { color: 'var(--state-ok)', borderColor: 'var(--state-ok)' } : {}),
              }}
              onClick={() => {
                const next = !tail
                setTail(next)
                if (next) {
                  set({ sort: 'desc' })
                  // Read immediately rather than after the first 3s tick.
                  setTick((n) => n + 1)
                  props.onRefresh()
                  shell.toast('实时日志已开启')
                } else {
                  shell.toast('实时日志已关闭')
                }
              }}
            >
              {tail ? '● 实时' : '实时'}
            </button>
            <button type="button" className="btn sm" style={{ padding: '4px 10px', fontSize: 12 }} onClick={props.onOpenErrorAgg}>
              错误聚合
            </button>
          </div>
        </div>

        {f.tags.length > 0 || f.q ? (
          <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
            <span className="xs muted">筛选：</span>
            {f.q ? (
              <span className="badge accent">
                {`全部: ${f.q}`}
                <button type="button" className="linkbtn" style={{ color: 'inherit', marginLeft: 4 }} onClick={() => set({ q: '' })}>
                  ✕
                </button>
              </span>
            ) : null}
            {f.tags.map((t, i) => (
              <span key={`${t.field}:${t.value}:${i}`} className="badge accent">
                {`${FIELD_LABEL[t.field] ?? t.field}: ${t.value}`}
                <button
                  type="button"
                  className="linkbtn"
                  style={{ color: 'inherit', marginLeft: 4 }}
                  onClick={() => set({ tags: f.tags.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* `clip`: the card's rounded corners must survive horizontal scrolling —
          whichever column ends up at the edge is square-cornered. */}
      <div className="card clip" style={{ marginTop: 12, padding: 0 }}>
        <div ref={wrapRef} style={{ overflowX: 'auto' }}>
          <table className="tbl logtbl" style={{ width: tableWidth + spacer }}>
            <colgroup>
              {visible.map((c) => (
                <col key={c.id} style={{ width: display[c.id] }} />
              ))}
              <col style={{ width: spacer }} />
            </colgroup>
            <tbody>
              <tr>
                {visible.map((c) =>
                  c.id === 'time' ? (
                    <th
                      key={c.id}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title={f.sort === 'desc' ? '点击切换为时间正序' : '点击切换为时间倒序'}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-surface-muted)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = ''
                      }}
                      onClick={() => set({ sort: f.sort === 'desc' ? 'asc' : 'desc' })}
                    >
                      {`时间 ${f.sort === 'desc' ? '↓' : '↑'}`}
                      <span className="col-resizer" onPointerDown={(e) => startResize(c.id, e)} />
                    </th>
                  ) : (
                    <th key={c.id}>
                      {c.label}
                      <span
                        className="col-resizer"
                        onPointerDown={(e) => startResize(c.id, e)}
                        title="拖动调整宽度，双击恢复内容宽度"
                      />
                    </th>
                  ),
                )}
                <th className="log-spacer" aria-hidden />
              </tr>
              {slice.length ? (
                slice.map((l) => {
                  const provName = props.providers.find((p) => p.id === l.provider)?.name ?? l.provider
                  const key = rowIds.get(l) ?? String(l.ts)
                  // The badge and the 状态 dropdown read the same classification.
                  const level = logLevel(l)
                  const st = (
                    <Badge kind={level === 'failed' ? 'red' : 'green'}>
                      {STATUS_TEXT[level]}
                    </Badge>
                  )
                  return (
                    <React.Fragment key={key}>
                      <tr className="rowclick" title={l.error} onClick={() => setExpanded(expanded === key ? null : key)}>
                        {visible.map((c) => {
                          switch (c.id) {
                            case 'time':
                              return <td key={c.id} data-cell className="mono xs">{stamp(l.startedAt ?? l.ts)}</td>
                            case 'provider':
                              // A local refusal names no provider: nothing was
                              // contacted. An empty cell reads as missing data,
                              // so say so the same way the other columns do.
                              return (
                                <td key={c.id} data-cell>
                                  {provName || <span className="muted">—</span>}
                                </td>
                              )
                            case 'key':
                              // The masked key, not its id: `mvm0ausb3` is a
                              // config label nobody recognises, while
                              // `sk-e8F…xR4z` is the key the user can match
                              // against the provider page. The id stays in the
                              // tooltip for the same reason.
                              return (
                                <td
                                  key={c.id}
                                  data-cell
                                  className="mono xs"
                                  title={l.keyId ? `Key ${l.keyId}` : undefined}
                                >
                                  {l.keyId ? keyLabel(l.keyId) : <span className="muted">—</span>}
                                </td>
                              )
                            case 'model':
                              return <td key={c.id} data-cell>{l.upstreamModel || l.publicModel}</td>
                            case 'code':
                              // A refusal the gateway made itself has no upstream
                              // status. Printing its own 503 invited debugging the
                              // provider for a window the user configured.
                              return isLocalRefusal(l) ? (
                                <td key={c.id} data-cell className="mono xs" title="本地拒绝：未向上游发出请求">
                                  <span className="muted">本地</span>
                                </td>
                              ) : (
                                <td key={c.id} data-cell className="mono xs" title={l.error ?? undefined}>
                                  {l.statusCode ? String(l.statusCode) : <span className="muted">{codeText(l)}</span>}
                                </td>
                              )
                            case 'status':
                              return <td key={c.id} data-cell>{st}</td>
                            case 'tokens':
                              return (
                                <td key={c.id} data-cell className="num xs" title={`Prompt ${fmt(l.promptTokens ?? 0)} · Completion ${fmt(l.completionTokens ?? 0)}`}>
                                  {fmt(l.promptTokens ?? 0)}
                                  <span className="faint"> / </span>
                                  {fmt(l.completionTokens ?? 0)}
                                </td>
                              )
                            case 'firstByte':
                              return <td key={c.id} data-cell className="num xs">{l.firstByteMs != null ? `${l.firstByteMs}ms` : '—'}</td>
                            case 'dur':
                              return <td key={c.id} data-cell className="num xs">{l.totalMs != null ? `${(l.totalMs / 1000).toFixed(1)}s` : '—'}</td>
                            case 'strategy':
                              return (
                                <td key={c.id} data-cell className="xs">
                                  {strategyName(l.strategy) ?? <span className="muted">—</span>}
                                </td>
                              )
                            case 'kind':
                              // Rows written before the column existed, and
                              // clients that do not declare a kind, have none:
                              // an em dash reads better than a blank cell.
                              return (
                                <td key={c.id} data-cell className="xs">
                                  {l.kind ? (
                                    kindLabel(l.kind)
                                  ) : (
                                    <span className="muted">—</span>
                                  )}
                                </td>
                              )
                            case 'session':
                              return (
                                <td key={c.id} data-cell className="xs">
                                  {l.sessionId ? (
                                    <button
                                      type="button"
                                      className="linkbtn"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        props.onOpenSession(l.sessionId!)
                                      }}
                                    >
                                      {l.sessionId}
                                    </button>
                                  ) : (
                                    <span className="muted">—</span>
                                  )}
                                </td>
                              )
                            default:
                              return <td />
                          }
                        })}
                        <td className="log-spacer" aria-hidden />
                      </tr>
                      {expanded === key ? (
                        <tr>
                          <td
                            colSpan={visible.length + 1}
                            className="xs detail"
                            style={{
                              background: l.status !== 'success' ? 'var(--state-bad-soft)' : 'var(--color-surface-muted)',
                              color: l.status !== 'success' ? 'var(--state-bad)' : 'var(--color-text-muted)',
                            }}
                          >
                            {l.error ? `⚠ ${l.error} · ` : ''}
                            {`策略组 ${strategyName(l.strategy) ?? '—'} · 模型 ${l.publicModel || l.upstreamModel} → ${l.upstreamModel} · 尝试 ${l.attempts ?? 1} 次`}
                            {l.trace?.length ? ` · ${l.trace.join(' → ')}` : ''}
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={visible.length + 1} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                    {loading ? '读取中…' : '没有匹配的日志'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="spread" style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>
          <span className="xs muted">
            {`共 ${list.length} 条${truncated ? '（已达 5000 条上限，请用标签收窄）' : ''} · 第 ${cur}/${pages} 页`}
          </span>
          <div className="row">
            <span className="xs muted">每页</span>
            <select
              className="sm"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value))
                setPage(1)
              }}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
            <button type="button" className="btn sm" style={{ padding: '4px 10px', fontSize: 12 }} disabled={cur <= 1} onClick={() => setPage(cur - 1)}>
              上一页
            </button>
            <button type="button" className="btn sm" style={{ padding: '4px 10px', fontSize: 12 }} disabled={cur >= pages} onClick={() => setPage(cur + 1)}>
              下一页
            </button>
          </div>
        </div>
      </div>
      <div className="xs faint" style={{ marginTop: 8 }}>
        点击任意行展开明细；点击「会话」查看该会话的请求与 token 汇总
      </div>
    </>
  )
}
