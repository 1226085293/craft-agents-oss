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
 * Task ④ (2026-10-08): requestCompact moves from a single fixed 300s timer to
 * a two-verdict architecture — an absolute cap (never re-armed) and an
 * activity window (re-armed by every compaction_progress heartbeat). This
 * deletes the original wild-meadow failure class: a healthy 599s compaction
 * with heartbeats flowing must never be killed.
 */
describe('PiAgent compact dual timers (cap + staleness)', () => {
  function harness(extra: Record<string, string>): {
    agent: PiAgent
    sent: object[]
    request: Promise<unknown>
    /** Send a compaction_progress heartbeat through the real handleLine path. */
    heartbeat(): void
    /** Deliver a compact_result through the real handleLine path. */
    finish(success?: boolean): void
    cleanup(): void
  } {
    const agent = new PiAgent(createConfig())
    const sent: object[] = []
    ;(agent as any).ensureSubprocess = async () => {}
    ;(agent as any).send = (m: object) => sent.push(m)
    const prevCap = process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
    const prevStale = process.env.CRAFT_PI_COMPACT_STALENESS_MS
    for (const [k, v] of Object.entries(extra)) process.env[k] = v
    const request = (agent as any).requestCompact() as Promise<unknown>
    const h = {
      agent,
      sent,
      request,
      heartbeat: () =>
        // REAL wire format: the subprocess wraps heartbeats under
        // { type: 'event', event: { type: 'compaction_progress' } } (see
        // index.ts startCompactionProgress). A top-level
        // { type: 'compaction_progress' } never occurs on the real link —
        // the 2026-10-08 false-stall incident (two reproductions) was
        // caused by tests feeding the top-level format while the nested
        // format skipped the re-arm. Keep the wires exact here.
        (agent as any).handleLine(
          JSON.stringify({ type: 'event', event: { type: 'compaction_progress', elapsedMs: 30_000 } }),
        ),
      finish: (success = true) =>
        (agent as any).handleLine(
          JSON.stringify({
            type: 'compact_result',
            id: 'compact-1',
            success,
            ...(success ? { result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 42 } } : {}),
            ...(success ? {} : { errorMessage: 'boom' }),
          }),
        ),
      cleanup: () => {
        agent.destroy()
        if (prevCap === undefined) delete process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
        else process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = prevCap
        if (prevStale === undefined) delete process.env.CRAFT_PI_COMPACT_STALENESS_MS
        else process.env.CRAFT_PI_COMPACT_STALENESS_MS = prevStale
      },
    }
    return h
  }

  it('does not fire while heartbeats keep re-arming the activity window', async () => {
    // stale=200ms, cap=3000ms: five heartbeat cycles (60ms gaps, well inside
    // the stale window) must pass without a stall verdict — the scaled
    // equivalent of the 599s healthy compaction under the old 300s timer.
    const h = harness({ CRAFT_PI_COMPACT_STALENESS_MS: '200', CRAFT_PI_COMPACT_RPC_TIMEOUT_MS: '3000' })
    try {
      let settled = false
      h.request.then(
        () => (settled = true),
        () => (settled = true),
      )
      for (let i = 0; i < 5; i++) {
        await sleep(60)
        h.heartbeat()
      }
      await sleep(20)
      expect(settled).toBe(false) // alive — no stall, no cap (3000ms far away)

      // Complete normally: the request resolves AND pending is cleaned.
      h.finish()
      const result = await h.request
      expect(result).toEqual({ summary: 's', firstKeptEntryId: 'e', tokensBefore: 42 })
      expect(h.sent.some((m) => (m as any).type === 'compact')).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('re-arms on a top-level compaction_progress too (regression: dead branch)', async () => {
    // The subprocess only ever sends the nested format, but the top-level
    // case (pi-agent.ts handleLine) must keep working if the emit ever
    // changes — it funnels through the same handleSubprocessEvent now, so
    // both formats must re-arm the stale timer.
    const h = harness({ CRAFT_PI_COMPACT_STALENESS_MS: '200', CRAFT_PI_COMPACT_RPC_TIMEOUT_MS: '3000' })
    try {
      let settled = false
      h.request.then(
        () => (settled = true),
        () => (settled = true),
      )
      for (let i = 0; i < 5; i++) {
        await sleep(60)
        ;(h.agent as any).handleLine(JSON.stringify({ type: 'compaction_progress', elapsedMs: 30_000 }))
      }
      await sleep(20)
      expect(settled).toBe(false)
      h.finish()
      expect(await h.request).toEqual({ summary: 's', firstKeptEntryId: 'e', tokensBefore: 42 })
    } finally {
      h.cleanup()
    }
  })

  it('stalls with the distinguishable message when heartbeats go silent', async () => {
    const h = harness({ CRAFT_PI_COMPACT_STALENESS_MS: '100', CRAFT_PI_COMPACT_RPC_TIMEOUT_MS: '5000' })
    // Keep the event loop alive: Bun does not fire unref'd timers while no
    // other handles are active (Node would), so the stall verdict (fired by
    // an unref'd timer) needs a live handle to be delivered.
    const keepalive = setInterval(() => {}, 50)
    try {
      // NOTE: avoid bun's expect().rejects here (it hung this suite); assert
      // via explicit catch capture.
      const error: { value: Error | null } = { value: null }
      await h.request.catch((e: Error) => (error.value = e))
      expect(error.value).not.toBeNull()
      expect(error.value!.message).toContain('compact stalled: no heartbeat')
      expect(error.value!.message).toContain('Compaction may still be running in the background')
      expect((h.agent as any).pendingCompactions.size).toBe(0)
    } finally {
      clearInterval(keepalive)
      h.cleanup()
    }
  })

  it('caps even while heartbeats flow — distinct budget message', async () => {
    // stale window > cap: cap must win even with continuous heartbeats.
    const h = harness({ CRAFT_PI_COMPACT_STALENESS_MS: '3000', CRAFT_PI_COMPACT_RPC_TIMEOUT_MS: '150' })
    try {
      const timer = setInterval(() => h.heartbeat(), 40)
      const error: { value: Error | null } = { value: null }
      try {
        await h.request.catch((e: Error) => (error.value = e))
        expect(error.value).not.toBeNull()
        expect(error.value!.message).toContain('compact exceeded total budget')
        expect(error.value!.message).toContain('(heartbeats active)')
        expect(error.value!.message).toContain('Compaction may still be running in the background')
      } finally {
        clearInterval(timer)
      }
      expect((h.agent as any).pendingCompactions.size).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  it('cleans both timers on rejection (no late double-fire)', async () => {
    const h = harness({ CRAFT_PI_COMPACT_STALENESS_MS: '100', CRAFT_PI_COMPACT_RPC_TIMEOUT_MS: '5000' })
    const keepalive = setInterval(() => {}, 50) // see unref-timer note above
    try {
      // Container for the same control-flow-narrowing reason as elsewhere:
      // a plain `let` assigned in a closure narrows to its null initializer.
      const error: { value: Error | null } = { value: null }
      await h.request.catch((e: Error) => (error.value = e))
      expect(error.value?.message).toContain('no heartbeat')
      // The settled guard makes a second timer fire a no-op; a promise can
      // only settle once, so the observable contract is: pending map cleaned
      // (both timers cleared) and no stray entries until the cap would have
      // fired (0.5x cap window here — well inside the 5s cap).
      await sleep(200)
      expect((h.agent as any).pendingCompactions.size).toBe(0)
      // Cap timer was cleared too: waiting past these windows must not reject
      // again (nothing observable beyond pending-map cleanliness — assert the
      // map stayed empty and no unhandled rejection surfaced).
      expect((h.agent as any).pendingCompactions.size).toBe(0)
    } finally {
      clearInterval(keepalive)
      h.cleanup()
    }
  })

  it('reads cap/staleness env with sane defaults and fallbacks', () => {
    const agent = new PiAgent(createConfig())
    const prevCap = process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
    const prevStale = process.env.CRAFT_PI_COMPACT_STALENESS_MS
    try {
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(900_000) // cap default
      expect((agent as any).getCompactStalenessMs()).toBe(120_000) // stale default
      process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = '30000'
      process.env.CRAFT_PI_COMPACT_STALENESS_MS = '5000'
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(30_000)
      expect((agent as any).getCompactStalenessMs()).toBe(5000)
      process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = 'nope'
      expect((agent as any).getCompactRpcTimeoutMs()).toBe(900_000)
      process.env.CRAFT_PI_COMPACT_STALENESS_MS = 'nope'
      expect((agent as any).getCompactStalenessMs()).toBe(120_000)
    } finally {
      if (prevCap === undefined) delete process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS
      else process.env.CRAFT_PI_COMPACT_RPC_TIMEOUT_MS = prevCap
      if (prevStale === undefined) delete process.env.CRAFT_PI_COMPACT_STALENESS_MS
      else process.env.CRAFT_PI_COMPACT_STALENESS_MS = prevStale
    }
    agent.destroy()
  })
})
