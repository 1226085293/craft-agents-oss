import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

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

describe('PiAgent system stop notice plumbing', () => {
  it('maps system_stop_notice from the subprocess to an info event with statusType + stopReason', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({
      type: 'system_stop_notice',
      reason: 'busy_limit',
      message: 'Turn aborted: exceeded 500 tool calls in a single turn (busy-limit guardrail).',
    }))

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe('info')
    expect(enqueued[0].statusType).toBe('system_stop')
    expect(enqueued[0].stopReason).toBe('busy_limit')
    expect(enqueued[0].message).toContain('busy-limit guardrail')

    agent.destroy()
  })

  it('falls back to system_stop reason when the subprocess omits the fields', () => {
    const agent = new PiAgent(createConfig())

    const enqueued: any[] = []
    ;(agent as any).eventQueue.enqueue = (event: any) => {
      enqueued.push(event)
    }

    ;(agent as any).handleLine(JSON.stringify({ type: 'system_stop_notice' }))

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe('info')
    expect(enqueued[0].statusType).toBe('system_stop')
    expect(enqueued[0].stopReason).toBe('system_stop')
    expect(enqueued[0].message).toContain('stopped by the system')

    agent.destroy()
  })

  it('sets a system-stop state that blocks stall recovery from reviving the turn', () => {
    // 2026-10-07 261007-pearl-amber: a busy-loop guardrail aborted the turn;
    // a follow-on stall must not re-issue the same looping model step forever.
    const agent = new PiAgent(createConfig())

    ;(agent as any)._isProcessing = true
    ;(agent as any).subprocess = { kill: () => {}, stdin: { writable: true } }
    let sent = 0
    ;(agent as any).send = () => { sent += 1 }

    // No system stop yet: the stall path re-issues the model step.
    ;(agent as any).handleTurnIdleTimeout(1000)
    expect(sent).toBe(1)

    // Deliver a guardrail stop notice, then a follow-on stall.
    ;(agent as any).handleLine(JSON.stringify({
      type: 'system_stop_notice',
      reason: 'no_progress',
      message: 'Turn aborted: 6 consecutive identical tool calls with no progress.',
    }))

    ;(agent as any).handleTurnIdleTimeout(1000)
    expect(sent).toBe(1) // blocked while the guardrail stop stands

    agent.destroy()
  })

  it('clears the system-stop state when a new turn starts', () => {
    const agent = new PiAgent(createConfig())

    ;(agent as any).systemStopReason = 'no_progress'
    ;(agent as any)._isProcessing = true
    ;(agent as any).subprocess = { kill: () => {}, stdin: { writable: true } }
    let sent = 0
    ;(agent as any).send = () => { sent += 1 }

    ;(agent as any).handleTurnIdleTimeout(1000)
    expect(sent).toBe(0) // blocked while set

    // Simulate a fresh turn resetting the state.
    ;(agent as any).systemStopReason = null
    ;(agent as any).handleTurnIdleTimeout(1000)
    expect(sent).toBe(1)

    agent.destroy()
  })
})
