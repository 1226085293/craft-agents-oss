import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import { handleUserMessage } from '../session'
import type { SessionState, UserMessageEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: 0,
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

function processingEvent(timestamp: number): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: {
      id: 'backend-follow-up',
      role: 'user',
      content: 'follow up',
      timestamp,
    },
    status: 'processing',
    optimisticMessageId: 'optimistic-follow-up',
  }
}

describe('handleUserMessage queued replay', () => {
  it('applies the canonical replay timestamp without replacing the optimistic id', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isPending: false,
        isQueued: true,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const message = next.state.session.messages[0]

    expect(message.id).toBe('optimistic-follow-up')
    expect(message.timestamp).toBe(300)
    expect(message.isPending).toBe(false)
    expect(message.isQueued).toBe(false)
  })

  it('keeps the completed prior answer above the replayed message in live grouping', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: 250,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const turns = groupMessagesByTurn(next.state.session.messages)

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    const assistantTurn = turns[1]
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type === 'assistant') {
      expect(assistantTurn.response?.text).toBe('complete answer')
    }
  })

  it('ignores a late queued event after the message is already processing', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 300,
        isQueued: false,
      },
    ])
    const lateQueuedEvent: UserMessageEvent = {
      ...processingEvent(200),
      status: 'queued',
    }

    const next = handleUserMessage(state, lateQueuedEvent)

    expect(next.state).toBe(state)
    expect(next.state.session.messages[0]?.timestamp).toBe(300)
    expect(next.state.session.messages[0]?.isQueued).toBe(false)
  })

  it("preserves isProcessing=true on 'queued' while the current turn is still streaming", () => {
    // The current assistant turn is still running (isProcessing=true) and a
    // mid-stream send is queued. 'queued' must NOT flip isProcessing to false,
    // otherwise groupMessagesByTurn treats the session as complete and promotes
    // the in-flight thinking text into a "final" reply box (#616).
    const state = makeState([
      { id: 'user-1', role: 'user', content: 'first', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isPending: false,
        isQueued: true,
      },
    ])

    const queuedEvent: UserMessageEvent = {
      ...processingEvent(250),
      status: 'queued',
    }

    const next = handleUserMessage(state, queuedEvent)

    expect(next.state.session.isProcessing).toBe(true)
    const message = next.state.session.messages.find(m => m.id === 'optimistic-follow-up')
    expect(message?.isQueued).toBe(true)
  })

  it("preserves isProcessing=false on 'queued' after the current turn completed", () => {
    // Queue-after-abort path: a 'complete' event already set isProcessing=false,
    // then the 'queued' confirmation arrives. It must not flip it back to true.
    const state = makeState([
      { id: 'user-1', role: 'user', content: 'first', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isPending: false,
        isQueued: true,
      },
    ])
    state.session.isProcessing = false

    const queuedEvent: UserMessageEvent = {
      ...processingEvent(250),
      status: 'queued',
    }

    const next = handleUserMessage(state, queuedEvent)

    expect(next.state.session.isProcessing).toBe(false)
  })

  it('preserves the guide-click startedAt when merging an accepted steer into a queued bubble', () => {
    // 2026-10-07 plain-jade: the main process stamps startedAt at the guide
    // click. The renderer merge must pass it through to the queued bubble so
    // the in-card row positions by startedAt ?? timestamp; the display
    // timestamp stays the send time.
    const state = makeState([
      {
        id: 'optimistic-guide',
        role: 'user',
        content: '还有你的名字',
        timestamp: 100,
        isPending: false,
        isQueued: true,
      },
    ])

    const acceptedEvent: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      message: {
        id: 'backend-guide',
        role: 'user',
        content: '还有你的名字',
        timestamp: 100,
        startedAt: 150,
        isGuidance: true,
      },
      status: 'accepted',
      optimisticMessageId: 'optimistic-guide',
    }

    const next = handleUserMessage(state, acceptedEvent)
    const message = next.state.session.messages.find(m => m.id === 'optimistic-guide')

    expect(message?.startedAt).toBe(150)
    expect(message?.timestamp).toBe(100)
    expect(message?.isGuidance).toBe(true)
  })

  it('a drain re-emit (accepted with a newer startedAt) updates the merged bubble', () => {
    // 2026-10-07 plain-jade round 2: the main process re-emits the accepted
    // user_message at the drain moment with a re-stamped startedAt (the
    // agent actually read the guidance now). The renderer merge updates the
    // existing bubble in place (no duplicate).
    const state = makeState([
      {
        id: 'optimistic-guide',
        role: 'user',
        content: '还有你的名字',
        timestamp: 100,
        isPending: false,
        isQueued: false,
        startedAt: 150, // guide-click stamp
        isGuidance: true,
      },
    ])

    const drainEvent: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      message: {
        id: 'backend-guide',
        role: 'user',
        content: '还有你的名字',
        timestamp: 100,
        startedAt: 200, // drain stamp (later than the guide click)
        isGuidance: true,
      },
      status: 'accepted',
      optimisticMessageId: 'optimistic-guide',
    }

    const next = handleUserMessage(state, drainEvent)

    expect(next.state.session.messages).toHaveLength(1)
    const message = next.state.session.messages[0]
    expect(message?.id).toBe('optimistic-guide')
    expect(message?.startedAt).toBe(200)
    expect(message?.timestamp).toBe(100)
    expect(message?.isQueued).toBe(false)
  })
})
