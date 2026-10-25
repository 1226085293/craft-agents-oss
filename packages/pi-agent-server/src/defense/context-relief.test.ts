import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, InlineExtension, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'
import {
  buildReliefSummary,
  computeReliefStats,
  createContextReliefExtension,
  estimatePostReliefTokens,
  handleSessionBeforeCompact,
  isTrivialToSummarize,
  listTurnFiles,
  resolveReliefMaxTokens,
  shouldFallThroughToLlm,
  type ContextReliefDeps,
} from './context-relief.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Write a synthetic turn file with the real markdown shape. */
function writeTurnFile(dir: string, fileName: string, opts: { user?: string; conclusion?: string; extra?: string }): string {
  const path = join(dir, 'turns', fileName)
  mkdirSync(join(dir, 'turns'), { recursive: true })
  const md = [
    '# Turn 1 — 2026/10/16 14:53',
    '',
    '## User message',
    '',
    opts.user ?? 'default user message',
    '',
    ...(opts.conclusion ? ['## Conclusion', '', opts.conclusion, ''] : []),
    ...(opts.extra ? [opts.extra] : []),
  ].join('\n')
  writeFileSync(path, md, 'utf8')
  return path
}

function makeEvent(overrides: Partial<SessionBeforeCompactEvent> & { preparation: SessionBeforeCompactEvent['preparation'] }): SessionBeforeCompactEvent {
  return {
    type: 'session_before_compact',
    branchEntries: [],
    customInstructions: undefined,
    reason: 'threshold',
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function preparation(overrides: Partial<SessionBeforeCompactEvent['preparation']> = {}): SessionBeforeCompactEvent['preparation'] {
  return {
    firstKeptEntryId: 'kept-1',
    messagesToSummarize: [{ role: 'user', content: 'x'.repeat(4000) }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 60_000,
    fileOps: { readFiles: [], modifiedFiles: [] },
    // Real SDK default so the threshold check and retained accounting see
    // the same keepRecent floor the SDK's cut point targets.
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } as never,
    ...overrides,
  }
}

// ============================================================================
// Pure functions
// ============================================================================

describe('listTurnFiles', () => {
  it('returns sorted turn files, [] for missing sessionPath or dir', () => {
    expect(listTurnFiles(undefined)).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    expect(listTurnFiles(dir)).toEqual([])
    writeTurnFile(dir, '2026-10-16T06-53-23-002.md', {})
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', {})
    expect(listTurnFiles(dir).map(t => t.fileName)).toEqual([
      '2026-10-16T06-53-23-001.md',
      '2026-10-16T06-53-23-002.md',
    ])
  })
})

describe('buildReliefSummary', () => {
  it('includes header, user message, conclusion and a details pointer per turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    const path = writeTurnFile(dir, '2026-10-16T06-53-23-001.md', {
      user: '分析打包流程',
      conclusion: '完成：定位到 asar 根因',
    })
    const summary = buildReliefSummary([{ path, fileName: '2026-10-16T06-53-23-001.md' }])
    expect(summary).toContain('[Context relief checkpoint')
    expect(summary).toContain('## Turn 1 — 2026/10/16 14:53')
    expect(summary).toContain('User: 分析打包流程')
    expect(summary).toContain('Outcome: 完成：定位到 asar 根因')
    expect(summary).toContain(`Details: ${path}`)
  })

  it('truncates long user messages and conclusions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    const path = writeTurnFile(dir, '2026-10-16T06-53-23-001.md', {
      user: 'u'.repeat(500),
      conclusion: 'c'.repeat(800),
    })
    const summary = buildReliefSummary([{ path, fileName: 'f.md' }])
    const userLine = summary.split('\n').find(l => l.startsWith('User: '))!
    const outcomeLine = summary.split('\n').find(l => l.startsWith('Outcome: '))!
    expect(userLine.length).toBeLessThan(250)
    expect(userLine.endsWith('…')).toBe(true)
    expect(outcomeLine.length).toBeLessThan(350)
  })

  it('stops adding turns once the budget is exhausted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    const paths = [1, 2, 3].map(i =>
      writeTurnFile(dir, `2026-10-16T06-53-23-00${i}.md`, { user: `turn ${i}`, conclusion: `done ${i}` }),
    )
    const small = buildReliefSummary(paths.map(p => ({ path: p, fileName: p })), 400)
    expect(small).toContain('turn 1')
    expect(small).not.toContain('turn 3')
  })
})

