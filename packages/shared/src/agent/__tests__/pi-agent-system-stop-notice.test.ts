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
})
