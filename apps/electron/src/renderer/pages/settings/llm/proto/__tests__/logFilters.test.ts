/**
 * Log-page filtering.
 *
 * The reported failure was that a dropdown said one thing and the table showed
 * another: "失败" still listed successful requests, and a provider filter listed
 * other providers. Both are covered here, at the level the view actually uses —
 * `filterLogs` over the rows a query returned.
 */

import { describe, expect, it } from 'bun:test'
import { DEFAULT_FILTER, filterLogs, logLevel, normalizeLevel } from '../logFilters'
import type { LogsFilter } from '../logFilters'

const row = (over: Record<string, unknown> = {}) =>
  ({
    ts: 1,
    strategy: 's1',
    provider: 'p1',
    keyId: 'k1',
    publicModel: 'gpt-5',
    upstreamModel: 'gpt-5',
    status: 'success',
    statusCode: 200,
    attempts: 1,
    ...over,
  }) as never

const filter = (over: Partial<LogsFilter> = {}): LogsFilter => ({ ...DEFAULT_FILTER, ...over })

describe('logLevel', () => {
  it('calls an error a failure', () => {
    expect(logLevel(row({ status: 'error' }))).toBe('failed')
  })

  it('calls a gateway refusal a failure', () => {
    expect(logLevel(row({ status: 'no_healthy_account', statusCode: 503 }))).toBe('failed')
  })

  it('a success that needed another attempt is a success, not a third state', () => {
    // The column used to paint this row amber "重试", which reads as "something
    // still needs attention" beside a genuine failure. The attempts stay in the
    // expanded row (尝试 N 次), not in the outcome.
    expect(logLevel(row({ attempts: 2 }))).toBe('success')
    expect(logLevel(row({ retried: true }))).toBe('success')
  })

  it('a failed request that was retried is still a failure', () => {
    expect(logLevel(row({ status: 'error', attempts: 3 }))).toBe('failed')
  })
})

describe('filterLogs', () => {
  const rows = [
    row({ ts: 1, status: 'success' }),
    row({ ts: 2, status: 'success', attempts: 2 }),
    row({ ts: 3, status: 'error', statusCode: 500 }),
    row({ ts: 4, status: 'no_healthy_account', statusCode: 503, provider: '' }),
  ]

  it('keeps everything under the default filter', () => {
    expect(filterLogs(rows, DEFAULT_FILTER)).toHaveLength(4)
  })

  it('失败 lists only failures — never a success, retried or not', () => {
    expect(filterLogs(rows, filter({ level: 'failed' })).map((r) => r.ts)).toEqual([3, 4])
  })

  it('成功 lists every request that worked, including ones that needed a retry', () => {
    expect(filterLogs(rows, filter({ level: 'success' })).map((r) => r.ts)).toEqual([1, 2])
  })

  it('a filter still set to the removed 重试 level shows everything, not nothing', () => {
    expect(normalizeLevel('retried')).toBe('all')
    expect(filterLogs(rows, filter({ level: 'retried' as never })).map((r) => r.ts)).toEqual([1, 2, 3, 4])
  })

  it('provider is matched exactly, not by substring', () => {
    // The store narrows the scan with a substring tag, so `p1` also returns
    // `p1-backup` rows; the view must not present them under "提供商 = p1".
    const mixed = [row({ ts: 1, provider: 'p1' }), row({ ts: 2, provider: 'p1-backup' })]
    expect(filterLogs(mixed, filter({ provider: 'p1' })).map((r) => r.ts)).toEqual([1])
  })

  it('a gateway refusal (no provider) is not listed under a selected provider', () => {
    const mixed = [row({ ts: 1, provider: '' }), row({ ts: 2, provider: 'p2' })]
    expect(filterLogs(mixed, filter({ provider: 'p2' })).map((r) => r.ts)).toEqual([2])
  })

  it('strategy and kind narrow independently', () => {
    const mixed = [
      row({ ts: 1, strategy: 'a', kind: 'chat' }),
      row({ ts: 2, strategy: 'b', kind: 'chat' }),
      row({ ts: 3, strategy: 'a', kind: 'title' }),
    ]
    expect(filterLogs(mixed, filter({ strategy: 'a' })).map((r) => r.ts)).toEqual([1, 3])
    expect(filterLogs(mixed, filter({ kind: 'title' })).map((r) => r.ts)).toEqual([3])
  })

  it('treats a missing kind on the row as "no kind" rather than matching everything', () => {
    const mixed = [row({ ts: 1 }), row({ ts: 2, kind: 'chat' })]
    expect(filterLogs(mixed, filter({ kind: 'chat' })).map((r) => r.ts)).toEqual([2])
  })
})
