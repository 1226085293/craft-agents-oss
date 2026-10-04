import { describe, expect, it } from 'bun:test'
import { handleSystemStopNotice } from '../session'
import type { SessionState, SystemStopNoticeEvent } from '../../types'

function makeState(messages: any[], currentStatus?: string): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
      currentStatus,
    } as any,
    streaming: null,
  }
}

describe('handleSystemStopNotice', () => {
  it('appends a persistent warning notice with the machine reason and a continue hint', () => {
    const state = makeState([{ id: 'msg-1', role: 'user', content: 'go' }], 'Thinking…')

    const event: SystemStopNoticeEvent = {
      type: 'system_stop_notice',
      sessionId: 'session-1',
      reason: 'busy_limit',
      message: 'Turn aborted: exceeded 500 tool calls in a single turn (busy-limit guardrail).',
    }

    const next = handleSystemStopNotice(state, event)
    const messages = next.state.session.messages
    const notice = messages[messages.length - 1]

    expect(messages).toHaveLength(2)
    expect(notice.role).toBe('info')
    expect(notice.infoLevel).toBe('warning')
    expect(notice.content).toContain('busy_limit')
    expect(notice.content).toContain('500 tool calls')
    expect(notice.content).toContain('continue')
    // lingering "Thinking…" status is cleared so the UI isn't stuck on it
    expect(next.state.session.currentStatus).toBeUndefined()
    expect(next.effects).toEqual([])
  })

  it('omits the reason suffix when the system did not tag one', () => {
    const state = makeState([])
    const event: SystemStopNoticeEvent = {
      type: 'system_stop_notice',
      sessionId: 'session-1',
      reason: 'system_stop',
      message: 'Turn stopped by the system.',
    }

    const next = handleSystemStopNotice(state, event)
    const notice = next.state.session.messages[0]

    expect(notice.content).toContain('Turn stopped by the system.')
    expect(notice.content).not.toContain('(system_stop)')
  })
})
