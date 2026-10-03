import { afterAll, describe, expect, it } from 'bun:test'
import {
  findLastCompactionRecord,
  getCompactWaitTimeoutMs,
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