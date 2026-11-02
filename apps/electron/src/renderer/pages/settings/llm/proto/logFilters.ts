/**
 * Log-page filter model.
 *
 * Kept free of React so the rules can be unit-tested and so the status badge and
 * the status dropdown can never disagree: both read `logLevel()`.
 *
 * Only `tags` and `q` are sent to the store as tags (they are free-text
 * narrowing). Everything the dropdowns express is applied here, on the rows that
 * came back — one place, one implementation, so a filter cannot be "on" in the
 * UI and absent from the data.
 */

import type { LlmUsageRecord, UsageTag } from '@craft-agent/shared/config'

export interface LogsFilter {
  /** Filter chips, AND-ed. */
  tags: UsageTag[]
  level: LogLevel | 'all'
  /** Provider id, or `all`. Matched exactly. */
  provider: string
  /** Time order. Only the time column is sortable. */
  sort: 'desc' | 'asc'
  /** Set by "查看策略组日志"; rendered as a tag. */
  strategy: string
  /** Which feature made the request; `all` or a ModelRequestKind. */
  kind: string
  /** Legacy free-text entry from the error dialogs. */
  q: string
}

export const DEFAULT_FILTER: LogsFilter = {
  tags: [],
  level: 'all',
  provider: 'all',
  sort: 'desc',
  strategy: 'all',
  kind: 'all',
  q: '',
}

/**
 * How a row's outcome reads on screen. Two values, not three.
 *
 * A request whose first attempt got a 429 and whose second succeeded *succeeded*:
 * the column used to paint it an amber "重试", which sits next to a real failure
 * looking like something still needs attention, and buries the only answer the
 * column is asked for — did it work. The tries are not lost: the expanded row
 * prints 尝试 N 次 and the trace, and the 总览 counters still report retries.
 */
export type LogLevel = 'success' | 'failed'

export function logLevel(r: LlmUsageRecord): LogLevel {
  return r.status === 'success' ? 'success' : 'failed'
}

/**
 * Coerce a level that came from outside this render into one the table can
 * honour: a restored filter, an older dialog, a hand-built tag.
 *
 * `retried` used to be a selectable level. A filter still set to it would match
 * no row and read as "the log lost my requests".
 */
export function normalizeLevel(level: string): LogLevel | 'all' {
  return level === 'success' || level === 'failed' ? level : 'all'
}

/**
 * Apply every dropdown to the fetched rows.
 *
 * Provider is compared *exactly* and not by substring: the store narrows it with
 * a substring tag (`discovery` also matched `discovery-backup`), which is fine as
 * an over-inclusive pre-filter but wrong as the answer. Re-checking here is what
 * keeps "提供商 = X" from listing any other provider.
 */
export function filterLogs(rows: readonly LlmUsageRecord[], f: LogsFilter): LlmUsageRecord[] {
  const level = normalizeLevel(f.level)
  return rows.filter((r) => {
    if (level !== 'all' && logLevel(r) !== level) return false
    if (f.provider !== 'all' && r.provider !== f.provider) return false
    if (f.strategy !== 'all' && r.strategy !== f.strategy) return false
    // `?? 'all'`: a filter object restored from an older shape would otherwise
    // read as "filter by undefined" and hide every row.
    if ((f.kind ?? 'all') !== 'all' && (r.kind ?? '') !== f.kind) return false
    return true
  })
}