describe('estimatePostReliefTokens', () => {
  // Post-relief context = kept region (keepRecent floor) + checkpoint text.
  // The discarded region is NOT re-derived from the message payload: a single
  // large tool result stringifies into a multi-MB blob whose ÷4 count is
  // meaningless (the 2026-10-18 "→0.6k" bug).
  it('keeps the keepRecent region and adds the checkpoint', () => {
    const post = estimatePostReliefTokens(403_600, 'y'.repeat(400), 20_000)
    // 20_000 kept + 400 chars/4 = 100 checkpoint tokens
    expect(post).toBe(20_100)
  })

  it('does not exceed tokensBefore when the keepRecent floor is huge', () => {
    const post = estimatePostReliefTokens(100, 'x'.repeat(400), 20_000)
    expect(post).toBe(200) // clamped: 100 kept + 100 checkpoint
  })

  it('never goes negative', () => {
    const post = estimatePostReliefTokens(-5, '', 0)
    expect(post).toBe(0)
  })
})

describe('shouldFallThroughToLlm', () => {
  it('true when post-relief is above the ceiling', () => {
    expect(shouldFallThroughToLlm(50_001, 50_000)).toBe(true)
    expect(shouldFallThroughToLlm(50_000, 50_000)).toBe(false)
  })
})

// ============================================================================
// Dynamic window-relative threshold (replaces the fixed 50k)
// ============================================================================

describe('resolveReliefMaxTokens', () => {
  it('uses 10% of the live context window when available', () => {
    expect(resolveReliefMaxTokens({ contextWindow: () => 1_000_000 })).toBe(100_000)
    expect(resolveReliefMaxTokens({ contextWindow: () => 200_000 })).toBe(20_000)
  })

  it('re-reads the window per call (model can change mid-session)', () => {
    let win = 1_000_000
    const deps = { contextWindow: () => win }
    expect(resolveReliefMaxTokens(deps)).toBe(100_000)
    win = 200_000
    expect(resolveReliefMaxTokens(deps)).toBe(20_000)
  })

  it('prefers an explicit reliefMaxTokens over the window ratio', () => {
    expect(resolveReliefMaxTokens({ reliefMaxTokens: 5_000, contextWindow: () => 1_000_000 })).toBe(5_000)
  })

  it('falls back to env, then the default, when no window resolves', () => {
    expect(resolveReliefMaxTokens({ contextWindow: () => 0 })).toBe(process.env.CRAFT_RELIEF_MAX_TOKENS && Number(process.env.CRAFT_RELIEF_MAX_TOKENS) > 0 ? Number(process.env.CRAFT_RELIEF_MAX_TOKENS) : 50_000)
    expect(resolveReliefMaxTokens({ contextWindow: () => { throw new Error('no model yet') } })).toBe(process.env.CRAFT_RELIEF_MAX_TOKENS && Number(process.env.CRAFT_RELIEF_MAX_TOKENS) > 0 ? Number(process.env.CRAFT_RELIEF_MAX_TOKENS) : 50_000)
  })
})

// ============================================================================
// Trivial-remaining detection (consecutive compactions)
// ============================================================================

describe('isTrivialToSummarize', () => {
  it('false for normal conversation content', () => {
    expect(isTrivialToSummarize([{ role: 'user', content: 'hello' }])).toBe(false)
  })

  it('true when most characters are relief checkpoints', () => {
    const cp = '[Context relief checkpoint — turns below were archived to disk, NOT summarized by an LLM.]'
    expect(isTrivialToSummarize([{ text: cp + 'x'.repeat(1000) }, { text: 'tiny' }])).toBe(true)
  })

  it('false when only a small part is checkpoints', () => {
    const cp = '[Context relief checkpoint]'
    expect(isTrivialToSummarize([{ text: 'x'.repeat(5000) }, { text: cp }])).toBe(false)
  })

  it('false for an empty array', () => {
    expect(isTrivialToSummarize([])).toBe(false)
  })
})

