import { beforeEach, describe, expect, it } from 'bun:test'
import { submitDecisionAnswer } from '../answer-decision.ts'

/**
 * Both cards answer through this one function.
 *
 * They used to build their own requests, and had already drifted: the conversation card
 * passed the task id and the asking session, the task card passed neither. A reply from one
 * reached the supervisor named; from the other it arrived as bare words with no task at all.
 */
interface Call {
  workspaceId: string
  taskId: string
  text: string
  askedBySessionId?: string
}

function install(overrides: { tasksAnswer?: unknown; sendMessage?: unknown } = {}): {
  calls: Call[]
  sent: string[]
} {
  const calls: Call[] = []
  const sent: string[] = []
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      tasksAnswer:
        overrides.tasksAnswer ??
        (async (workspaceId: string, taskId: string, text: string, askedBySessionId?: string) => {
          calls.push({ workspaceId, taskId, text, askedBySessionId })
          return { accepted: true }
        }),
      sendMessage: async (sessionId: string, text: string) => {
        sent.push(`${sessionId}:${text}`)
      },
      ...(overrides.sendMessage ? { sendMessage: overrides.sendMessage } : {}),
    },
  }
  return { calls, sent }
}

describe('submitting a decision answer', () => {
  beforeEach(() => {
    install()
  })

  it('goes through the task RPC with the task id', async () => {
    const { calls } = install()
    const result = await submitDecisionAnswer({ workspaceId: 'ws', taskId: 'T-1', text: ' 放行 ' })

    expect(result.accepted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.taskId).toBe('T-1')
    // The words, not the padding.
    expect(calls[0]?.text).toBe('放行')
  })

  it('passes the asking session so a card with no task id still resolves one', async () => {
    const { calls } = install()
    await submitDecisionAnswer({ workspaceId: 'ws', askedBySessionId: 'sess-user', text: '放行' })

    expect(calls[0]?.taskId).toBe('')
    expect(calls[0]?.askedBySessionId).toBe('sess-user')
  })

  it('reports the server\'s refusal instead of pretending it was accepted', async () => {
    install({ tasksAnswer: async () => ({ accepted: false, reason: 'no pending decision' }) })
    const result = await submitDecisionAnswer({ workspaceId: 'ws', taskId: 'T-1', text: '放行' })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('no pending decision')
  })

  it('refuses an empty answer without calling anything', async () => {
    const { calls } = install()
    expect((await submitDecisionAnswer({ workspaceId: 'ws', taskId: 'T-1', text: '   ' })).accepted).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
