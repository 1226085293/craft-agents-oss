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
    settings: {} as never,
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
  it('subtracts discarded messages and adds the summary', () => {
    // 60k before, ~1k discarded (4k chars/4), summary 400 chars ≈ 100 tokens.
    const post = estimatePostReliefTokens(60_000, [{ content: 'x'.repeat(4000) }], 'y'.repeat(400))
    // Exact value depends on JSON serialization overhead — assert the range.
    expect(post).toBeGreaterThan(58_000)
    expect(post).toBeLessThan(60_000)
  })

  it('never goes negative', () => {
    const post = estimatePostReliefTokens(100, [], 'x'.repeat(4000))
    expect(post).toBeGreaterThan(100)
    expect(post).toBeLessThan(2000)
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

describe('handler — trivial remaining skips relief-first only', () => {
  it('returns a summary-less compaction (SDK LLM path runs), NOT undefined and NOT cancel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-16T06-53-23-001.md', { user: 'x' })
    const cp = { text: '[Context relief checkpoint — turns below were archived]' + 'y'.repeat(4000) }
    const result = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 20_000, messagesToSummarize: [cp] }) }),
      { sessionPath: dir },
    )
    // The pipeline is NOT abandoned: still a compaction result (SDK books it
    // and proceeds through its own threshold/LLM accounting), but with no
    // summary — so the SDK's _runDefaultCompaction runs the LLM fallback.
    expect(result).toBeDefined()
    expect(result!.cancel).toBeUndefined()
    expect(result!.compaction).toBeDefined()
    expect(result!.compaction!.summary).toBeUndefined()
    expect((result!.compaction!.details as { relief?: boolean }).relief).toBe(false)
    expect(result!.compaction!.firstKeptEntryId).toBe('kept-1')
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
  it('keeps before = retained + compacted exactly (one estimation basis)', () => {
    const msgs = [{ content: 'x'.repeat(40_000) }]  // ~10k tokens discarded
    const s = computeReliefStats(50_000, msgs, 'y'.repeat(400), true)
    expect(s.before).toBe(50_000)
    // The invariant the UI relies on: the three numbers never contradict.
    expect(s.retained + s.compacted).toBe(s.before)
    expect(s.compacted).toBe(Math.ceil(JSON.stringify(msgs).length / 4))
    expect(s.checkpoint).toBe(Math.ceil(400 / 4))
    expect(s.viaRelief).toBe(true)
  })

  it('clamps compacted to before when the payload looks larger than the context', () => {
    const s = computeReliefStats(1_000, [{ content: 'x'.repeat(40_000) }], '', false)
    expect(s.compacted).toBe(1_000)
    expect(s.retained).toBe(0)
    expect(s.viaRelief).toBe(false)
  })

  it('reports ~zero compacted when there is nothing to summarize', () => {
    // `JSON.stringify([])` is "[]" — 2 chars — so the floor is 1 token, not 0.
    const s = computeReliefStats(38_600, [], 'checkpoint', true)
    expect(s.compacted).toBe(1)
    expect(s.retained).toBe(38_599)
  })

  it('tolerates an unserializable payload', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const s = computeReliefStats(20_000, [cyclic], 'c', true)
    expect(s.compacted).toBe(0)
    expect(s.retained).toBe(20_000)
  })
})

describe('handler — stats on both paths', () => {
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

  it('LLM path reports viaRelief=false with the same before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-relief-'))
    dirs.push(dir)
    writeTurnFile(dir, '2026-10-17T04-00-08-001.md', { user: 'x' })
    const r = handleSessionBeforeCompact(
      makeEvent({ preparation: preparation({ tokensBefore: 100_000 }) }),
      { sessionPath: dir, reliefMaxTokens: 10_000 },
    )
    expect(r!.compaction!.summary).toBeUndefined()
    const stats = (r!.compaction!.details as { reliefStats?: { viaRelief: boolean; before: number } }).reliefStats!
    expect(stats.viaRelief).toBe(false)
    expect(stats.before).toBe(100_000)
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
    // Same pipeline: no summary → the SDK's LLM summarization runs.
    expect(result).toBeDefined()
    expect(result!.compaction!.summary).toBeUndefined()
    expect((result!.compaction!.details as { relief?: boolean }).relief).toBe(false)
    expect(result!.cancel).toBeUndefined()
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
