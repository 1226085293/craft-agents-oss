import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { AbortReason } from '../core/session-lifecycle.ts'

/**
 * Regression tests for the 2026-10-16 261016-deft-tide incident: a user stop
 * that lands while chat() is still lazily spawning the Pi subprocess (which
 * only happens AFTER the MCP source probes resolve, ~1.2 s in) had its
 * `{type:'abort'}` silently dropped by send()'s stdin-writability guard.
 * The subprocess then ran the prompt to completion and its tool blocks
 * surfaced below the "Response interrupted" marker.
 *
 * The fix latches the stop (pendingUserStop) when no subprocess exists,
 * suppresses the prompt send in chatImpl when the latch is present after
 * ensureSubprocess, and clears stale latches at the start of each turn.
 */

// Unique root/session per run: the retry ladder restores persisted rows from
// the session dir, and parallel test runs share /tmp — a stale active row for
// a shared session id would re-arm timers that fire `send({type:'retry'})`
// mid-test and break the sent-calls assertions.
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

/** Capture every command the agent tries to write to the subprocess. */
function spyOnSend(agent: PiAgent): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = []
  ;(agent as any).send = (cmd: Record<string, unknown>) => {
    sent.push(cmd)
  }
  return sent
}

describe('PiAgent user stop before subprocess spawn', () => {
  it('forceAbort(UserStop) latches the stop when no subprocess exists', () => {
    const agent = new PiAgent(createConfig())
    const sent = spyOnSend(agent)

    // No subprocess has been spawned yet (this.subprocess === null) — the
    // exact state during the lazy spawn window inside chat().
    agent.forceAbort(AbortReason.UserStop)

    expect(sent).toHaveLength(0)
    expect((agent as any).pendingUserStop).toBe(true)
    agent.destroy()
  })

  it('forceAbort(UserStop) delivers the abort directly when stdin is writable', () => {
    const agent = new PiAgent(createConfig())
    // A healthy, spawned subprocess.
    ;(agent as any).subprocess = { stdin: { writable: true }, kill: () => {} }
    const sent = spyOnSend(agent)

    agent.forceAbort(AbortReason.UserStop)

    expect(sent).toContainEqual({ type: 'abort' })
    expect((agent as any).pendingUserStop).toBe(false)
    agent.destroy()
  })

  it('soft abort() latches the stop when no subprocess exists', async () => {
    const agent = new PiAgent(createConfig())
    const sent = spyOnSend(agent)

    await agent.abort('user stop')

    expect(sent).toEqual([])
    expect((agent as any).pendingUserStop).toBe(true)
    agent.destroy()
  })

  it('suppresses the prompt when a stop lands during the spawn window', async () => {
    const agent = new PiAgent(createConfig())
    const sent = spyOnSend(agent)
    // Simulate the lazy spawn: ensureSubprocess completes, and while it was
    // "spawning" the user's stop landed (latched by forceAbort).
    ;(agent as any).ensureSubprocess = async () => {
      ;(agent as any).pendingUserStop = true
    }

    const gen = (agent as any).chatImpl('hello', undefined, undefined)
    const events: unknown[] = []
    for (;;) {
      const r = await gen.next()
      if (r.done) break
      events.push(r.value)
    }

    // The prompt must never reach the subprocess, no events surface, and the
    // latch is consumed so it cannot suppress the next turn.
    expect(sent.some((c) => c.type === 'prompt')).toBe(false)
    expect(events).toHaveLength(0)
    expect((agent as any).pendingUserStop).toBe(false)
    agent.destroy()
  })

  it('a stale latch left by an abandoned turn is cleared at turn start', async () => {
    const agent = new PiAgent(createConfig())
    const sent = spyOnSend(agent)
    ;(agent as any).ensureSubprocess = async () => {}
    // A latch that survived a previous turn whose generator never consumed it
    // (e.g. the spawn failed and the turn died in the catch path).
    ;(agent as any).pendingUserStop = true

    const gen = (agent as any).chatImpl('hello', undefined, undefined)
    const first = gen.next()
    // The prompt was sent and the generator is now draining the event queue.
    ;(agent as any).eventQueue.complete()
    await first

    expect(sent.some((c) => c.type === 'prompt')).toBe(true)
    expect((agent as any).pendingUserStop).toBe(false)
    agent.destroy()
  })
})
