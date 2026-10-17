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
 * Install a live-subprocess stub so ensureSubprocess() takes the
 * "subprocess already ready" path without spawning a real bun process:
 * getConfiguredShellPath() -> undefined keeps the shell-path comparison a
 * no-op, and subprocessReady + subprocess look like a healthy child.
 */
function stubLiveSubprocess(agent: PiAgent, pid = 4242): void {
  ;(agent as any).getConfiguredShellPath = () => undefined
  ;(agent as any).subprocess = { pid }
  ;(agent as any).subprocessReady = Promise.resolve()
  ;(agent as any).subprocessShellPath = undefined
}

/** Turn ended: queue complete, no turn in flight, subprocess alive. */
function simulateTurnEnd(agent: PiAgent): void {
  ;(agent as any)._isProcessing = false
  ;(agent as any).eventQueue.complete()
  stubLiveSubprocess(agent)
}

/**
 * Post-turn activity leak regression (2026-10-14):
 * scheduleIdleSubprocessReaper() is armed only at turn end; title generation
 * and session-end memory extraction run AFTER that and go through
 * ensureSubprocess(), which cancelled the timer with no re-arm path — leaking
 * the ~400MB subprocess until app exit. The debounce at the ensureSubprocess
 * boundary must re-arm so "idle since the LAST activity" still reclaims.
 */
describe('PiAgent idle reaper post-turn activity debounce', () => {
  it('re-arms after post-turn activity and still reclaims after the idle window', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(60, async () => {
      simulateTurnEnd(agent)
      const killed: string[] = []
      const lines: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = (m: string) => lines.push(m)

      // Turn-end finally armed the reaper.
      ;(agent as any).scheduleIdleSubprocessReaper()
      expect((agent as any).idleSubprocessReaper).not.toBeNull()

      // Post-turn activity (memory extraction / title gen path): ensureSubprocess()
      // cancels the timer and — because no turn is in flight — re-arms it.
      await (agent as any).ensureSubprocess()
      expect((agent as any).idleSubprocessReaper).not.toBeNull()

      await sleep(150) // past the 60ms fire point

      expect(killed).toHaveLength(1)
      expect((agent as any).idleSubprocessReaper).toBeNull() // fired, not left dangling
      expect(lines.some((l) => l.includes('Idle 0min — reclaiming'))).toBe(true)
    })
    agent.destroy()
  })

  it('still reclaims when post-turn activity happens repeatedly (debounce, not one-shot)', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(80, async () => {
      simulateTurnEnd(agent)
      const killed: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = () => {}

      ;(agent as any).scheduleIdleSubprocessReaper()

      // Two post-turn activities spaced inside one window: each must rebase.
      await sleep(50)
      await (agent as any).ensureSubprocess()
      await sleep(50)
      await (agent as any).ensureSubprocess()
      // ~100ms after the LAST activity past the 80ms window — reclaim fires.
      await sleep(150)

      expect(killed).toHaveLength(1)
    })
    agent.destroy()
  })

  it('does not arm during an in-flight turn; turn-end still reclaims', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(60, async () => {
      ;(agent as any)._isProcessing = true
      ;(agent as any).eventQueue.reset() // new turn: queue open
      stubLiveSubprocess(agent)
      const killed: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = () => {}

      // In-turn activity must not arm (the turn-end finally owns re-arming).
      await (agent as any).ensureSubprocess()
      expect((agent as any).idleSubprocessReaper).toBeNull()

      // Turn ends -> finally arms -> reclaim after the window.
      simulateTurnEnd(agent)
      ;(agent as any).scheduleIdleSubprocessReaper()
      expect((agent as any).idleSubprocessReaper).not.toBeNull()
      await sleep(150)

      expect(killed).toHaveLength(1)
    })
    agent.destroy()
  })

  it('re-arms instead of dying when the timer fires into a fresh turn', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(50, async () => {
      simulateTurnEnd(agent)
      const killed: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = () => {}

      ;(agent as any).scheduleIdleSubprocessReaper()
      expect((agent as any).idleSubprocessReaper).not.toBeNull()

      // Race: the turn restarts right as the timer fires (chatImpl would
      // normally cancel it, but the callback can win the event-loop race).
      ;(agent as any)._isProcessing = true
      ;(agent as any).idleReaperFire()
      expect(killed).toHaveLength(0)
      expect((agent as any).idleSubprocessReaper).not.toBeNull() // re-armed, not dead

      // Once the turn ends the reaper still converges on a reclaim.
      ;(agent as any)._isProcessing = false
      ;(agent as any).eventQueue.complete()
      ;(agent as any).idleReaperFire()
      expect(killed).toHaveLength(1)
    })
    agent.destroy()
  })

  it('runMiniCompletion after a turn keeps the reclaim window anchored', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(60, async () => {
      simulateTurnEnd(agent)
      const killed: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = () => {}
      // Fake the subprocess RPC round-trip: reply on the next tick.
      ;(agent as any).send = (msg: any) => {
        if (msg.type === 'mini_completion') {
          setTimeout(
            () => (agent as any).handleMiniCompletionResult({ id: msg.id, text: 'ok' }),
            10,
          )
        }
      }

      ;(agent as any).scheduleIdleSubprocessReaper()
      const text = await (agent as any).runMiniCompletion('summarize the turn')
      expect(text).toBe('ok')
      // Post-turn mini completion (memory extraction / title gen) re-armed the reaper.
      expect((agent as any).idleSubprocessReaper).not.toBeNull()

      await sleep(150)
      expect(killed).toHaveLength(1)
    })
    agent.destroy()
  })

  it('queryLlm after a turn keeps the reclaim window anchored', async () => {
    const agent = new PiAgent(createConfig())
    await withReaper(60, async () => {
      simulateTurnEnd(agent)
      const killed: string[] = []
      ;(agent as any).killSubprocess = () => killed.push('kill')
      ;(agent as any).debug = () => {}
      ;(agent as any).send = (msg: any) => {
        if (msg.type === 'llm_query') {
          setTimeout(
            () =>
              (agent as any).handleLine(
                JSON.stringify({
                  type: 'llm_query_result',
                  id: msg.id,
                  result: { text: 'ok', model: 'test' },
                }),
              ),
            10,
          )
        }
      }

      ;(agent as any).scheduleIdleSubprocessReaper()
      const result = await (agent as any).queryLlm({ prompt: 'classify this' })
      expect(result?.text).toBe('ok')
      expect((agent as any).idleSubprocessReaper).not.toBeNull()

      await sleep(150)
      expect(killed).toHaveLength(1)
    })
    agent.destroy()
  })
})
