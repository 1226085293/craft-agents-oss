/**
 * Column sizing for the log table.
 *
 * Rules (all measured in the same unit — CSS pixels including the cell's 8px
 * horizontal padding on each side):
 *
 *   min = the column's shortest *real* value, never narrower than its heading
 *         (a truncated heading is worse than a truncated value). Shrinking to
 *         the min therefore always keeps at least one row fully readable.
 *         Placeholder cells (a row with no provider, no key, …) are ignored:
 *         they render a dash, and a dash is narrow enough to drag the whole
 *         column down to the floor where even short real values no longer fit.
 *   max = the column's longest value — a column wider than its widest cell is
 *         pure wasted space, so this is a hard ceiling for the drag as well.
 *
 * When every value in a column has the same length min == max and the column is
 * fixed: there is no width in between that truncates some rows and not others.
 *
 * The table may also be narrower than its container. Rather than stretching a
 * column past its content max, the leftover goes to columns that still have
 * headroom; if none do it becomes one trailing filler cell, so the table still
 * spans the card without padding a data column. Columns the user dragged are
 * excluded from that redistribution — otherwise handing slack back would undo
 * the drag on the very next render.
 *
 * Kept free of React and the DOM so the arithmetic can be unit tested.
 */

export interface WidthLimits {
  /** Narrowest the column may go: its shortest value, floored by its heading. */
  min: number
  /** Exactly wide enough for the longest value — the default width. */
  fit: number
  /** Widest the column may go: MAX_SLACK x fit. */
  max: number
}

/** How much air a column is allowed beyond its widest value. */
export const MAX_SLACK = 1.5

/**
 * Width of `text` from a monospace advance — or `null` when that shortcut must
 * not be used.
 *
 * A monospace font gives every ASCII glyph the same advance, so the width of a
 * value depends only on its length. That is what makes the 时间 column free to
 * measure: timestamps never repeat, so a per-value cache never hits and every
 * 3s tail poll re-measured 5000 strings.
 *
 * Two cases break the shortcut, and both must fall back to real measurement:
 *
 *   - Non-ASCII glyphs. `本地` / `超时` / `连接失败` live in a monospace column,
 *     but a CJK glyph is two advances wide, not one. Counting characters
 *     therefore reported half their width and left 状态码 able to shrink below
 *     its own shortest value.
 *   - A fallback font that is not actually monospace. If the requested family is
 *     missing, the browser substitutes a proportional one and `length x advance`
 *     is merely a guess. Detected by passing the advances of a few glyphs whose
 *     widths differ in any proportional font.
 */
export function monoTextWidth(text: string, advance: number, advanceSpread = 0): number | null {
  if (!(advance > 0)) return null
  // `advanceSpread` is the measured difference between glyphs of different
  // natural widths (0 for a genuine monospace font).
  if (advanceSpread > 0.01) return null
  for (let i = 0; i < text.length; i++) {
    // 0x7e = '~': the whole printable ASCII range shares one advance.
    if (text.charCodeAt(i) > 0x7e) return null
  }
  return text.length * advance
}

/**
 * Extra pixels the browser adds on top of the glyph advances.
 *
 * The page sets `letter-spacing:.01em` and cells inherit it, while
 * `CanvasRenderingContext2D.measureText` knows nothing about letter-spacing.
 * Small per character, but a 40-character model name adds ~5px, which is more
 * than the slack CELL_PAD leaves — so a column measured to its exact text width
 * still elided the value.
 *
 * `spacingPx` is the *computed* letter-spacing: an inherited `em` value is
 * resolved against the parent's font-size and inherited as an absolute length,
 * so it is already per-character for every descendant.
 */
export function letterSpacingWidth(text: string, spacingPx: number): number {
  if (!(spacingPx > 0)) return 0
  return text.length * spacingPx
}

export interface ColumnMetrics {
  /** Rendered width of the heading, padding included. */
  header: number
  /**
   * Rendered width of every cell value, padding included.
   *
   * `null` means the row carries no value for this column and renders a
   * placeholder dash. Those rows are excluded from both bounds: a dash is the
   * narrowest thing a column can hold, so letting one define `min` collapsed the
   * 状态码/Key/提供商 columns to the 40px floor while every real value stayed
   * truncated — 45% of usage rows have no key, so that was most of them.
   */
  values: ReadonlyArray<number | null>
  /**
   * Values that set the floor, when that is a narrower set than `values` — the
   * rows currently on screen. Defaults to `values`.
   *
   * `min` is the width the drag stops at, so deriving it from the whole history
   * made it a floor for rows the reader cannot see: a short model name on page
   * 300 set `min` to 119px, and dragging there truncated all ten rows on screen
   * (shortest of which needed 238px). The floor only has to protect what is
   * visible; `fit` still covers everything.
   */
  floorValues?: ReadonlyArray<number | null>
}

/** Absolute sanity bounds, only to survive corrupt stored values. */
export const HARD_MIN = 40
export const HARD_MAX = 800