describe('handler — trivial remaining hands off to the LLM', () => {
  it('returns undefined (SDK LLM path runs), NOT a summary-less compaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: 'x' })
    const cp = { role: 'custom', text: '[Context relief checkpoint — turns below were archived]' + 'y'.repeat(4000) }
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 20_000, messagesToSummarize: [cp] }) }),
      { sessionPath: dir },
    )
    // No compaction object and no cancel — the SDK runs its own LLM
    // summarization. Returning a compaction object with an undefined summary
    // (the pre-2026-10-18 behaviour) persists a summary-less compaction entry
    // that makes every later /compact throw in estimateTokens().
    expect(result).toBeUndefined()
  })

  it('normal content keeps relief-first (summary present, details marked)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: 'x' })
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 20_000, messagesToSummarize: [{ text: 'real content' }] }) }),
      { sessionPath: dir },
    )
    expect(result!.compaction!.summary).toBeDefined()
    expect(result!.compaction!.details).toMatchObject({ relief: true })
  })
})

// ============================================================================
// Pointer guarantee (the fine-frost regression: small budget + big results)
// ============================================================================

describe('buildReliefSummary — pointer guarantee', () => {
  it('keeps at least the pointer line per turn even under a tiny budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    const path = writeTurnFile(dir, '2026-10-16T06-53-23-001.md', {
      user: '每天中午 12 点抓取热点简报…' + 'z'.repeat(200),
      conclusion: '抓取完成' + 'z'.repeat(200),
    })
    // Budget that cannot fit the user message — the pointer must survive.
    const summary = buildReliefSummary([{ path, fileName: '001.md' }], 400)
    expect(summary).toContain('## Turn 1')
    expect(summary).toContain(`Details: ${path}`)
  })

  it('produces a relief compaction for the fine-frost shape (1 turn, 1M window)', () => {
    // Regression: the session had ONE turn whose tool result is ~40k chars.
    // The turn file is ~250k chars, but the checkpoint only needs a pointer,
    // so relief succeeds even though the old 8k summary budget could not fit
    // the user message.
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-17T04-00-08-001.md', { user: '每天中午 12 点抓取热点简报' })
    const result = handleSessionBeforeCompact(
      makeEvent({
        reason: 'manual',
        preparation: preparation({ tokensBefore: 50_000, messagesToSummarize: [{ role: 'user', content: 'x'.repeat(4000) }] }),
      }),
      { sessionPath: dir, contextWindow: () => 1_000_000 },
    )
    expect(result?.compaction).toBeDefined()
    expect(result!.compaction!.summary).toContain('2026-10-17T04-00-08-001.md')
  })
})

// ============================================================================
// Relief stats (summary line token accounting)
// ============================================================================

