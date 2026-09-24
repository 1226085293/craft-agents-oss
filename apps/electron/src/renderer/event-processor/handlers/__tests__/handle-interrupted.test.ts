import { describe, expect, it } from 'bun:test'
import { handleInterrupted } from '../session'
import type { SessionState, InterruptedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

describe('handleInterrupted (#616)', () => {
  describe('user-initiated stop (event.message present)', () => {
    it('removes queued bubbles AND emits restore_input', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued one', isQueued: true },
        { id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
        queuedMessages: ['queued one', 'queued two'],
      }

      const next = handleInterrupted(state, event)

      // queued bubbles dropped
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).not.toContain('msg-2')
      expect(ids).not.toContain('msg-3')
      // info message appended
      expect(ids).toContain('info-1')
      // restore_input effect emitted with combined text
      expect(next.effects).toEqual([
        { type: 'restore_input', text: 'queued one\n\nqueued two' },
      ])
      // isProcessing cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('still works when no queued bubbles exist', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 } as any,
      }

      const next = handleInterrupted(state, event)
      expect(next.effects).toEqual([])
      expect(next.state.session.messages.map(m => m.id)).toContain('info-1')
    })
  })

  describe('silent redirect (event.message absent)', () => {
    it('KEEPS queued bubbles in chat and does NOT emit restore_input (#616 fix)', () => {
      const state = makeState([
        { id: 'msg-1', role: 'user', content: 'first' },
        { id: 'msg-2', role: 'user', content: 'queued during run', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        // no message field — silent redirect
        queuedMessages: ['queued during run'],
      }

      const next = handleInterrupted(state, event)

      // queued bubble must remain so the user sees it
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      // no info bubble appended
      expect(ids).not.toContain('info-1')
      // critically: no restore_input effect — backend will auto-replay
      expect(next.effects).toEqual([])
      // isProcessing still gets cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('marks running tools as interrupted regardless of redirect type', () => {
      const state = makeState([
        { id: 'tool-1', role: 'tool', toolStatus: 'executing', toolResult: undefined },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
      }

      const next = handleInterrupted(state, event)
      const tool = next.state.session.messages[0] as any
      expect(tool.toolStatus).toBe('error')
      expect(tool.toolResult).toBe('Interrupted')
      expect(tool.isError).toBe(true)
    })
  })

  it('always strips transient status messages', () => {
    const state = makeState([
      { id: 'msg-1', role: 'user', content: 'hi' },
      { id: 'status-1', role: 'status', content: 'thinking…' },
    ])
    const event: InterruptedEvent = {
      type: 'interrupted',
      sessionId: 'session-1',
    }

    const next = handleInterrupted(state, event)
    const ids = next.state.session.messages.map(m => m.id)
    expect(ids).not.toContain('status-1')
    expect(ids).toContain('msg-1')
  })
})

/**
 * The aborted flag is the only signal the turn grouper has for a silent
 * redirect — that path writes no "Response interrupted" info message, so there
 * is no terminator in the message list to key off of. The backend sets the same
 * flag server-side (so it survives a reload); this covers the live view.
 */
describe('handleInterrupted — aborted marker', () => {
  it('flags the in-flight assistant message on a silent redirect', () => {
    const state = makeState([
      { id: 'u1', role: 'user', content: 'first request' },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true },
    ])
    // No `message` → silent redirect, which the backend uses when the user
    // steers an active turn instead of pressing Stop.
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const next = handleInterrupted(state, event)
    const assistant = next.state.session.messages.find(m => m.id === 'a1')
    expect(assistant?.aborted).toBe(true)
  })

  it('leaves a delivered final response unmarked', () => {
    const state = makeState([
      { id: 'u1', role: 'user', content: 'first request' },
      { id: 'a1', role: 'assistant', content: 'done', isIntermediate: false },
      { id: 'u2', role: 'user', content: 'second request' },
    ])
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const next = handleInterrupted(state, event)
    const finalMessage = next.state.session.messages.find(m => m.id === 'a1')
    // A final response is a real result — mislabeling it would cost the user
    // their answer if the flag ever became a grouping input.
    expect(finalMessage?.aborted).toBeUndefined()
  })

  it('does not flag anything when the last assistant message is a final response', () => {
    const state = makeState([
      { id: 'u1', role: 'user', content: 'only request' },
      { id: 'a1', role: 'assistant', content: 'the answer', isIntermediate: false },
    ])
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const next = handleInterrupted(state, event)
    const flagged = next.state.session.messages.filter(m => m.aborted)
    expect(flagged).toEqual([])
  })

  it('flags a pending streaming assistant message', () => {
    const state = makeState([
      { id: 'u1', role: 'user', content: 'first request' },
      { id: 'a1', role: 'assistant', content: 'partial', isPending: true, isStreaming: true },
    ])
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const next = handleInterrupted(state, event)
    const assistant = next.state.session.messages.find(m => m.id === 'a1')
    expect(assistant?.aborted).toBe(true)
    expect(assistant?.isPending).toBe(false)
    expect(assistant?.isStreaming).toBe(false)
  })

  it('indexes the abort flag after status messages are filtered out', () => {
    // Status messages are dropped before the map runs; computing the index
    // against the pre-filter array would flag the wrong message.
    const state = makeState([
      { id: 'u1', role: 'user', content: 'first request' },
      { id: 's1', role: 'status', content: 'Compacting…' },
      { id: 'a1', role: 'assistant', content: 'let me look', isIntermediate: true },
    ])
    const event: InterruptedEvent = { type: 'interrupted', sessionId: 'session-1' }

    const next = handleInterrupted(state, event)
    expect(next.state.session.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    expect(next.state.session.messages.find(m => m.id === 'a1')?.aborted).toBe(true)
    expect(next.state.session.messages.find(m => m.id === 'u1')?.aborted).toBeUndefined()
  })
})
