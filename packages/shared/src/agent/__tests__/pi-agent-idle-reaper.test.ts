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

/** Shrink the idle-reclaim window to milliseconds for the suite. */
function withReaper<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CRAFT_PI_IDLE_REAPER_MS
  process.env.CRAFT_PI_IDLE_REAPER_MS = String(ms)
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.CRAFT_PI_IDLE_REAPER_MS
      else process.env.CRAFT_PI_IDLE_REAPER_MS = prev
    })
}

/**
 * Idle-reaper compaction-activity exemption (2026-10-08):
 * a compaction abandoned by an RPC timeout keeps running in the subprocess
 * (wild-meadow: ~299s of orphan burning). The reaper must defer instead of
 * killing mid-compaction — a kill turns a late-but-finite result into one that
 * NEVER arrives. Coverage: heartbeat routing, bounded deferral, terminal
 * reclaim, and the original no-op guards.
 */
describe('PiAgent idle reaper compaction activity', () => {
  it('routes compaction_progress heartbeats to the activity tracker', () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).lastCompactionProgressAt = null
    // Real message path: handleLine switch (previously dropped this message
    // type before it could reach handleSubprocessEvent).
    ;(agent as any).handleLine(JSON.stringify({ type: 'compaction_progress', elapsedMs: 30_000 }))
    expect((agent as any).lastCompactionProgressAt).toBeGreaterThan(0)
    agent.destroy()
  })

  it('defers reclaim while a compaction heartbeat is fresh, then re-arms', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(50, async () => {
      ;(agent as any).subprocess = { pid: 4242 }
      ;(agent as any).eventQueue.complete()
      ;(agent as any).compactionInFlight = true
      ;(agent as any).lastCompactionProgressAt = Date.now()
      const killed: string[] = []
      const lines: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = (m: string) => lines.push(m)

      ;(agent as any).scheduleIdleSubprocessReaper()
      await sleep(120) // past the 50ms fire point (and one re-arm cycle)

      expect(killed).toHaveLength(0)
      expect(lines.some((l) => l.includes('Idle reclaim deferred'))).toBe(true)
      expect(lines.some((l) => l.includes('defer #'))).toBe(true)
      expect((agent as any).idleSubprocessReaper).not.toBeNull() // re-armed, not dead
    })
    agent.destroy()
  })

  it('proceeds to reclaim after the deferral ceiling (bounded termination)', () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).subprocess = { pid: 4242 }
    ;(agent as any).eventQueue.complete()
    ;(agent as any).compactionInFlight = true
    ;(agent as any).lastCompactionProgressAt = Date.now()
    const killed: string[] = []
    const lines: string[] = []
    ;(agent as any).killSubprocess = () => killed.push('kill')
    ;(agent as any).debug = (m: string) => lines.push(m)

    for (let i = 0; i < 5; i++) {
      ;(agent as any).idleReaperFire()
    }
    expect(killed).toHaveLength(0) // first 5 fires defer
    expect(lines.filter((l) => l.includes('defer #')).length).toBe(5)

    ;(agent as any).idleReaperFire() // 6th fire: ceiling reached
    expect(killed).toHaveLength(1)
    expect(lines.some((l) => l.includes('Idle reclaim proceeding after 5 deferrals'))).toBe(true)
    agent.destroy()
  })

  it('reclaims as before when no compaction activity exists', () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).subprocess = { pid: 4242 }
    ;(agent as any).eventQueue.complete()
    const killed: string[] = []
    ;(agent as any).killSubprocess = () => killed.push('kill')

    ;(agent as any).idleReaperFire()
    expect(killed).toHaveLength(1)
    agent.destroy()
  })

  it('still never fires while a turn is in flight', () => {
    const agent = new PiAgent(createConfig())
    ;(agent as any).subprocess = { pid: 4242 }
    ;(agent as any).eventQueue.complete()
    ;(agent as any)._isProcessing = true
    ;(agent as any).lastCompactionProgressAt = Date.now()
    const killed: string[] = []
    ;(agent as any).killSubprocess = () => killed.push('kill')

    ;(agent as any).idleReaperFire()
    expect(killed).toHaveLength(0)
    agent.destroy()
  })

  it('reads CRAFT_PI_IDLE_REAPER_MS and falls back on garbage', () => {
    const agent = new PiAgent(createConfig())
    const prev = process.env.CRAFT_PI_IDLE_REAPER_MS
    try {
      expect((agent as any).getIdleReclaimMs()).toBe(600_000)
      process.env.CRAFT_PI_IDLE_REAPER_MS = '1234'
      expect((agent as any).getIdleReclaimMs()).toBe(1234)
      process.env.CRAFT_PI_IDLE_REAPER_MS = 'bogus'
      expect((agent as any).getIdleReclaimMs()).toBe(600_000)
    } finally {
      if (prev === undefined) delete process.env.CRAFT_PI_IDLE_REAPER_MS
      else process.env.CRAFT_PI_IDLE_REAPER_MS = prev
    }
    agent.destroy()
  })
})