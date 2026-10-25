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

/** How a row's outcome reads on screen. */
export type LogLevel = 'success' | 'retried' | 'failed'

/**
 * "重试" describes a SUCCESS that needed another attempt. A failed request that
 * was retried is still a failure — retrying successfully and then failing is the
 * outcome that matters, not the number of tries.
 */
export function logLevel(r: LlmUsageRecord): LogLevel {
  if (r.status !== 'success') return 'failed'
  return r.retried || (r.attempts ?? 0) > 1 ? 'retried' : 'success'
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
  return rows.filter((r) => {
    if (f.level !== 'all' && logLevel(r) !== f.level) return false
    if (f.provider !== 'all' && r.provider !== f.provider) return false
    if (f.strategy !== 'all' && r.strategy !== f.strategy) return false
    // `?? 'all'`: a filter object restored from an older shape would otherwise
    // read as "filter by undefined" and hide every row.
    if ((f.kind ?? 'all') !== 'all' && (r.kind ?? '') !== f.kind) return false
    return true
  })
}