export function columnLimits(metrics: ColumnMetrics): WidthLimits {
  const { header, values, floorValues } = metrics
  let longest = 0
  let measured = 0
  for (const v of values) {
    if (v === null) continue
    measured++
    if (v > longest) longest = v
  }

  // The floor and the default answer different questions, so they may be drawn
  // from different rows: `fit` must hold every value in the table, while `min`
  // only has to keep the rows the reader can see from being clipped.
  const floor = floorValues ?? values
  let shortest = Number.POSITIVE_INFINITY
  let floorMeasured = 0
  for (const v of floor) {
    if (v === null) continue
    floorMeasured++
    if (v < shortest) shortest = v
  }

  // No rows at all: the heading is all there is to go on.
  if (!measured) longest = header
  // No visible row carries a value: fall back to what the whole table needs, so
  // the floor never ends up below a real value by accident.
  if (!floorMeasured) shortest = measured ? Math.min(...values.filter((v): v is number => v !== null)) : header

  const min = Math.min(HARD_MAX, Math.max(HARD_MIN, Math.ceil(header), Math.ceil(shortest)))
  const fit = Math.min(HARD_MAX, Math.max(min, Math.ceil(longest)))
  const max = Math.min(HARD_MAX, Math.max(fit, Math.round(fit * MAX_SLACK)))
  return { min, fit, max }
}

export interface DisplayWidthsInput {
  /** Explicit (stored) widths. */
  widths: Readonly<Record<string, number>>
  limits: Readonly<Record<string, WidthLimits>>
  /** Visible column ids, in render order. */
  ids: ReadonlyArray<string>
  /** Ids the user has dragged; they never receive auto-fill slack. */
  touched: ReadonlyArray<string>
  /** Width available for the table, 0 while unmeasured. */
  containerW: number
}

/**
 * The widths actually rendered: the stored ones, plus whatever slack the
 * container has room for — never past a column's content width. The 1.5x max is
 * reserved for the drag: auto layout stops at fit so nothing is padded on first
 * paint.
 */
export function displayWidths(input: DisplayWidthsInput): Record<string, number> {
  const { widths, limits, ids, touched, containerW } = input
  const out: Record<string, number> = { ...widths }
  if (!containerW || !ids.length) return out

  const sum = ids.reduce((acc, id) => acc + (widths[id] ?? 0), 0)
  if (containerW <= sum) return out

  const headroom = ids.map((id) => {
    if (touched.includes(id)) return 0
    const limit = limits[id]
    if (!limit) return 0
    return Math.max(0, limit.fit - (widths[id] ?? 0))
  })
  const totalHead = headroom.reduce((a, b) => a + b, 0)
  if (totalHead <= 0) return out

  const take = Math.min(containerW - sum, totalHead)
  ids.forEach((id, i) => {
    const head = headroom[i] ?? 0
    if (head > 0) out[id] = (widths[id] ?? 0) + (take * head) / totalHead
  })
  return out
}

export interface ReconcileInput {
  /** Stored width per column id. */
  widths: Readonly<Record<string, number>>
  /** Current bounds per column id. */
  limits: Readonly<Record<string, WidthLimits>>
  /** Ids the user dragged by hand. */
  touched: ReadonlyArray<string>
  /** Column ids to reconcile, in render order. */
  ids: ReadonlyArray<string>
}

/**
 * The width each column should actually have, given the data it has to hold.
 *
 * Two rules, and the difference between them is the whole point:
 *
 *   - Dragged by hand: keep the user's choice, clamped to the current range.
 *   - Never dragged: sit exactly at `fit`, the content width.
 *
 * The second rule has to be re-evaluated whenever the data changes, not once on
 * mount. This table is a tail — a poll every 3s appends rows, so `fit` moves on
 * its own. Pinning a column to the width measured at mount left it too narrow
 * for text that arrived later, which reads on screen as "the minimum width is
 * smaller than the text".
 *
 * A stored width is *not* a user choice unless its column appears in `touched`: the
 * store also holds whatever the previous measurement rules computed, and those
 * values are indistinguishable from a drag once persisted. That is how a column
 * could stay pinned at an old, too-narrow width forever — 54px, exactly the old
 * heading floor — so a rule change has to invalidate them (`WIDTH_RULE_VERSION`),
 * not merely recompute on top of them.
 */
export function reconcileWidths(input: ReconcileInput): Record<string, number> {
  const { widths, limits, touched, ids } = input
  const out: Record<string, number> = { ...widths }
  for (const id of ids) {
    const limit = limits[id]
    if (!limit) continue
    const target = touched.includes(id)
      ? Math.min(limit.max, Math.max(limit.min, widths[id] ?? limit.fit))
      : limit.fit
    if (target !== widths[id]) out[id] = target
  }
  return out
}

/**
 * Bumped whenever the measurement rules change in a way that makes previously
 * stored widths wrong.
 *
 * Persisted state cannot be recomputed, only invalidated: an older build's
 * widths were derived from bounds this one no longer computes (a minimum taken
 * from placeholder dashes, cells measured at the wrong font size), and the drag
 * list that came with them refers to those same numbers. Clearing both on a
 * version change is what lets a fixed rule actually take effect — without it the
 * page keeps rendering the old widths and looks unchanged.
 *
 *   1 — implicit; no version was stored.
 *   2 — placeholders excluded from min; widths follow `fit`; real font metrics.
 *   3 — the min is scoped to the visible page instead of the whole history.
 */
export const WIDTH_RULE_VERSION = 3

/** Slack left over once every column is at its fit; rendered as a filler cell. */
export function fillerWidth(
  displayed: Readonly<Record<string, number>>,
  ids: ReadonlyArray<string>,
  containerW: number,
): number {
  const sum = ids.reduce((acc, id) => acc + (displayed[id] ?? 0), 0)
  return Math.max(0, containerW - sum)
}