describe('computeReliefStats', () => {
  // All numbers must be REAL, not derived from `messagesToSummarize`.
  // The 2026-10-18 bug: stringifying the payload over-counted so badly that
  // the UI line read "约403.6k→0.6k (保留0.0k, 压缩403.6k)" while the ring
  // showed 50k.
  it('compacted = before - after, retained = the measured kept region', () => {
    const s = computeReliefStats(403_600, [], 'y'.repeat(400), true, 50_400, [], 20_000)
    expect(s.before).toBe(403_600)
    expect(s.compacted).toBe(403_600 - 50_400)   // 353.2k actually eliminated
    expect(s.retained).toBe(20_000)              // floor fallback (no entries)
    expect(s.checkpoint).toBe(Math.ceil(400 / 4))
    expect(s.viaRelief).toBe(true)
  })

  it('measures retained from the real branch entries until the floor is met', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'u'.repeat(20_000) } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(20_000) }], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
    ]
    const s = computeReliefStats(100_000, [], 'y'.repeat(400), true, 30_000, entries, 4_000)
    expect(s.before).toBe(100_000)
    expect(s.compacted).toBe(70_000)
    // Walks back: the newest entry alone estimates to 5_000 tokens, which
    // already clears the 4_000 floor, so it stops there (same stop rule as
    // the SDK's findCutPoint).
    expect(s.retained).toBe(5_000)
  })

  it('keeps walking while the floor is not yet met', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'u'.repeat(20_000) } },
      { type: 'message', message: { role: 'user', content: 'u'.repeat(20_000) } },
      { type: 'message', message: { role: 'user', content: 'u'.repeat(20_000) } },
    ]
    // Each entry ≈ 5_000 tokens; floor 12_000 → needs the newest three.
    const s = computeReliefStats(100_000, [], '', true, 30_000, entries, 12_000)
    expect(s.retained).toBe(15_000)
  })

  it('stops walking at a compaction boundary', () => {
    const entries = [
      { type: 'compaction', summary: 'older checkpoint text' },
      { type: 'message', message: { role: 'user', content: 'u'.repeat(4_000) } },
    ]
    const s = computeReliefStats(50_000, [], '', true, 2_000, entries, 20_000)
    // Only the post-boundary message counts: 4_000/4 = 1_000 tokens.
    expect(s.retained).toBe(1_000)
  })

  it('retained never exceeds the surviving context', () => {
    const s = computeReliefStats(50_000, [], 'y'.repeat(400), true, 500, [], 20_000)
    expect(s.retained).toBeLessThanOrEqual(500)
  })

  it('clamps compacted at 0 when after > before (estimate drift)', () => {
    const s = computeReliefStats(1_000, [], '', false, 1_500, [], 20_000)
    expect(s.compacted).toBe(0)
    // retained is bounded by `after` (the context that actually survived)
    expect(s.retained).toBe(1_500)
    expect(s.viaRelief).toBe(false)
  })

  it('falls back to before when tokensAfter is not a number', () => {
    const s = computeReliefStats(20_000, [], 'c', true, Number.NaN, [], 20_000)
    expect(s.compacted).toBe(0)
    expect(s.retained).toBe(20_000)
  })

  it('does not throw on an unserializable payload', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const s = computeReliefStats(20_000, [cyclic], 'c', true, 5_000, [], 20_000)
    expect(s.before).toBe(20_000)
    expect(s.compacted).toBe(15_000)
  })
})

describe('handler — never returns a summary-less compaction', () => {
  // Regression guard for the 2026-10-18 brick: the SDK's compact() branch is
  // `if (result?.compaction)`, which tests the OBJECT and not `summary`.
  // A summary-less compaction object therefore skips the SDK's own LLM
  // summarizer and persists a compaction entry with NO `summary` field —
  // after which EVERY subsequent /compact dies in estimateTokens() with
  // `undefined is not an object (evaluating 'message.summary.length')`.
  it('relief path reports viaRelief=true and the checkpoint size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-17T04-00-08-001.md', { user: 'hello' })
    const r = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 39_600 }) }),
      { sessionPath: dir },
    )
    const stats = (r!.compaction!.details as { reliefStats?: { viaRelief: boolean; before: number } }).reliefStats!
    expect(stats.viaRelief).toBe(true)
    expect(stats.before).toBe(39_600)
  })

  it('LLM path returns NO compaction object (SDK runs its own summarizer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-17T04-00-08-001.md', { user: 'x' })
    const r = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 100_000 }) }),
      { sessionPath: dir, reliefMaxTokens: 10_000 },
    )
    // Must be undefined — NOT a compaction object with an undefined summary.
    expect(r).toBeUndefined()
  })

  it('records the retained measurement for the LLM path too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: 'x' })
    // deps carries the stash object the result path reads.
    const deps: ContextReliefDeps = {
      sessionPath: dir,
      reliefMaxTokens: 10_000,
      lastRetainedMeasurement: { retained: -1, keepRecentTokens: -1, measuredAt: 0 },
    }
    const entries = [
      { type: 'message', message: { role: 'user', content: 'u'.repeat(20_000) } },
    ]
    handleSessionBeforeCompact(
      makeEvent({
        branchEntries: entries,
        preparation: preparation({ tokensBefore: 100_000 }),
      }),
      deps,
    )
    // Both paths stash the measurement — 20_000 chars / 4 = 5_000 tokens.
    expect(deps.lastRetainedMeasurement!.retained).toBe(5_000)
    expect(deps.lastRetainedMeasurement!.keepRecentTokens).toBe(20_000)
    expect(deps.lastRetainedMeasurement!.measuredAt).toBeGreaterThan(0)
  })

  it('any returned compaction ALWAYS carries a non-empty summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: '分析打包流程' })
    // Sweep the plausible token range; every defined result must be relief-shaped.
    for (const tokensBefore of [1_000, 20_000, 39_600, 60_000, 100_000, 500_000]) {
      for (const reliefMaxTokens of [undefined, 10_000, 200_000]) {
        const r = handleSessionBeforeCompact(
          makeEvent({ preparation: preparation({ tokensBefore }) }),
          { sessionPath: dir, ...(reliefMaxTokens !== undefined ? { reliefMaxTokens } : {}) },
        )
        if (r === undefined) continue // LLM path — fine
        expect(typeof r.compaction!.summary).toBe('string')
        expect(r.compaction!.summary!.length).toBeGreaterThan(0)
      }
    }
  })
})

