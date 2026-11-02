import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

/**
 * The manual `/compact` path (PiAgent.chatImpl) emits the token row
 *   压缩完成：约 A → B（保留 R，压缩 S）
 * from the subprocess's compact_result. Regression suite for 2026-11-01
 * session 261101-eager-fountain: the row showed
 *   "约 453.4k → 20.0k（保留 20.0k，压缩 427.5k）"
 * because the arrow target was built as `retained + checkpoint` — the
 * subprocess's MEASURED kept region, which stops at the keepRecentTokens
 * floor (20k) and under-reports what the SDK actually kept (25.9k). It
 * disagreed with the context ring and with its own arithmetic.
 */

// Unique root/session per run: the retry ladder restores persisted rows from
// the session dir, so a shared session id would re-arm timers mid-test.
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: `ws-${runId}`,
      name: 'Test Workspace',
      rootPath: `/tmp/craft-agent-test-${runId}`,
    } as any,
    session: {
      id: `session-${runId}`,
      workspaceRootPath: `/tmp/craft-agent-test-${runId}`,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

/** Drive a /compact turn and collect every yielded event. */
async function runCompactTurn(
  agent: PiAgent,
  compactResult: Record<string, unknown>,
): Promise<Array<Record<string, any>>> {
  ;(agent as any).ensureSubprocess = async () => {}
  ;(agent as any).requestCompact = async () => compactResult
  ;(agent as any).extractSessionMemories = async () => {}

  const gen = (agent as any).chatImpl('/compact', undefined, undefined)
  const events: Array<Record<string, any>> = []
  for (;;) {
    const r = await gen.next()
    if (r.done) break
    events.push(r.value as Record<string, any>)
  }
  return events
}

function findSummary(events: Array<Record<string, any>>): Record<string, any> | undefined {
  return events.find((e) => e.statusType === 'compaction_summary')
}

describe('PiAgent manual /compact token row', () => {
  it('reports the SDK post-compaction size, not the measured keepRecent floor', async () => {
    const agent = new PiAgent(createConfig())

    const events = await runCompactTurn(agent, {
      summary: 's',
      firstKeptEntryId: 'e',
      tokensBefore: 453_400,
      // what the SDK re-estimated for the compacted context (the ring's value)
      estimatedTokensAfter: 25_900,
      // what the relief hook measured — the 20k keepRecent floor
      stats: { before: 453_400, retained: 20_000, compacted: 427_500, checkpoint: 0, viaRelief: false },
    })

    const summary = findSummary(events)
    expect(summary).toBeDefined()
    expect(summary!.statusParams).toMatchObject({
      before: 453_400,
      after: 25_900,
      retained: 25_900,
      compacted: 427_500,
      checkpoint: 0,
      viaRelief: 0,
    })
    // the row adds up
    const p = summary!.statusParams as Record<string, number>
    expect(Number(p.retained) + Number(p.checkpoint) + Number(p.compacted)).toBe(Number(p.before))
    agent.destroy()
  })

  it('keeps the relief checkpoint out of retained on the fast path', async () => {
    const agent = new PiAgent(createConfig())

    const events = await runCompactTurn(agent, {
      summary: 's',
      firstKeptEntryId: 'e',
      tokensBefore: 366_600,
      estimatedTokensAfter: 20_200,
      stats: { before: 366_600, retained: 20_000, compacted: 346_400, checkpoint: 200, viaRelief: true },
    })

    expect(findSummary(events)!.statusParams).toMatchObject({
      before: 366_600,
      after: 20_200,
      retained: 20_000,
      compacted: 346_400,
      checkpoint: 200,
      viaRelief: 1,
    })
    agent.destroy()
  })

  it('still renders a row when the backend reports no stats at all', async () => {
    const agent = new PiAgent(createConfig())

    const events = await runCompactTurn(agent, {
      summary: 's',
      firstKeptEntryId: 'e',
      tokensBefore: 100_000,
      estimatedTokensAfter: 9_000,
    })

    expect(findSummary(events)!.statusParams).toMatchObject({
      before: 100_000,
      after: 9_000,
      retained: 9_000,
      compacted: 91_000,
      checkpoint: 0,
      viaRelief: 0,
    })
    agent.destroy()
  })
})
