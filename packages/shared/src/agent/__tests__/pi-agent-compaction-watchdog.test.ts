import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

/**
 * Compress the two relevant timers to milliseconds for the suite:
 * plain turn-idle watchdog 120s -> 20ms; compaction cap 5min -> 100ms.
 */
function withTimers<T>(capMs: number, fn: () => Promise<T>): Promise<T> {
  const prevTurn = process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
  const prevCap = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
  process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = '20'
  process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = String(capMs)
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevTurn === undefined) delete process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS
      else process.env.CRAFT_PI_TURN_IDLE_TIMEOUT_MS = prevTurn
      if (prevCap === undefined) delete process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
      else process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = prevCap
    })
}

function startTurn(agent: PiAgent): {
  enqueued: any[]
  queue: { isComplete: boolean; complete(): void }
} {
  const enqueued: any[] = []
  const q = (agent as any).eventQueue
  q.enqueue = (event: any) => {
    enqueued.push(event)
  }
  // NOTE: do NOT assign q.isComplete (readonly) — in these suites the
  // watchdog must still be able to fire, so the real flag stays false.
  q.complete = () => {
    enqueued.push({ type: 'queue_complete' })
  }
  ;(agent as any)._isProcessing = true
  ;(agent as any).adapter.startTurn()
  return { enqueued, queue: q }
}

/** 2026-10-04 incident regression: while the Pi SDK compacts, the main stream
 *  is silent — the plain 120s turn watchdog must NOT fire; the compaction cap
 *  (here 100ms) governs instead. */
describe('PiAgent compaction-aware turn-idle watchdog', () => {
  it('does not false-positive the plain stall while compaction is in flight', async () => {
    const agent = new PiAgent(createConfig())
    // Cap 400ms vs 20ms plain ceiling: a plain watchdog would have fired at
    // 20ms; with the cap honored, nothing may fire at 200ms.
    await withTimers(400, async () => {
      const { enqueued } = startTurn(agent)
      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_start',
        toolName: 'Bash',
        toolCallId: 'tool-1',
        args: {},
      })
      ;(agent as any).handleSubprocessEvent({
        type: 'tool_execution_end',
        toolName: 'Bash',
        toolCallId: 'tool-1',
        result: 'done',
        isError: false,
      })

      // Threshold compaction begins — silence follows (no SDK events).
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_start' })

      await sleep(200) // past the 20ms plain ceiling, inside the 400ms cap

      const errors = enqueued.filter((e) => e.type === 'error')
      expect(errors).toHaveLength(0)
    })
    agent.destroy()
  })

  it('heartbeats refresh the timer but never extend the capped deadline', async () => {
    const agent = new PiAgent(createConfig())
    await withTimers(100, async () => {
      const { enqueued } = startTurn(agent)
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_start' })

      // In-flight heartbeats (server emits these every ~30s).
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_progress', elapsedMs: 40_000 })
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_progress', elapsedMs: 80_000 })
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_progress', elapsedMs: 120_000 })

      // The deadline is pinned to start + cap (100ms here), so even with
      // heartbeats the capped timer still fires ~100ms after start.
      await sleep(300)

      const error = enqueued.find((e) => e.type === 'error')
      expect(error?.message).toContain('Context compaction did not finish')
      expect(error?.message).not.toContain('stream stalled')
      expect(enqueued.at(-1)?.type).toBe('queue_complete')
    })
    agent.destroy()
  })

  it('resumes the plain watchdog after compaction_end', async () => {
    const agent = new PiAgent(createConfig())
    await withTimers(100, async () => {
      const { enqueued } = startTurn(agent)
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_start' })
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_end', result: { estimatedTokensAfter: 1000 } })

      // Back to the plain ceiling: 20ms of idle after all activity → stall.
      await sleep(100)

      const error = enqueued.find((e) => e.type === 'error')
      expect(error?.message).toContain('stream stalled')
      expect(enqueued.some((e) => e.type === 'error' && e.message.includes('did not finish'))).toBe(false)
    })
    agent.destroy()
  })

  it('clears stale compaction state on agent_end so the next cycle stays plain', async () => {
    const agent = new PiAgent(createConfig())
    await withTimers(100, async () => {
      const { enqueued } = startTurn(agent)
      // compaction_start without a matching end (missed event), then agent_end.
      ;(agent as any).handleSubprocessEvent({ type: 'compaction_start' })
      await sleep(50)
      ;(agent as any).handleSubprocessEvent({ type: 'agent_end', messages: [], willRetry: false })

      // A fresh idle cycle re-arms the watchdog. If agent_end had NOT cleared
      // the stale cap flag, the expired compaction deadline would fire the
      // capped 'did not finish' error immediately; with the fix, the plain
      // 20ms ceiling governs instead.
      ;(agent as any).refreshTurnIdleWatchdog()
      await sleep(120)

      const error = enqueued.find((e) => e.type === 'error')
      expect(error?.message).toContain('stream stalled')
      expect(enqueued.some((e) => e.type === 'error' && e.message.includes('did not finish'))).toBe(false)
    })
    agent.destroy()
  })
})

describe('PiAgent compaction idle cap configuration', () => {
  it('defaults to 300s (matches the waitForCompaction / requestCompact precedent)', () => {
    const agent = new PiAgent(createConfig())
    const prev = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
    delete process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
    try {
      expect((agent as any).getCompactionIdleTimeoutMs()).toBe(300_000)
    } finally {
      if (prev !== undefined) process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = prev
      agent.destroy()
    }
  })

  it('honors a positive env override and falls back on garbage', () => {
    const agent = new PiAgent(createConfig())
    const prev = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
    try {
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = '600000'
      expect((agent as any).getCompactionIdleTimeoutMs()).toBe(600_000)
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = 'bogus'
      expect((agent as any).getCompactionIdleTimeoutMs()).toBe(300_000)
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = '0'
      expect((agent as any).getCompactionIdleTimeoutMs()).toBe(300_000)
    } finally {
      if (prev !== undefined) process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = prev
      else delete process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS
      agent.destroy()
    }
  })
})