// ============================================================================
// Handler + extension
// ============================================================================

function harness(deps: ContextReliefDeps) {
  let handler: ((event: SessionBeforeCompactEvent, ctx: unknown) => unknown) | undefined
  const extension = createContextReliefExtension(deps) as InlineExtension & { factory: (api: ExtensionAPI) => void }
  extension.factory({
    on: (_name: string, callback: unknown) => { handler = callback as never },
  } as unknown as ExtensionAPI)
  return {
    fire: (event: SessionBeforeCompactEvent) => handler!(event, {}),
  }
}

describe('handleSessionBeforeCompact', () => {
  it('treats manual /compact the same as automatic (relief first, same path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: '分析打包流程' })
    const manual = handleSessionBeforeCompact(
      makeEvent({ reason: 'manual', preparation: preparation({ tokensBefore: 20_000 }) }),
      { sessionPath: dir },
    )
    const auto = handleSessionBeforeCompact(
      makeEvent({ reason: 'threshold', preparation: preparation({ tokensBefore: 20_000 }) }),
      { sessionPath: dir },
    )
    // Both triggers resolve to the same relief compaction, not an LLM call.
    expect(manual?.compaction?.summary).toBe(auto?.compaction?.summary)
    expect(manual?.compaction?.summary).toContain('分析打包流程')
  })

  it('returns undefined when no turn files exist (LLM compaction takes over)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation() }),
      { sessionPath: dir },
    )
    expect(result).toBeUndefined()
  })

  it('supplies a relief compaction under the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: '分析打包流程' })
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 20_000 }) }),
      { sessionPath: dir },
    )
    expect(result).toBeDefined()
    expect(result!.cancel).toBeUndefined()
    const c = result!.compaction!
    expect(c.firstKeptEntryId).toBe('kept-1')
    expect(c.tokensBefore).toBe(20_000)
    expect(c.summary).toContain('分析打包流程')
    expect(c.details).toMatchObject({ relief: true })
  })

  it('hands the LLM path when post-relief still exceeds the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    // 100k tokens before, huge discard — post-relief stays above a tiny ceiling.
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: 'x' })
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 100_000 }) }),
      { sessionPath: dir, reliefMaxTokens: 10_000 },
    )
    // No compaction object at all → the SDK's LLM summarization runs.
    // (Returning a summary-less compaction object here is what bricked
    // /compact in session 261016-true-sparrow.)
    expect(result).toBeUndefined()
  })

  it('fails open through the extension wrapper when the handler throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', {})
    // Happy path for the wrapper.
    const h = harness({ sessionPath: dir })
    const result = h.fire(makeEvent({ preparation: preparation({ tokensBefore: 20_000 }) }) as SessionBeforeCompactEvent)
    expect(result).toBeDefined()
    // Force a throw inside the handler: deps whose every property access throws.
    const throwingDeps = new Proxy({}, { get: () => { throw new Error('boom') } }) as ContextReliefDeps
    const broken = harness(throwingDeps)
    const brokenResult = broken.fire(makeEvent({ preparation: preparation({ tokensBefore: 20_000 }) }) as SessionBeforeCompactEvent)
    expect(brokenResult).toBeUndefined() // wrapper caught it, fail-open to LLM
  })
})
