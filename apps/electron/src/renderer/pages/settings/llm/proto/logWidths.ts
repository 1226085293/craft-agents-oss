/**
 * Column sizing for the log table.
 *
 * Rules (all measured in the same unit — CSS pixels including the cell's 8px
 * horizontal padding on each side):
 *
 *   min = the column's shortest value, but never narrower than its heading
 *         (a truncated heading is worse than a truncated value). Shrinking to
 *         the min therefore always keeps at least one row fully readable.
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

export interface ColumnMetrics {
  /** Rendered width of the heading, padding included. */
  header: number
  /** Rendered width of every cell value, padding included. */
  values: ReadonlyArray<number>
}

/** Absolute sanity bounds, only to survive corrupt stored values. */
export const HARD_MIN = 40
export const HARD_MAX = 800

export function columnLimits(metrics: ColumnMetrics): WidthLimits {
  const { header, values } = metrics
  let shortest = Number.POSITIVE_INFINITY
  let longest = 0
  for (const v of values) {
    if (v < shortest) shortest = v
    if (v > longest) longest = v
  }
  // No rows: the heading is all there is to go on.
  if (!values.length) shortest = longest = header

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

/** Slack left over once every column is at its fit; rendered as a filler cell. */
export function fillerWidth(
  displayed: Readonly<Record<string, number>>,
  ids: ReadonlyArray<string>,
  containerW: number,
): number {
  const sum = ids.reduce((acc, id) => acc + (displayed[id] ?? 0), 0)
  return Math.max(0, containerW - sum)
}
