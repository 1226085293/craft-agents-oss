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

  it('sets a system-stop state that blocks the retry ladder from reviving the turn', () => {
    // 2026-10-07 261007-pearl-amber: a busy-loop guardrail aborted the turn,
    // then the follow-on abort error re-armed the retry ladder and re-ran the
    // same looping model step forever. The guard must keep the ladder off.
    const agent = new PiAgent(createConfig())

    // Prime the processing state so tryBeginRetryLadder's guards otherwise pass.
    ;(agent as any)._isProcessing = true
    ;(agent as any).subprocess = { kill: () => {} } // non-null so the guard doesn't bail early

    // No system stop yet: the ladder would arm.
    const before = (agent as any).tryBeginRetryLadder('The operation was aborted', null)
    expect(before).toBe(true)
    // Clean up so the second call is a fair test.
    ;(agent as any).retryLadder.reset()
    ;(agent as any).retryTimer && clearTimeout((agent as any).retryTimer)
    ;(agent as any).retryTimer = null

    // Deliver a guardrail stop notice, then the follow-on abort error.
    ;(agent as any).handleLine(JSON.stringify({
      type: 'system_stop_notice',
      reason: 'no_progress',
      message: 'Turn aborted: 6 consecutive identical tool calls with no progress.',
    }))

    const after = (agent as any).tryBeginRetryLadder('The operation was aborted', null)
    expect(after).toBe(false)

    agent.destroy()
  })

  it('clears the system-stop state when a new turn starts', () => {
    const agent = new PiAgent(createConfig())

    ;(agent as any).systemStopReason = 'no_progress'
    ;(agent as any)._isProcessing = true
    ;(agent as any).subprocess = { kill: () => {} }
    expect((agent as any).tryBeginRetryLadder('The operation was aborted', null)).toBe(false)

    // Simulate a fresh turn resetting the state.
    ;(agent as any).systemStopReason = null
    ;(agent as any).retryLadder.reset()
    ;(agent as any).retryTimer && clearTimeout((agent as any).retryTimer)
    ;(agent as any).retryTimer = null
    expect((agent as any).tryBeginRetryLadder('The operation was aborted', null)).toBe(true)

    agent.destroy()
  })
})
