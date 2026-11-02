import { describe, expect, it } from 'bun:test'
import { buildCompactionSummaryParams } from '../compaction-summary.ts'

/**
 * The row renders as
 *   压缩完成：约 A → B（保留 R，压缩 S）
 * so B must be the number the context ring shows and the three figures must
 * add up. Regression suite for 2026-11-01 session 261101-eager-fountain:
 * "约 453.4k → 20.0k（保留 20.0k，压缩 427.5k）" — the arrow target was the
 * subprocess's measured kept region (stops at the keepRecentTokens floor)
 * instead of the SDK's estimatedTokensAfter, so it contradicted both the ring
 * (25.9k) and its own arithmetic (453.4 − 427.5 = 25.9).
 */
describe('buildCompactionSummaryParams', () => {
  it('anchors the LLM path on the SDK post-compaction size, not the keepRecent floor', () => {
    const params = buildCompactionSummaryParams({
      tokensBefore: 453_400,
      estimatedTokensAfter: 25_900,
      // subprocess-measured kept region — just the 20k floor
      retained: 20_000,
      checkpoint: 0,
      viaRelief: false,
    })

    expect(params).not.toBeNull()
    expect(params!.before).toBe(453_400)
    expect(params!.after).toBe(25_900)
    expect(params!.retained).toBe(25_900)
    expect(params!.compacted).toBe(427_500)
    expect(params!.viaRelief).toBe(0)
    // the row must add up
    expect(params!.retained + params!.checkpoint + params!.compacted).toBe(params!.before)
  })

  it('keeps the relief checkpoint out of retained but inside after', () => {
    const params = buildCompactionSummaryParams({
      tokensBefore: 366_600,
      estimatedTokensAfter: 20_200,
      retained: 20_000,
      checkpoint: 200,
      viaRelief: true,
    })

    expect(params).toMatchObject({
      before: 366_600,
      after: 20_200,
      retained: 20_000,
      compacted: 346_400,
      checkpoint: 200,
      viaRelief: 1,
    })
    expect(params!.retained + params!.checkpoint + params!.compacted).toBe(params!.before)
  })

  it('falls back to kept region + checkpoint when the SDK estimate is missing', () => {
    const params = buildCompactionSummaryParams({
      tokensBefore: 100_000,
      retained: 12_000,
      checkpoint: 1_500,
      viaRelief: true,
    })

    expect(params).toMatchObject({
      before: 100_000,
      after: 13_500,
      retained: 12_000,
      compacted: 86_500,
      checkpoint: 1_500,
    })
  })

  it('never reports a compaction that grew the context', () => {
    // An estimate that overshoots the pre-compaction size would render a
    // negative "compacted"; clamp instead.
    const params = buildCompactionSummaryParams({
      tokensBefore: 10_000,
      estimatedTokensAfter: 12_000,
    })

    expect(params).toMatchObject({ before: 10_000, after: 10_000, retained: 10_000, compacted: 0 })
  })

  it('returns null when the pre-compaction size is unknown', () => {
    expect(buildCompactionSummaryParams({ tokensBefore: 0 })).toBeNull()
    expect(buildCompactionSummaryParams({ tokensBefore: Number.NaN })).toBeNull()
  })
})
