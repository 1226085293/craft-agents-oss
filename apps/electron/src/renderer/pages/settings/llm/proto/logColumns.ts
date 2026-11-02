export const COLUMNS = [
  { id: 'time', label: '时间', mono: true },
  { id: 'provider', label: '提供商', mono: false },
  { id: 'key', label: 'Key', mono: true },
  { id: 'model', label: '模型', mono: false },
  { id: 'strategy', label: '策略组', mono: false },
  { id: 'kind', label: '类型', mono: false },
  { id: 'code', label: '状态码', mono: true },
  { id: 'status', label: '状态', mono: false },
  { id: 'tokens', label: 'Token', mono: true },
  { id: 'firstByte', label: '首字节', mono: true },
  { id: 'dur', label: '耗时', mono: true },
  { id: 'session', label: '会话', mono: false },
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
