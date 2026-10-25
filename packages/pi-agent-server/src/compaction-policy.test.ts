import { afterAll, describe, expect, it } from 'bun:test'
import {
  findLastCompactionRecord,
  getCompactWaitTimeoutMs,
  synthCompactionStats,
  translateAlreadyCompacted,
  waitForCompaction,
  type CompactionWaitResult,
} from './compaction-policy.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Fake session whose `isCompacting` flips on demand. */
function compactableSession(initial = true): { isCompacting: boolean } {
  return { isCompacting: initial }
}

describe('waitForCompaction', () => {
  it('returns immediately when nothing is compacting', async () => {
    const result = await waitForCompaction(compactableSession(false), 300_000)
    expect(result).toEqual({ waited: false, timedOut: false })
  })

  it('awaits a compaction that finishes within the window', async () => {
    const session = compactableSession(true)
    const logs: string[] = []
    // 100ms ceiling vs 5ms polls; flip at ~20ms lands well inside.
    const pending = waitForCompaction(session, 100, (m) => logs.push(m), 5)
    await sleep(20)
    session.isCompacting = false
    const result = await pending
    expect(result).toEqual({ waited: true, timedOut: false })
    expect(logs.join('\n')).toContain('Compaction finished, proceeding with prompt')
  })

  it('reports still-running once the ceiling elapses with a live compaction', async () => {
    const session = compactableSession(true)
    const pending = waitForCompaction(session, 30, () => {}, 5)
    // No flip: the first ceiling check happens at ~35ms, far inside 80ms.
    await sleep(80)
    const result = await pending
    expect(result).toEqual({ waited: true, timedOut: true })
  })

  it('releases (not still-running) when the compaction flips false around the ceiling', async () => {
    // 2026-10-08 review requirement: the final re-check must never report
    // "still running" right after the compaction actually finished.
    // Flip at ~20ms; the first ceiling check can only happen at ~105ms —
    // an 80ms margin that timer jitter cannot cross.
    const session = compactableSession(true)
    const pending = waitForCompaction(session, 100, () => {}, 5)
    await sleep(20)
    session.isCompacting = false
    const result = await pending
    expect(result).toEqual({ waited: true, timedOut: false })
  })
})

describe('getCompactWaitTimeoutMs', () => {
  const prev = process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS

  afterAll(() => {
    if (prev === undefined) delete process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS
    else process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS = prev
  })

  it('defaults to 240s (strictly below the 300s RPC budget)', () => {
    delete process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS
    expect(getCompactWaitTimeoutMs()).toBe(240_000)
  })

  it('honors a positive override and falls back on garbage', () => {
    process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS = '30000'
    expect(getCompactWaitTimeoutMs()).toBe(30_000)
    process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS = 'bogus'
    expect(getCompactWaitTimeoutMs()).toBe(240_000)
    process.env.CRAFT_PI_COMPACT_WAIT_TIMEOUT_MS = '-5'
    expect(getCompactWaitTimeoutMs()).toBe(240_000)
  })
})

describe('findLastCompactionRecord', () => {
  it('returns the most recent compaction entry, skipping later non-compaction entries', () => {
    const entries = [
      { type: 'user', content: 'a' },
      { type: 'compaction', summary: 'old', firstKeptEntryId: 'e1', tokensBefore: 10 },
      { type: 'assistant', content: 'b' },
      { type: 'compaction', summary: 'new', firstKeptEntryId: 'e2', tokensBefore: 202776 },
      { type: 'assistant', content: 'c' },
    ]
    const record = findLastCompactionRecord(entries)
    expect(record).toEqual({ summary: 'new', firstKeptEntryId: 'e2', tokensBefore: 202776 })
  })

  it('returns null when no compaction entry exists', () => {
    expect(findLastCompactionRecord([{ type: 'user', content: 'a' }])).toBeNull()
    expect(findLastCompactionRecord([])).toBeNull()
  })
})

