/**
 * Tests for thinking streaming handlers (2026-10-09 "invisible process" fix).
 *
 * thinking_delta accumulates into a live pending assistant message (distinct
 * turnId per thinking block), and thinking_complete finalizes it as an
 * INTERMEDIATE process step — never a result bubble.
 */
import { describe, expect, it } from 'bun:test'
import { handleThinkingDelta, handleThinkingComplete } from '../thinking'
import type { SessionState, ThinkingDeltaEvent, ThinkingCompleteEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleThinkingDelta', () => {
  it('starts a live pending assistant message for the thinking turnId', () => {
    const state = makeState([])
    const event: ThinkingDeltaEvent = {
      type: 'thinking_delta',
      sessionId: 'session-1',
      delta: 'reasoning…',
      turnId: 'turn-1__t0',
    }
    const next = handleThinkingDelta(state, event)
    const msg = next.session.messages[0] as any
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('reasoning…')
    expect(msg.isStreaming).toBe(true)
    expect(msg.isPending).toBe(true)
    expect(msg.turnId).toBe('turn-1__t0')
  })

  it('accumulates consecutive deltas into the SAME message', () => {
    const state = makeState([])
    const ev = (delta: string): ThinkingDeltaEvent => ({
      type: 'thinking_delta',
      sessionId: 'session-1',
      delta,
      turnId: 'turn-1__t0',
    })
    const s1 = handleThinkingDelta(state, ev('Think A. '))
    const s2 = handleThinkingDelta(s1, ev('Think B.'))
    expect(s2.session.messages).toHaveLength(1)
    expect((s2.session.messages[0] as any).content).toBe('Think A. Think B.')
  })

  it('keeps different thinking turnIds as separate messages once the first is finalized', () => {
    // Realistic sequence: block A streams → thinking_complete finalizes it →
    // block B starts with its own turnId. (Two UNFINALIZED streaming blocks can
    // never coexist: the SDK emits thinking_end between blocks, which the
    // adapter turns into thinking_complete.)
    const state = makeState([])
    const s1 = handleThinkingDelta(state, {
      type: 'thinking_delta',
      sessionId: 'session-1',
      delta: 'first',
      turnId: 't-a',
    })
    const s2 = handleThinkingComplete(s1, {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'first',
      turnId: 't-a',
      messageId: 'msg-a',
      timestamp: 100,
    })
    const s3 = handleThinkingDelta(s2, {
      type: 'thinking_delta',
      sessionId: 'session-1',
      delta: 'second',
      turnId: 't-b',
    })
    expect(s3.session.messages).toHaveLength(2)
    expect((s3.session.messages[1] as any).turnId).toBe('t-b')
    expect((s3.session.messages[1] as any).isPending).toBe(true)
  })
})

describe('handleThinkingComplete', () => {
  it('finalizes the streamed thinking message as an intermediate step with the FULL text', () => {
    const state = makeState([
      {
        id: 'msg-temp',
        role: 'assistant',
        content: 'Think A. Think B.',
        isStreaming: true,
        isPending: true,
        turnId: 'turn-1__t0',
        timestamp: 100,
      },
    ])
    const event: ThinkingCompleteEvent = {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'Think A. Think B.',
      turnId: 'turn-1__t0',
      messageId: 'msg-main-1',
      timestamp: 200,
      startedAt: 150,
    }
    const next = handleThinkingComplete(state, event)
    const msg = next.session.messages[0] as any
    expect(msg.id).toBe('msg-main-1')
    expect(msg.content).toBe('Think A. Think B.')
    expect(msg.isStreaming).toBe(false)
    expect(msg.isPending).toBe(false)
    expect(msg.isIntermediate).toBe(true)
    expect(msg.startedAt).toBe(150)
  })

  it('creates the intermediate message when deltas were missed (race path)', () => {
    const state = makeState([])
    const event: ThinkingCompleteEvent = {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'whole block',
      turnId: 'turn-1__t7',
      messageId: 'msg-main-7',
      timestamp: 300,
    }
    const next = handleThinkingComplete(state, event)
    const msg = next.session.messages[0] as any
    expect(msg.isIntermediate).toBe(true)
    expect(msg.isStreaming).toBe(false)
    expect(msg.content).toBe('whole block')
  })
})