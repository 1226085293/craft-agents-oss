import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

/**
 * Regression tests for the 2026-10-22 261022-fluid-pulsar incident.
 *
 * The verification hold's silence is INTENTIONAL: the subprocess dispatched an
 * async LLM judge and holds the queue open, and NONE of that time produces a
 * subprocess event. The 300s turn-idle stall watchdog must not read that
 * silence as a dead stream — stall recovery (re-issuing the model step) would
 * kill the turn while the judge is still running and discard its verdict.
 */

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

/** Drain the events the agent enqueued (the same stream SessionManager sees). */
function drainEvents(agent: PiAgent): Array<Record<string, unknown>> {
  const queue = (agent as any).eventQueue
  const out = queue.queue as Array<Record<string, unknown>>
  queue.queue = []
  return out
}

function armProcessingTurn(agent: PiAgent): void {
  // The state a verification-held turn is in: the queue is open (NOT
  // complete) and the agent is still processing.
  ;(agent as any)._isProcessing = true
  ;(agent as any).abortReason = undefined
  ;(agent as any).lastTurnEventAt = Date.now()
}

describe('PiAgent stall watchdog vs verification hold (2026-10-22 fluid-pulsar)', () => {
  it('does NOT arm the turn-idle watchdog while the verification hold is open', () => {
    const agent = new PiAgent(createConfig())
    armProcessingTurn(agent)
    // The subprocess's async judge owns the wait now.
    ;(agent as any).adapter.isVerificationHeld = () => true

    ;(agent as any).refreshTurnIdleWatchdog()

    expect((agent as any).turnIdleTimer).toBeNull()
    agent.destroy()
  })

  it('still arms the watchdog when no verification hold is open', () => {
    const agent = new PiAgent(createConfig())
    armProcessingTurn(agent)
    ;(agent as any).adapter.isVerificationHeld = () => false

    ;(agent as any).refreshTurnIdleWatchdog()

    expect((agent as any).turnIdleTimer).not.toBeNull()
    agent.destroy()
  })

  it('a timer that fired into a verification hold is not read as a stalled stream', () => {
    const agent = new PiAgent(createConfig())
    armProcessingTurn(agent)
    ;(agent as any).adapter.isVerificationHeld = () => true
    let sent = 0
    ;(agent as any).send = () => { sent += 1 }

    // A timer armed before the hold opened fires: it must return quietly
    // rather than enqueueing a stall error or re-issuing the model step.
    ;(agent as any).handleTurnIdleTimeout(300_000)

    expect(sent).toBe(0)
    expect(drainEvents(agent)).toEqual([])
    agent.destroy()
  })
})