describe('translateAlreadyCompacted', () => {
  const record = { summary: 's', firstKeptEntryId: 'e', tokensBefore: 202776 }
  const waited = (w: boolean, timedOut = false): CompactionWaitResult => ({ waited: w, timedOut })

  it('translates a waited Already compacted into success carrying the record truth', () => {
    const t = translateAlreadyCompacted(waited(true), 'Already compacted', record)
    expect(t).toEqual({
      success: true,
      note: 'completed by the preceding compaction',
      result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 202776 },
    })
  })

  it('keeps the guard error when the request never waited on a live compaction', () => {
    // Stale/duplicate request AFTER the compaction finished: an honest error,
    // not a translated success.
    expect(translateAlreadyCompacted(waited(false), 'Already compacted', record)).toBeNull()
  })

  it('keeps the error when no persisted record can be found', () => {
    expect(translateAlreadyCompacted(waited(true), 'Already compacted', null)).toBeNull()
  })

  it('never translates unrelated errors', () => {
    expect(translateAlreadyCompacted(waited(true), 'Nothing to compact (session too small)', record)).toBeNull()
    expect(translateAlreadyCompacted(waited(true), 'Compaction cancelled', record)).toBeNull()
  })
})
describe('synthCompactionStats', () => {
  // The 2026-10-18 regression: stats was undefined on the SDK's LLM path, and
  // PiAgent's fallback pinned `retained` to 0 while `after` collapsed to the
  // checkpoint alone -> "约403.6k→0.6k (保留0.0k, 压缩403.6k)".
  it('derives every number from the real before/after', () => {
    const s = synthCompactionStats({ tokensBefore: 403_584, estimatedTokensAfter: 50_400 }, 20_000)
    expect(s.before).toBe(403_584)
    expect(s.compacted).toBe(403_584 - 50_400)
    expect(s.retained).toBeLessThanOrEqual(50_400)
    expect(s.checkpoint).toBe(0)
    expect(s.viaRelief).toBe(false)
  })

  it('prefers the MEASURED retained region over the floor', () => {
    const s = synthCompactionStats(
      { tokensBefore: 403_584, estimatedTokensAfter: 50_400 },
      20_000,
      25_800,
    )
    expect(s.retained).toBe(25_800)
  })

  it('clamps a measured region to the surviving context', () => {
    // Measurement can exceed `after` when the cut point kept whole turns whose
    // estimate is larger than the SDK's post-compaction recompute.
    const s = synthCompactionStats(
      { tokensBefore: 100_000, estimatedTokensAfter: 4_000 },
      20_000,
      30_000,
    )
    expect(s.retained).toBe(4_000)
  })

  it('falls back to the floor when nothing was measured', () => {
    const s = synthCompactionStats({ tokensBefore: 100_000, estimatedTokensAfter: 60_000 }, 20_000)
    expect(s.retained).toBe(20_000)
  })

  it('falls back to after when neither measurement nor floor is usable', () => {
    const s = synthCompactionStats({ tokensBefore: 100_000, estimatedTokensAfter: 60_000 }, 0)
    expect(s.retained).toBe(60_000)
  })

  it('never reports a negative compacted on estimate drift', () => {
    const s = synthCompactionStats({ tokensBefore: 1_000, estimatedTokensAfter: 1_500 }, 20_000)
    expect(s.compacted).toBe(0)
  })

  it('treats a missing estimatedTokensAfter as before', () => {
    const s = synthCompactionStats({ tokensBefore: 20_000 }, 20_000)
    expect(s.compacted).toBe(0)
    expect(s.retained).toBe(20_000)
  })

  it('ignores a negative measurement', () => {
    const s = synthCompactionStats(
      { tokensBefore: 100_000, estimatedTokensAfter: 60_000 },
      20_000,
      -5,
    )
    expect(s.retained).toBe(20_000)
  })
})
