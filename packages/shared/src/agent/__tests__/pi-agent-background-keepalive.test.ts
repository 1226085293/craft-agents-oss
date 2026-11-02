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

/** The subprocess event handler is private; tests drive it directly. */
function send(agent: PiAgent, event: Record<string, unknown>): void {
  ;(agent as any).handleSubprocessEvent(event)
}

function sendToolStart(agent: PiAgent, toolName: string, toolCallId: string): void {
  send(agent, { type: 'tool_execution_start', toolName, toolCallId, input: {} })
}

function sendToolEnd(agent: PiAgent, toolCallId: string, result: string): void {
  send(agent, { type: 'tool_execution_end', toolCallId, result, isError: false })
}

/** Turn ended with a live subprocess so the idle reaper can be armed. */
function simulateTurnEnd(agent: PiAgent): void {
  ;(agent as any).getConfiguredShellPath = () => undefined
  ;(agent as any).subprocess = { pid: 4242 }
  ;(agent as any).subprocessReady = Promise.resolve()
  ;(agent as any).subprocessShellPath = undefined
  ;(agent as any)._isProcessing = false
  ;(agent as any).eventQueue.complete()
}

describe('PiAgent background-task keep-alive', () => {
  it('detects the 30s auto-background handoff, forwards it, and blocks idle reclaim', () => {
    const agent = new PiAgent(createConfig())
    const forwarded: any[] = []
    agent.setBackgroundEventSink((event) => forwarded.push(event))

    sendToolStart(agent, 'Bash', 'toolu_bash_1')
    sendToolEnd(
      agent,
      'toolu_bash_1',
      [
        'Command is still running after 30s and was moved to the background.',
        'shell_id: shell_123',
        'output_file: /tmp/bg.log',
      ].join('\n'),
    )

    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].type).toBe('tool_result')
    expect(forwarded[0].toolName).toBe('Bash')
    expect((agent as any).backgroundTasksPending).toBe(true)

    simulateTurnEnd(agent)
    ;(agent as any).scheduleIdleSubprocessReaper()
    expect((agent as any).idleSubprocessReaper).toBeNull()
  })

  it('clears pending when list_background_tasks reports none and re-arms the reaper', () => {
    const agent = new PiAgent(createConfig())
    const forwarded: any[] = []
    agent.setBackgroundEventSink((event) => forwarded.push(event))

    sendToolStart(agent, 'Bash', 'toolu_bash_2')
    sendToolEnd(
      agent,
      'toolu_bash_2',
      'Command is still running after 30s and was moved to the background.\nshell_id: shell_456',
    )
    expect((agent as any).backgroundTasksPending).toBe(true)

    sendToolStart(agent, 'list_background_tasks', 'toolu_list_1')
    sendToolEnd(agent, 'toolu_list_1', 'No background tasks.')

    expect((agent as any).backgroundTasksPending).toBe(false)
    expect(forwarded).toHaveLength(2)

    simulateTurnEnd(agent)
    ;(agent as any).scheduleIdleSubprocessReaper()
    expect((agent as any).idleSubprocessReaper).not.toBeNull()
    ;(agent as any).cancelIdleSubprocessReaper()
  })

  it('keeps pending while list_background_tasks still reports a running task', () => {
    const agent = new PiAgent(createConfig())

    sendToolStart(agent, 'Bash', 'toolu_bash_3')
    sendToolEnd(
      agent,
      'toolu_bash_3',
      'Command is still running after 30s and was moved to the background.\nshell_id: shell_789',
    )

    sendToolStart(agent, 'list_background_tasks', 'toolu_list_2')
    sendToolEnd(agent, 'toolu_list_2', 'shell_789 — running (32s)')

    expect((agent as any).backgroundTasksPending).toBe(true)

    simulateTurnEnd(agent)
    ;(agent as any).scheduleIdleSubprocessReaper()
    expect((agent as any).idleSubprocessReaper).toBeNull()
  })
})
