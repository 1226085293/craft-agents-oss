/*
 * `small` mirrors the class the cell actually carries in LogsView: `.xs`
 * (--text-xs, 11px) versus the table's own --text-md (13px). Width measurement
 * has to use the same size the browser renders — measuring an 11px cell at 13px
 * leaves the min width and the text disagreeing by ~18%, which showed up as
 * values elided inside a column that was supposedly at its content minimum.
 */
export const COLUMNS = [
  { id: 'time', label: '时间', mono: true, small: true },
  { id: 'provider', label: '提供商', mono: false, small: false },
  { id: 'key', label: 'Key', mono: true, small: true },
  { id: 'model', label: '模型', mono: false, small: false },
  { id: 'strategy', label: '策略组', mono: false, small: true },
  { id: 'kind', label: '类型', mono: false, small: true },
  { id: 'code', label: '状态码', mono: true, small: true },
  { id: 'status', label: '状态', mono: false, small: false },
  { id: 'tokens', label: 'Token', mono: true, small: true },
  { id: 'firstByte', label: '首字节', mono: true, small: true },
  { id: 'dur', label: '耗时', mono: true, small: true },
  { id: 'session', label: '会话', mono: false, small: true },
] as const

export type ColumnId = (typeof COLUMNS)[number]['id']

/** Visible columns, persisted; unknown ids are dropped. */
export function normalizeColumns(value: unknown): ColumnId[] {
  if (Array.isArray(value)) {
    const visible = value.filter((id): id is ColumnId => COLUMNS.some((column) => column.id === id))
    if (visible.length > 0 || value.length === 0) return visible
  }
  return COLUMNS.map((column) => column.id)
}
