/**
 * Overview KPI inputs — the 缓存复用 card and the RTK card.
 *
 * The cache card read 0% on every provider until the gateway started recording
 * `cachedTokens`; the rate arithmetic then had a second trap: Anthropic reports
 * cache reads *beside* `input_tokens`, so dividing by prompt+completion alone
 * made a fully cached turn read as several hundred percent.
 */

import { describe, expect, test } from 'bun:test'

import { buildKpis, buildRtk } from '../proto/viewmodel'
import type { UsageOverview } from '../types'

function overview(over: Partial<UsageOverview> = {}): UsageOverview {
  return {
    totals: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 },
    outcomes: { success: 0, retried: 0, failed: 0 },
    successRate: null,
    firstByte: { p50: null, p95: null },
    daily: [],
    byProvider: [],
    byStrategy: [],
    byModel: [],
    sessionCount: 0,
    ...over,
  }
}

function providerUsage(provider: string, promptTokens: number, cachedTokens: number) {
  return {
    provider,
    requests: 1,
    success: 1,
    failed: 0,
    promptTokens,
    cachedTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    avgFirstByteMs: null,
  }
}

describe('buildKpis — 缓存复用', () => {
  test('uses OpenAI prompt tokens as already including cache reads', () => {
    const k = buildKpis(
      overview({
        totals: { promptTokens: 1000, completionTokens: 50, cachedTokens: 900, totalTokens: 1050 },
        byProvider: [providerUsage('openai', 1000, 900)],
      }),
      1,
      7,
      { openai: 'openai-completions' },
    )

    expect(k.cacheRate).toBe(90)
  })

  test('combines mixed protocols by their protocol-specific prompt denominators', () => {
    const k = buildKpis(
      overview({
        totals: { promptTokens: 2000, completionTokens: 50, cachedTokens: 1800, totalTokens: 2050 },
        byProvider: [providerUsage('openai', 1000, 900), providerUsage('anthropic', 1000, 900)],
      }),
      2,
      7,
      { openai: 'openai-completions', anthropic: 'anthropic-messages' },
    )

    // 1800 / (OpenAI prompt 1000 + Anthropic input 1000 + cached 900).
    expect(k.cacheRate).toBe(62.1)
  })

  test('reports the share of prompt tokens served from cache', () => {
    const k = buildKpis(
      overview({
        totals: { promptTokens: 100, completionTokens: 50, cachedTokens: 900, totalTokens: 150 },
        daily: [
          {
            day: '2026-10-25',
            success: 1,
            retried: 0,
            failed: 0,
            promptTokens: 100,
            completionTokens: 50,
            cachedTokens: 900,
          },
        ],
      }),
      1,
      7,
    )
    // 900 / (100 + 900), not 900 / 150: cache reads are not part of the
    // prompt count on Anthropic, and the card must stay a share, not a ratio
    // that can run past 100%.
    expect(k.cacheTokens).toBe(900)
    expect(k.cacheRate).toBe(90)
  })

  test('never exceeds 100% even when every input token was cached', () => {
    const k = buildKpis(
      overview({
        totals: { promptTokens: 0, completionTokens: 10, cachedTokens: 5000, totalTokens: 10 },
      }),
      1,
      Infinity,
    )
    expect(k.cacheRate).toBe(100)
  })

  test('is null with no traffic rather than a misleading 0%', () => {
    expect(buildKpis(overview(), 1, 7).cacheRate).toBeNull()
  })

  test('the sparkline plots cached tokens, not completion tokens', () => {
    const k = buildKpis(
      overview({
        totals: { promptTokens: 100, completionTokens: 50, cachedTokens: 900, totalTokens: 150 },
        daily: [
          {
            day: dayKey(0),
            success: 1,
            retried: 0,
            failed: 0,
            promptTokens: 100,
            completionTokens: 50,
            cachedTokens: 900,
          },
        ],
      }),
      1,
      3,
    )
    expect(k.sparkCache).toHaveLength(3)
    expect(k.sparkCache[k.sparkCache.length - 1]).toBe(900)
  })
})

function dayKey(offsetDays: number): string {
  const d = new Date()
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offsetDays)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

describe('buildRtk', () => {
  test('splits "off" from "nothing saved yet"', () => {
    const off = buildRtk(false, { installed: true, version: '1.2.3' }, null)
    expect(off).toEqual({
      enabled: false,
      installed: true,
      version: '1.2.3',
      commands: 0,
      totalInput: 0,
      totalOutput: 0,
      totalSaved: 0,
      savingsPct: 0,
    })

    const onButQuiet = buildRtk(true, { installed: true, version: '1.2.3' }, null)
    expect(onButQuiet.enabled).toBe(true)
    expect(onButQuiet.commands).toBe(0)
  })

  test('carries rtk gain through', () => {
    const rtk = buildRtk(true, { installed: true, version: '1.2.3' }, {
      totalCommands: 12,
      totalInput: 20000,
      totalOutput: 4000,
      totalSaved: 16000,
      avgSavingsPct: 80,
    })
    expect(rtk.commands).toBe(12)
    expect(rtk.totalSaved).toBe(16000)
    expect(rtk.savingsPct).toBe(80)
  })

  test('treats a missing status channel as not installed, not as enabled', () => {
    const rtk = buildRtk(undefined, null, null)
    expect(rtk.installed).toBe(false)
    expect(rtk.enabled).toBe(true)
  })
})
