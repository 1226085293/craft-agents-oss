import { describe, expect, it } from 'bun:test'
import { handleTaskCompleted } from '../tool'
import type { SessionState, TaskCompletedEvent } from '../../types'

const BASE = 1_000_000

function makeState(
  messages: any[],
  streaming: boolean | SessionState['streaming'] = null,
): SessionState {
  const streamingState = typeof streaming === 'boolean'
    ? (streaming ? { content: '' } : null)
    : streaming
  return {
    session: {
      id: 'session-1',
      workspaceId: 'ws-1',
      workspaceName: 'W',
      lastMessageAt: BASE,
      messages,
      isProcessing: !streaming,
    } as any,
    streaming: streamingState,
  }
}

const userMsg = { id: 'u1', role: 'user', content: '请跑测试', timestamp: BASE }
const tailMsg = { id: 'a1', role: 'assistant', content: '已在后台运行。', timestamp: BASE + 5000, isIntermediate: false }
const toolMsg = (over: Record<string, unknown> = {}) => ({
  id: 'm-task',
  role: 'tool',
  content: '',
  timestamp: BASE + 1000,
  toolUseId: 'u-1',
  toolName: 'Bash',
  toolStatus: 'backgrounded',
  taskId: 't1',
  isBackground: true,
  toolIntent: 'run tests',
  ...over,
})

function event(over: Partial<TaskCompletedEvent> = {}): TaskCompletedEvent {
  return {
    type: 'task_completed',
    sessionId: 'session-1',
    taskId: 't1',
    status: 'stopped',
    outputFile: '/tmp/out.txt',
    summary: 'stopping',
    ...over,
  }
}

describe('handleTaskCompleted stop separator', () => {
  it('inserts the separator immediately before the task row and leaves the input untouched', () => {
    const messages = [userMsg, toolMsg(), tailMsg]
    const snapshot = structuredClone(messages)
    const state = makeState(messages)

    const next = handleTaskCompleted(state, event())

    expect(next.session.messages.map((m: any) => m.id)).toEqual(['u1', 'bg-stop-t1', 'm-task', 'a1'])
    expect(next.session.messages[1]).toMatchObject({
      role: 'info',
      content: '——后台任务 t1 已停止——',
      timestamp: BASE + 1000,
    })
    expect(next.session.messages[2]).toMatchObject({
      toolStatus: 'completed',
      toolResult: 'stopping',
    })
    expect(next.streaming).toBeNull()

    // Pure handler: returned state is a new object/array, input is byte-identical.
    expect(next).not.toBe(state)
    expect(next.session.messages).not.toBe(messages)
    expect(messages).toEqual(snapshot)
    expect(messages).toHaveLength(3)
    expect((messages[1] as any).toolStatus).toBe('backgrounded')
  })

  it('does not duplicate the separator when the same event is replayed', () => {
    const first = handleTaskCompleted(makeState([userMsg, toolMsg(), tailMsg]), event())
    const second = handleTaskCompleted(first, event())

    expect(second.session.messages.filter((m: any) => m.id === 'bg-stop-t1')).toHaveLength(1)
    expect(second.session.messages).toHaveLength(4)
  })

  it('keeps a mid-turn stop inside the live process block (streaming)', () => {
    const next = handleTaskCompleted(makeState([userMsg, toolMsg()], true), event())

    expect(next.session.messages.some((m: any) => m.role === 'info')).toBe(false)
    expect(next.session.messages.map((m: any) => m.id)).toEqual(['u1', 'm-task'])
    expect(next.session.messages[1]).toMatchObject({ toolStatus: 'completed', toolResult: 'stopping' })
  })

  it('does not insert a separator for a non-stopped terminal status', () => {
    const next = handleTaskCompleted(
      makeState([userMsg, toolMsg()]),
      event({ status: 'completed', summary: 'ok' }),
    )

    expect(next.session.messages.some((m: any) => m.role === 'info')).toBe(false)
    expect(next.session.messages[1]).toMatchObject({ toolStatus: 'completed', toolResult: 'ok' })
  })

  it('returns the input unchanged when the taskId is unknown', () => {
    const state = makeState([userMsg, toolMsg()])
    const next = handleTaskCompleted(state, event({ taskId: 'no-such-task' }))

    expect(next).toBe(state)
    expect(next.session.messages.map((m: any) => m.id)).toEqual(['u1', 'm-task'])
    expect(next.session.messages[1]).toMatchObject({ toolStatus: 'backgrounded' })
  })

  it('keeps adversarial taskIds literal without polluting prototypes', () => {
    const hostile = ['__proto__', 'constructor', '任务-✓/1', 'bg-stop-t1x', '']

    for (const taskId of hostile) {
      const state = makeState([toolMsg({ id: `m-${taskId.length}-x`, taskId })])
      const first = handleTaskCompleted(state, event({ taskId }))
      const separatorId = `bg-stop-${taskId}`
      const hits = first.session.messages.filter((m: any) => m.id === separatorId)

      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({
        role: 'info',
        content: `——后台任务 ${taskId} 已停止——`,
      })

      const replay = handleTaskCompleted(first, event({ taskId }))
      expect(replay.session.messages.filter((m: any) => m.id === separatorId)).toHaveLength(1)
    }

    expect(Object.keys(Object.prototype)).toEqual([])
  })
})
