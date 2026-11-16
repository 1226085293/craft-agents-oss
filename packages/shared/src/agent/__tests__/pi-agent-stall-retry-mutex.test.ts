import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

/**
 * Regression guard for 2026-11-16 (session 261110-brave-titanium): the
 * subprocess aborts a silent turn with "Turn stalled", emits a synthetic
 * agent_end, and the HOST re-issues the model step via `retry`. The synthetic
 * agent_end used to complete the event queue under the retried run — the turn
 * silently ended, the retried run became an orphan, and the next prompt hit
 * "Agent is already processing a prompt".
 *
 * The mutex: while the stall retry is in flight (from the retry send until the
 * retried run emits its first REAL event), an agent_end must not complete the
 * queue. The retried run's own terminal agent_end (after real events) still
 * does.
 */

const STALL_MESSAGE = 'Turn stalled: no activity for 90s — aborting (timeout 90s).';

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

function makeAgent() {
  const agent = new PiAgent(createConfig())
  const sent: any[] = []
  // Isolate from the real adapter FSM and queue side effects: this test
  // targets the stall-retry mutex around queue completion.
  ;(agent as any).adapter.adaptEvent = () => []
  ;(agent as any).adapter.shouldCompleteQueue = () => true
  ;(agent as any).eventQueue.enqueue = (event: any) => {
    return event
  }
  // Let resendModelStep pass its subprocess guard so the emitted `retry` is
  // observable through the send spy.
  ;(agent as any)._isProcessing = true
  ;(agent as any).subprocess = { stdin: { writable: true }, kill: () => {} }
  ;(agent as any).send = (msg: any) => {
    sent.push(msg)
  }
  const stallError = (message: string) =>
    (agent as any).handleLine(JSON.stringify({ type: 'error', message }))
  const sdkEvent = (event: Record<string, unknown>) =>
    (agent as any).handleLine(JSON.stringify({ type: 'event', event }))
  return { agent, sent, stallError, sdkEvent }
}

describe('PiAgent stall-retry mutex', () => {
  it('marks the retry in flight on a subprocess stall error and re-issues the model step', () => {
    const { agent, sent, stallError } = makeAgent()

    stallError(STALL_MESSAGE)

    expect((agent as any).stallRetryInFlight).toBe(true)
    expect(sent.some((m: any) => m.type === 'retry')).toBe(true)
    ;(agent as any).clearStallRestartWatchdog()
    agent.destroy()
  })

  it('defers queue completion on the aborted run\'s synthetic agent_end while the retry is in flight', () => {
    const { agent, stallError, sdkEvent } = makeAgent()

    stallError(STALL_MESSAGE)
    sdkEvent({ type: 'agent_end', messages: [], willRetry: false })

    // The aborted run's terminal event must NOT close the turn under the
    // retry that owns it.
    expect((agent as any).eventQueue.isComplete).toBe(false)
    ;(agent as any).clearStallRestartWatchdog()
    agent.destroy()
  })

  it('lifts the mutex when the retried run emits a real event, so its own agent_end completes the turn', () => {
    const { agent, stallError, sdkEvent } = makeAgent()

    stallError(STALL_MESSAGE)
    sdkEvent({ type: 'agent_end', messages: [], willRetry: false })
    expect((agent as any).eventQueue.isComplete).toBe(false)
    expect((agent as any).stallRetryInFlight).toBe(true)

    // Retried run starts producing: stream delta / tool start prove the
    // recovery owns the run.
    ;(agent as any).recordSubprocessTurnProgress('message_update', {})
    expect((agent as any).stallRetryInFlight).toBe(false)

    // The retried run's own terminal event now completes normally.
    sdkEvent({ type: 'agent_end', messages: [], willRetry: false })
    expect((agent as any).eventQueue.isComplete).toBe(true)
    ;(agent as any).clearStallRestartWatchdog()
    agent.destroy()
  })

  it('lets a non-agent_end completion signal (e.g. drained overflow) close the queue even while the mutex is set', () => {
    const { agent, stallError, sdkEvent } = makeAgent()

    stallError(STALL_MESSAGE)
    // e.g. compaction_end draining a held overflow — not an agent_end, so the
    // mutex must not defer it.
    ;(agent as any).handleSubprocessEvent({ type: 'compaction_end' })
    expect((agent as any).eventQueue.isComplete).toBe(true)
    ;(agent as any).clearStallRestartWatchdog()
    agent.destroy()
  })
})