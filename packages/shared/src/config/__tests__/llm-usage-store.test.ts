/**
 * Usage store + daily buckets.
 *
 * The store reads `CONFIG_DIR` at import time, so every test sets
 * `CRAFT_CONFIG_DIR` to a temp dir and then imports dynamically — a static
 * import would bind the developer's real ~/.craft-agent and write into it.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'craft-usage-test-'))
process.env.CRAFT_CONFIG_DIR = root

const store = await import('../llm-usage-store.ts')
const buckets = await import('../llm-usage-buckets.ts')
const aggregate = await import('../llm-usage-aggregate.ts')

const usageDir = join(root, 'llm-usage')

function record(over: Partial<import('../llm-usage-store.ts').LlmUsageRecord> = {}) {
  return {
    ts: Date.now(),
    strategy: 'auto',
    provider: 'p1',
    keyId: 'k1',
    publicModel: 'gpt-5',
    upstreamModel: 'gpt-5-up',
    status: 'success' as const,
    statusCode: 200,
    attempts: 1,
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 0,
    firstByteMs: 300,
    totalMs: 1200,
    sessionId: 's1',
    ...over,
  }
}

function writeTemp(lines: unknown[]): void {
  mkdirSync(usageDir, { recursive: true })
  writeFileSync(join(usageDir, 'usage-temp.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
}

beforeEach(() => {
  process.env.CRAFT_CONFIG_DIR = root
  rmSync(usageDir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('queryLlmUsage', () => {
  it('returns newest first by default', () => {
    writeTemp([record({ ts: 1000 }), record({ ts: 2000 }), record({ ts: 3000 })])
    const { rows } = store.queryLlmUsage({})
    expect(rows.map((r) => r.ts)).toEqual([3000, 2000, 1000])
  })

  it('applies the cap after filtering, and reports truncation', () => {
    writeTemp([
      record({ ts: 1000, provider: 'p1' }),
      record({ ts: 2000, provider: 'p2' }),
      record({ ts: 3000, provider: 'p2' }),
      record({ ts: 4000, provider: 'p2' }),
    ])
    const { rows, truncated } = store.queryLlmUsage({
      tags: [{ field: 'provider', value: 'p2' }],
      limit: 2,
    })
    expect(rows.map((r) => r.ts)).toEqual([4000, 3000])
    expect(truncated).toBe(true)
  })

  it('AND-s multiple tags', () => {
    writeTemp([
      record({ ts: 1000, provider: 'p1', status: 'error', statusCode: 429 }),
      record({ ts: 2000, provider: 'p1', status: 'success', statusCode: 200 }),
      record({ ts: 3000, provider: 'p2', status: 'error', statusCode: 429 }),
    ])
    const { rows } = store.queryLlmUsage({
      tags: [
        { field: 'provider', value: 'p1' },
        { field: 'code', value: '429' },
      ],
    })
    expect(rows.map((r) => r.ts)).toEqual([1000])
  })

  it('matches model against either the public or upstream name', () => {
    writeTemp([record({ ts: 1, publicModel: 'gpt-5', upstreamModel: 'gpt-5-2026' })])
    expect(store.queryLlmUsage({ tags: [{ field: 'model', value: '2026' }] }).rows).toHaveLength(1)
    expect(store.queryLlmUsage({ tags: [{ field: 'model', value: 'claude' }] }).rows).toHaveLength(0)
  })

  it('sorts ascending when asked', () => {
    writeTemp([record({ ts: 1000 }), record({ ts: 2000 })])
    expect(store.queryLlmUsage({ sort: 'asc' }).rows.map((r) => r.ts)).toEqual([1000, 2000])
  })

  it('lists a record once when it exists in both the session log and its day file', () => {
    // Persistence on: appendLlmUsage writes each record to both files. Reading
    // both used to double the log (and one expand click opened two details).
    const rec = record({ ts: 3000 })
    mkdirSync(usageDir, { recursive: true })
    writeFileSync(join(usageDir, 'usage-temp.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
    writeFileSync(join(usageDir, 'usage-2026-10-24.jsonl'), JSON.stringify(rec) + '\n', 'utf8')
    expect(store.queryLlmUsage({}).rows).toHaveLength(1)
    expect(store.readLlmUsage()).toHaveLength(1)
  })

  it('keeps genuinely repeated identical lines inside one file', () => {
    const rec = record({ ts: 1000 })
    writeTemp([rec, rec])
    expect(store.queryLlmUsage({}).rows).toHaveLength(2)
  })
})

describe('persistence', () => {
  it('routes records to the day file of their own timestamp', () => {
    writeFileSync(
      join(root, 'llm-config.json'),
      JSON.stringify({ version: 1, presets: {}, providers: [], strategies: [], clientKeys: [], usage: { persist: true } }),
      'utf8',
    )
    const late = new Date(2026, 9, 18, 23, 59).getTime()
    const early = new Date(2026, 9, 19, 0, 1).getTime()
    store.appendLlmUsage([record({ ts: late }), record({ ts: early })])

    const dayFiles = readdirSync(usageDir)
      .filter((f) => f.startsWith('usage-') && f.endsWith('.jsonl') && f !== 'usage-temp.jsonl')
      .sort()
    expect(dayFiles).toEqual(['usage-2026-10-18.jsonl', 'usage-2026-10-19.jsonl'])

    const second = readFileSync(join(usageDir, 'usage-2026-10-19.jsonl'), 'utf8').trim().split('\n')
    expect(second).toHaveLength(1)
  })

  it('keeps only the session file when persistence is off', () => {
    writeFileSync(
      join(root, 'llm-config.json'),
      JSON.stringify({ version: 1, presets: {}, providers: [], strategies: [], clientKeys: [], usage: { persist: false } }),
      'utf8',
    )
    store.appendLlmUsage([record({ ts: Date.now() })])
    const dayFiles = readdirSync(usageDir).filter(
      (f) => f.endsWith('.jsonl') && f !== 'usage-temp.jsonl',
    )
    expect(dayFiles).toEqual([])
    expect(readFileSync(join(usageDir, 'usage-temp.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })
})

describe('session log', () => {
  it('clearLlmUsageTemp empties the file the runtime wipes at startup', () => {
    writeTemp([record({ ts: 1 }), record({ ts: 2 })])
    expect(readFileSync(join(usageDir, 'usage-temp.jsonl'), 'utf8')).not.toBe('')
    store.clearLlmUsageTemp()
    expect(readFileSync(join(usageDir, 'usage-temp.jsonl'), 'utf8')).toBe('')
  })
})

describe('daily buckets', () => {
  it('projects the same records the log shows', () => {
    const day1 = new Date(2026, 9, 18, 12).getTime()
    const day2 = new Date(2026, 9, 19, 12).getTime()
    const all = buckets.bucketsFromRecords([
      record({ ts: day1, status: 'success', promptTokens: 100, completionTokens: 10 }),
      record({ ts: day1, status: 'error', statusCode: 500, provider: 'p2', promptTokens: 0, completionTokens: 0 }),
      record({ ts: day2, status: 'success', promptTokens: 50, completionTokens: 5, firstByteMs: 700 }),
    ])
    expect(all).toHaveLength(2)

    const overview = aggregate.aggregateFromBuckets(all, 'all')
    expect(overview.outcomes).toEqual({ success: 2, retried: 0, failed: 1 })
    expect(overview.totals.promptTokens).toBe(150)
    expect(overview.totals.totalTokens).toBe(165)
    expect(overview.sessionCount).toBe(1)
    expect(overview.byProvider.map((p) => p.provider).sort()).toEqual(['p1', 'p2'])
    expect(overview.firstByte.p50).toBe(300)
  })

  it('carries cache reads into the daily and hourly series', () => {
    // The overview's 缓存复用 card draws its sparkline from these series, so a
    // dropped bucket here showed an empty chart next to a non-zero total.
    const day = new Date(2026, 9, 18, 12).getTime()
    const records = [record({ ts: day, promptTokens: 100, completionTokens: 10, cachedTokens: 900 })]
    const overview = aggregate.aggregateFromBuckets(buckets.bucketsFromRecords(records), 'all')
    expect(overview.totals.cachedTokens).toBe(900)
    expect(overview.daily[0]!.cachedTokens).toBe(900)
    expect(overview.byProvider.find((p) => p.provider === 'p1')!.cachedTokens).toBe(900)

    // `hourlyTokens` is the last 24 hours only, so it needs a recent row.
    const recent = [record({ ts: Date.now() - 3_600_000, cachedTokens: 900 })]
    const hourly = aggregate.hourlyTokens(recent)
    expect(hourly.reduce((sum, h) => sum + h.cached, 0)).toBe(900)
  })

  it('scopes by day range', () => {
    const day1 = new Date(2026, 9, 18, 12).getTime()
    const day2 = new Date(2026, 9, 19, 12).getTime()
    const all = buckets.bucketsFromRecords([record({ ts: day1 }), record({ ts: day2 })])
    const onlyDay1 = aggregate.aggregateFromBuckets(all, { fromTs: day1 - 1000, toTs: day1 + 1000 })
    expect(onlyDay1.outcomes.success).toBe(1)
  })
})

describe('connection probes', () => {
  it('writes a row with the probe kind and no strategy', () => {
    store.recordProbeUsage({
      provider: 'p1',
      keyId: 'k1',
      model: 'gpt-5',
      success: true,
      totalMs: 812,
    })

    const rows = store.queryLlmUsage({}).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('connection_test')
    // No group: a probe was never routed, and pretending otherwise would put
    // traffic in a strategy's totals that the gateway never carried.
    expect(rows[0]!.strategy).toBe('')
    expect(rows[0]!.status).toBe('success')
    expect(rows[0]!.statusCode).toBe(200)
    expect(rows[0]!.totalMs).toBe(812)
  })

  it('records a failed probe as an error with no status code', () => {
    store.recordProbeUsage({
      provider: 'p1',
      model: 'gpt-5',
      success: false,
      totalMs: 40,
      error: 'API key is required',
    })

    const row = store.queryLlmUsage({}).rows[0]!
    expect(row.status).toBe('error')
    // 0 renders as an em dash — there was no HTTP response to report.
    expect(row.statusCode).toBe(0)
    expect(row.error).toBe('API key is required')
  })

  it('keeps a failed probe out of the success rate and the histograms', () => {
    // A deliberately wrong key is an expected failure. Counting it would make
    // a healthy provider look degraded for a test that worked as intended.
    const allProbe = buckets.bucketsFromRecords([
      record({ status: 'success' }),
      record({
        kind: 'connection_test',
        status: 'error',
        statusCode: 0,
        strategy: '',
        promptTokens: 0,
        completionTokens: 0,
        firstByteMs: undefined,
      }),
    ])

    const overview = aggregate.aggregateFromBuckets(allProbe, 'all')
    expect(overview.outcomes).toEqual({ success: 1, retried: 0, failed: 0 })
    expect(overview.successRate).toBe(1)
    // The probe's tokens must not be added either.
    expect(overview.totals.promptTokens).toBe(100)
    expect(aggregate.statusHistogram([record({ kind: 'connection_test', status: 'error', statusCode: 0 })]))
      .toEqual([])
  })

  it('logs a superseded attempt without counting it as a second outcome', () => {
    // "Failed on A, then succeeded on B" is ONE retried success. The failed
    // attempt still gets a row — that is the whole point — but it must not turn
    // the pair into one failure plus one success.
    const withAttempt = buckets.bucketsFromRecords([
      record({ status: 'error', statusCode: 0, superseded: true, promptTokens: 0, completionTokens: 0 }),
      record({ status: 'success', retried: true, attempts: 2 }),
    ])

    const overview = aggregate.aggregateFromBuckets(withAttempt, 'all')
    expect(overview.outcomes).toEqual({ success: 1, retried: 1, failed: 0 })
    expect(overview.successRate).toBe(1)
    // The failed attempt contributed no tokens, so the total is the success's.
    expect(overview.totals.promptTokens).toBe(100)
    expect(
      aggregate.statusHistogram([
        record({ status: 'error', statusCode: 0, superseded: true }),
        record({ status: 'success' }),
      ]),
    ).toEqual([])
  })
})
