/**
 * Scenario tests for turn lifecycle transitions.
 *
 * These tests verify the turn phase transitions through realistic
 * message flow scenarios, ensuring the state machine correctly
 * handles all common use cases.
 */

import { describe, it, expect } from 'bun:test'
import { deriveTurnPhase, groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

// ============================================================================
// Test Helpers
// ============================================================================

let messageIdCounter = 0
let turnIdCounter = 0

function resetCounters() {
  messageIdCounter = 0
  turnIdCounter = 0
}

function createUserMessage(content = 'Hello'): Message {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now() + messageIdCounter * 100,
  }
}

function createToolMessage(
  status: 'running' | 'completed',
  name = 'Read',
  turnId?: string
): Message {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: status === 'completed' ? 'Tool result' : '',
    timestamp: Date.now() + messageIdCounter * 100,
    toolName: name,
    toolUseId: `tu-${messageIdCounter}`,
    toolStatus: status === 'completed' ? 'completed' : undefined,
    toolResult: status === 'completed' ? 'Tool result' : undefined,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

function createAssistantMessage(
  isStreaming: boolean,
  isIntermediate = false,
  turnId?: string
): Message {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content: 'Response text',
    timestamp: Date.now() + messageIdCounter * 100,
    isStreaming,
    isIntermediate,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

/** Update a message in the array (simulating streaming updates) */
function updateMessage(
  messages: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  return messages.map(m => (m.id === id ? { ...m, ...updates } : m))
}

/** Get the last assistant turn from grouped turns */
function getLastAssistantTurn(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.type === 'assistant') {
      return turns[i] as AssistantTurn
    }
  }
  return undefined
}

// ============================================================================
// Scenario Tests
// ============================================================================

describe('turn lifecycle scenarios', () => {
  describe('simple response flow', () => {
    it('pending → streaming → complete (no tools)', () => {
      resetCounters()

      // 1. User message
      let messages: Message[] = [createUserMessage()]
      let turns = groupMessagesByTurn(messages)
      // No assistant turn yet
      expect(getLastAssistantTurn(turns)).toBeUndefined()

      // 2. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 3. Response completes
      messages = updateMessage(messages, 'assistant-2', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('single tool flow', () => {
    it('pending → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. User message
      let messages: Message[] = [createUserMessage()]

      // 2. Tool starts running
      messages = [...messages, createToolMessage('running')]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 3. Tool completes - THIS IS THE GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 4. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 5. Response completes
      messages = updateMessage(messages, 'assistant-3', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('multi-tool flow', () => {
    it('tool_active → awaiting → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. First tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes - GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 3. Second tool starts
      messages = [...messages, createToolMessage('running', 'Grep')]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 4. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 5. Response starts
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 6. Response completes
      messages = updateMessage(messages, 'assistant-4', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('parallel tools flow', () => {
    it('handles multiple tools running in parallel', () => {
      resetCounters()
      turnIdCounter++

      // 1. Multiple tools start
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
        createToolMessage('running', 'Grep'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes (second still running)
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active') // Still running

      // 3. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('tool with error', () => {
    it('error transitions to awaiting (not stuck in tool_active)', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. Tool errors
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: undefined,
        isError: true,
        content: 'File not found',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('interruption', () => {
    it('user message during tool_active marks turn complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool running
      let messages: Message[] = [
        createUserMessage('First question'),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. User interrupts with new message
      messages = [...messages, createUserMessage('Cancel that')]
      turns = groupMessagesByTurn(messages)
      // First assistant turn should now be complete (interrupted)
      const firstAssistantTurn = turns.find(t => t.type === 'assistant') as AssistantTurn
      expect(firstAssistantTurn.isComplete).toBe(true)
      expect(deriveTurnPhase(firstAssistantTurn)).toBe('complete')
    })
  })

  describe('intermediate text', () => {
    it('intermediate text during tool sequence stays in awaiting', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool completes
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 2. Intermediate text arrives (thinking out loud)
      messages = [...messages, createAssistantMessage(false, true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      // Still awaiting because intermediate text is not the final response
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  // A terminal session event must close the process card, but it cannot turn
  // intermediate commentary into a final result. Only a landed non-intermediate
  // assistant message is eligible to render as a response bubble.
  describe('tool-terminated run — session-complete fallback', () => {
    it('intermediate text + completed tool + session done → complete process card, no response without a final', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, /* isIntermediate */ true), // "I'll run the requested echo hello"
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('complete')
      expect(turn.response).toBeUndefined()
      expect(turn.activities.some(activity => activity.type === 'intermediate')).toBe(true)
    })

    it('intermediate text + completed tool + session still processing → phase awaiting', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, true),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('only tool + session done + no text → phase complete, no response promoted', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(turn)).toBe('complete')
      expect(turn.response).toBeUndefined()
    })

    it('omitting the option keeps current behavior (backwards compat)', () => {
      resetCounters()
      turnIdCounter++

      const messages: Message[] = [
        createUserMessage('do the thing'),
        createAssistantMessage(false, true),
        createToolMessage('completed', 'Bash'),
      ]
      const turns = groupMessagesByTurn(messages) // no second arg
      const turn = getLastAssistantTurn(turns)!
      // Without the explicit signal, the turn stays open — pre-fix behavior preserved
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })
  })

  // Empty intermediate assistant messages (a completed text event with no
  // visible body) used to render as blank step rows in the process card.
  // groupMessagesByTurn now drops them, while keeping pending (live "Thinking…")
  // and non-empty intermediates.
  describe('empty intermediate filtering', () => {
    // Explicit base-relative timestamps keep every message in one turn, in the
    // intended order, independent of the module-level helper counters.
    const base = Date.now()

    it('drops a completed empty intermediate between tool calls', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 2 },
        // the blank-row culprit: completed intermediate with an empty body
        { id: 'a-empty', role: 'assistant', content: '', isStreaming: false, isPending: false, isIntermediate: true, timestamp: base + 3 },
        { id: 't2', role: 'tool', content: 'Tool result', toolName: 'Grep', toolUseId: 'tu-2', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 4 },
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(turn.activities.filter(a => a.type === 'intermediate')).toHaveLength(0)
      // both tool rows survive
      expect(turn.activities.filter(a => a.type === 'tool')).toHaveLength(2)
    })

    it('drops a whitespace-only completed intermediate too', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 2 },
        { id: 'a-blank', role: 'assistant', content: '   \n  ', isStreaming: false, isPending: false, isIntermediate: true, timestamp: base + 3 },
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(turn.activities.filter(a => a.type === 'intermediate')).toHaveLength(0)
    })

    it('keeps a non-empty completed intermediate', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 'a-nonempty', role: 'assistant', content: 'Let me read the file first', isStreaming: false, isPending: false, isIntermediate: true, timestamp: base + 2 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 3 },
      ]
      // still processing → no response promotion, so the row stays a plain activity
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
      const turn = getLastAssistantTurn(turns)!
      const intermediates = turn.activities.filter(a => a.type === 'intermediate')
      expect(intermediates).toHaveLength(1)
      expect(intermediates[0]?.content).toBe('Let me read the file first')
    })

    it('keeps a pending (running) intermediate even when empty, for the Thinking placeholder', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 'a-pending', role: 'assistant', content: '', isStreaming: true, isPending: true, isIntermediate: true, timestamp: base + 2 },
      ]
      const turns = groupMessagesByTurn(messages)
      const turn = getLastAssistantTurn(turns)!
      const intermediates = turn.activities.filter(a => a.type === 'intermediate')
      expect(intermediates).toHaveLength(1)
      expect(intermediates[0]?.status).toBe('running')
    })
  })

  // A *completed* non-intermediate response with no visible text — a blank 'stop'
  // final (thinking-only stop, or a defense re-delivery that came back empty) —
  // used to surface as an empty "result bubble" (copy/markdown buttons, no body).
  // groupMessagesByTurn now keeps such turns as an activity-only process card.
  // (2026-10-01 empty-bubble incident, session 261001-active-eclipse.)
  describe('empty response filtering (blank result bubble)', () => {
    const base = Date.now()

    it('a blank completed final response is not surfaced as a response card', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 2 },
        // the empty-bubble culprit: a non-intermediate 'stop' with a blank body
        { id: 'a-blank-final', role: 'assistant', content: '\n\n', isStreaming: false, isIntermediate: false, timestamp: base + 3 },
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(turn.response?.text?.trim()).toBeFalsy()
      // the tool work is still present as an activity (process card)
      expect(turn.activities.filter(a => a.type === 'tool')).toHaveLength(1)
    })

    it('a blank final flushes as a process card; later work forms the next turn', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 2 },
        { id: 'a-blank-final', role: 'assistant', content: '\n\n', isStreaming: false, isIntermediate: false, timestamp: base + 3 },
        { id: 't2', role: 'tool', content: 'Tool result', toolName: 'Grep', toolUseId: 'tu-2', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 4 },
        { id: 'a-final', role: 'assistant', content: 'Done — all tasks completed.', isStreaming: false, isIntermediate: false, timestamp: base + 5 },
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const assistantTurns = turns.filter((t): t is AssistantTurn => t.type === 'assistant')
      expect(assistantTurns).toHaveLength(2)
      // first turn (tool1 + blank final) → process card, no response bubble
      expect(assistantTurns[0].response).toBeUndefined()
      expect(assistantTurns[0].activities.filter(a => a.type === 'tool')).toHaveLength(1)
      // second turn (tool2 + real final) → the real response surfaces
      expect(assistantTurns[1].response?.text).toBe('Done — all tasks completed.')
      expect(assistantTurns[1].activities.filter(a => a.type === 'tool')).toHaveLength(1)
    })

    it('a real final response still surfaces normally', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
        { id: 't1', role: 'tool', content: 'Tool result', toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed', toolResult: 'Tool result', timestamp: base + 2 },
        { id: 'a-final', role: 'assistant', content: 'Done — all tasks completed.', isStreaming: false, isIntermediate: false, timestamp: base + 3 },
      ]
      const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
      const turn = getLastAssistantTurn(turns)!
      expect(turn.response?.text).toBe('Done — all tasks completed.')
    })
  })
})

describe('edge cases', () => {
  it('empty activities array returns pending', () => {
    resetCounters()

    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: false,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('pending')
  })

  it('isComplete true with empty activities returns complete', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: true,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('complete')
  })

  it('response with isStreaming false but isComplete false returns awaiting', () => {
    // This is an edge case - usually when response.isStreaming is false,
    // the turn should be marked complete. But we trust isComplete as
    // the authoritative signal.
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [
        {
          id: 'act-1',
          type: 'tool',
          status: 'completed',
          timestamp: Date.now(),
        },
      ],
      response: {
        text: 'Done',
        isStreaming: false,
      },
      isStreaming: false,
      isComplete: false, // Not yet marked complete
      timestamp: Date.now(),
    }
    // Per our priority: complete > streaming > tool_active > awaiting > pending
    // response.isStreaming is false, so not streaming
    // no running tools, so not tool_active
    // has activities, so awaiting
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })
})

describe('hidden messages', () => {
  const base = Date.now()
  const messages = [
    { id: 'u1', role: 'user', content: '1分钟后给我发消息', timestamp: base } as Message,
    { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'running' } as Message,
    { id: 'q1', role: 'user', content: '再帮我查一下天气', timestamp: base + 200, isQueued: true } as Message,
  ]

  const turns = groupMessagesByTurn(messages)
  expect(turns).toHaveLength(3)
  expect(turns[0]?.type).toBe('user')
  expect(turns[1]?.type).toBe('assistant')
  expect(turns[2]?.type).toBe('user')
  if (turns[0]?.type !== 'user') throw new Error('expected first user turn')
  if (turns[1]?.type !== 'assistant') throw new Error('expected assistant turn')
  if (turns[2]?.type !== 'user') throw new Error('expected queued user turn')

  expect(turns[0].message.id).toBe('u1')
  expect(turns[1].activities.map(a => a.id)).toEqual(['tool1'])
  expect(turns[1].isComplete).toBe(false)
  expect(turns[2].message.id).toBe('q1')
  expect(turns[2].message.isQueued).toBe(true)
})

it('keeps queued user messages after the assistant block even if they arrive before first activity', () => {
  const base = Date.now()
  const messages = [
    { id: 'u1', role: 'user', content: '1分钟后给我发消息', timestamp: base } as Message,
    { id: 'q1', role: 'user', content: '再帮我查一下天气', timestamp: base + 100, isQueued: true } as Message,
    { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 200, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'running' } as Message,
  ]

  const turns = groupMessagesByTurn(messages)
  expect(turns).toHaveLength(3)
  expect(turns[0]?.type).toBe('user')
  expect(turns[1]?.type).toBe('assistant')
  expect(turns[2]?.type).toBe('user')
  if (turns[1]?.type !== 'assistant') throw new Error('expected assistant turn')
  if (turns[2]?.type !== 'user') throw new Error('expected queued user turn')

  expect(turns[1].activities.map(a => a.id)).toEqual(['tool1'])
  expect(turns[2].message.id).toBe('q1')
})

it('keeps steered guidance under the original user turn without splitting assistant activities', () => {
  const base = Date.now()
  const messages = [
    { id: 'u1', role: 'user', content: '1分钟后给我发消息', timestamp: base } as Message,
    { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'completed', toolResult: '(no output)' } as Message,
    { id: 'g1', role: 'user', content: '改为两分钟', timestamp: base + 200, isGuidance: true } as Message,
    { id: 'a1', role: 'assistant', content: '好的，改为 2 分钟后。', timestamp: base + 300, isIntermediate: true } as Message,
    { id: 'tool2', role: 'tool', content: 'Running Bash...', timestamp: base + 400, toolName: 'Bash', toolUseId: 'call-2', toolStatus: 'executing' } as Message,
  ]

  const turns = groupMessagesByTurn(messages)
  expect(turns).toHaveLength(2)
  expect(turns[0]?.type).toBe('user')
  if (turns[0]?.type !== 'user') throw new Error('expected user turn')
  expect(turns[0].message.id).toBe('u1')
  expect(turns[0].guidanceMessages?.map(m => m.id)).toEqual(['g1'])
  expect(turns[1]?.type).toBe('assistant')
  if (turns[1]?.type !== 'assistant') throw new Error('expected assistant turn')
  expect(turns[1].activities.map(a => a.id)).toEqual(['tool1', 'g1', 'a1', 'tool2'])
  expect(turns[1].activities.find(a => a.id === 'g1')?.statusType).toBe('guidance')
})

describe('hidden messages', () => {
  it('never render as a turn but the assistant reply they trigger still does', () => {
    resetCounters()

    // A hidden system-generated nudge (e.g. WS2 background-task-completion) followed
    // by the assistant response it drives.
    const hiddenNudge: Message = { ...createUserMessage('[background-task-completed] present it'), hidden: true }
    const reply = createAssistantMessage(false, false, 'turn-reply')

    const turns = groupMessagesByTurn([hiddenNudge, reply])

    // Exactly one turn — the assistant reply. No 'user' turn for the hidden nudge.
    expect(turns.some(t => t.type === 'user')).toBe(false)
    const assistantTurns = turns.filter(t => t.type === 'assistant')
    expect(assistantTurns.length).toBe(1)
  })

  it('a visible user message still renders normally alongside a hidden one', () => {
    resetCounters()

    const visible = createUserMessage('real user question')
    const hidden: Message = { ...createUserMessage('[background-task-completed] hidden'), hidden: true }

    const turns = groupMessagesByTurn([visible, hidden])

    const userTurns = turns.filter(t => t.type === 'user')
    expect(userTurns.length).toBe(1)
    expect((userTurns[0] as { message: Message }).message.content).toBe('real user question')
  })
})

it('renders queued user messages after the active assistant process block', () => {
  const base = Date.now()
  const messages = [
    { id: 'u1', role: 'user', content: 'first question', timestamp: base } as Message,
    { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'running' } as Message,
    { id: 'a1', role: 'assistant', content: 'thinking...', timestamp: base + 200, isStreaming: true, isIntermediate: false } as Message,
    { id: 'q1', role: 'user', content: 'queued follow-up', timestamp: base + 300, isQueued: true } as Message,
  ]

  // The queued user message must appear AFTER the assistant process block,
  // not between the original user message and its assistant block.
  const turns = groupMessagesByTurn(messages)
  expect(turns).toHaveLength(3)
  expect(turns[0]?.type).toBe('user')
  expect(turns[1]?.type).toBe('assistant')
  expect(turns[2]?.type).toBe('user')

  if (turns[0]?.type !== 'user') throw new Error('expected first user turn')
  if (turns[1]?.type !== 'assistant') throw new Error('expected assistant turn')
  if (turns[2]?.type !== 'user') throw new Error('expected queued user turn')

  expect(turns[0].message.id).toBe('u1')
  expect(turns[1].activities.map(a => a.id)).toEqual(['tool1'])
  expect((turns[1] as AssistantTurn).response?.messageId).toBe('a1')
  expect((turns[1] as AssistantTurn).isComplete).toBe(false)
  expect(turns[2].message.id).toBe('q1')
  expect(turns[2].message.isQueued).toBe(true)
})

// ============================================================================
// Interrupted / failed runs must not produce a result
// ============================================================================

/**
 * Intermediate commentary is not a result. If a turn is stopped, aborted,
 * or errors before a non-intermediate final message lands, it must remain a
 * process step and never render as a response bubble.
 */
describe('interrupted and failed runs produce no response', () => {
  /** Builds "user → intermediate commentary → <terminator>" for one turn. */
  function runTerminatedBy(terminator: Message): Message[] {
    resetCounters()
    turnIdCounter++
    return [
      createUserMessage('do the thing'),
      createAssistantMessage(false, /* isIntermediate */ true),
      terminator,
    ]
  }

  function terminatedTurn(messages: Message[]): AssistantTurn {
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    return getLastAssistantTurn(turns)!
  }

  it('error after commentary → no response promoted, error is the result', () => {
    const error: Message = {
      id: 'err-1',
      role: 'error',
      content: 'Error occurred: boom',
      timestamp: Date.now() + 9999,
    }
    const turn = terminatedTurn(runTerminatedBy(error))
    expect(turn.response).toBeUndefined()
    // The commentary is still visible, just not as the answer.
    expect(turn.activities.some(a => a.type === 'intermediate')).toBe(true)
  })

  it('warning after commentary → no response promoted', () => {
    const warning: Message = {
      id: 'warn-1',
      role: 'warning',
      content: 'Attachment upload failed',
      timestamp: Date.now() + 9999,
    }
    const turn = terminatedTurn(runTerminatedBy(warning))
    expect(turn.response).toBeUndefined()
  })

  it('info "Response interrupted" → no response promoted (existing Stop path)', () => {
    const info: Message = {
      id: 'info-1',
      role: 'info',
      content: 'Response interrupted',
      timestamp: Date.now() + 9999,
    }
    const turn = terminatedTurn(runTerminatedBy(info))
    expect(turn.response).toBeUndefined()
  })

  it('aborted message (silent redirect) → no response promoted', () => {
    // The silent-redirect path writes no info message, so the `aborted` flag on
    // the assistant message is the only signal. The turn is closed by the next
    // user message arriving.
    resetCounters()
    turnIdCounter++
    const messages: Message[] = [
      createUserMessage('first request'),
      { ...createAssistantMessage(false, true), aborted: true },
      createUserMessage('actually, do this instead'),
    ]
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const turn = getLastAssistantTurn(turns)!
    expect(turn.response).toBeUndefined()
    expect(turn.activities.some(a => a.type === 'intermediate')).toBe(true)
  })

  it('aborted message closed by session-complete fallback → no response promoted', () => {
    // Same abort, but no trailing user message: the turn is closed by the
    // isSessionProcessing=false fallback rather than by a new message.
    resetCounters()
    turnIdCounter++
    const messages: Message[] = [
      createUserMessage('do the thing'),
      { ...createAssistantMessage(false, true), aborted: true },
    ]
    const turn = terminatedTurn(messages)
    expect(turn.response).toBeUndefined()
  })

  it('aborted message is still non-promotable when an error bubble terminates the turn', () => {
    resetCounters()
    turnIdCounter++
    const messages = runTerminatedBy({
      id: 'guardrail-error',
      role: 'error',
      content: 'Turn aborted by busy-limit guardrail',
      timestamp: Date.now() + 9999,
    })
    messages.splice(1, 1, { ...messages[1]!, aborted: true })

    const turn = terminatedTurn(messages)
    expect(turn.response).toBeUndefined()
    expect(turn.activities.some(activity => activity.type === 'intermediate')).toBe(true)
  })

  it('an aborted turn does not hide a later real final response', () => {
    resetCounters()
    turnIdCounter++
    const abortedTurn: Message[] = [
      createUserMessage('first request'),
      { ...createAssistantMessage(false, true), aborted: true },
    ]
    const normalTurn: Message[] = [
      createUserMessage('do the thing'),
      createAssistantMessage(false, true),
      createToolMessage('completed', 'Bash'),
      createAssistantMessage(false, false),
    ]
    const turns = groupMessagesByTurn(
      [...abortedTurn, ...normalTurn],
      { isSessionProcessing: false }
    )
    const assistantTurns = turns.filter(t => t.type === 'assistant') as AssistantTurn[]
    expect(assistantTurns[0]?.response).toBeUndefined()
    // A real final message, unlike intermediate commentary, remains visible.
    expect(assistantTurns[1]?.response?.text).toBe('Response text')
  })

  it('an aborted run with a real final response still shows the final response', () => {
    // A delivered final is a genuine result. Guarding against a false abort
    // costs the user their answer, so the response must survive regardless.
    resetCounters()
    turnIdCounter++
    const messages: Message[] = [
      createUserMessage('do the thing'),
      createAssistantMessage(false, /* isIntermediate */ false),
    ]
    const turn = terminatedTurn(messages)
    expect(turn.response?.text).toBe('Response text')
  })
})

/**
 * The response bubble was stamped with the TURN's open time (its first
 * response message), so a final that lands minutes later rendered with the
 * wrong clock time. groupMessagesByTurn now records the final response's own
 * `timestamp` on `turn.response`, and TurnCard renders that (falling back to
 * the turn timestamp only when absent).
 *
 * (2026-10-01: session 261001-active-eclipse — a final that landed at
 * 21:20:44 was displayed under a 21:12:31 stamp because it inherited the
 * turn-open time instead of its own.)
 */
describe('final response carries its own timestamp (not the turn-open time)', () => {
  const base = Date.now()

  it('response.timestamp is the final time, later than the turn opened', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
      // opens the assistant turn early
      { id: 'a-mid', role: 'assistant', content: 'let me check the file first', isStreaming: false, isIntermediate: true, timestamp: base + 2 },
      // the genuine final lands much later
      { id: 'a-final', role: 'assistant', content: 'Done — all tasks completed.', isStreaming: false, isIntermediate: false, timestamp: base + 300_000 },
    ]
    const turn = getLastAssistantTurn(groupMessagesByTurn(messages, { isSessionProcessing: false }))!
    expect(turn.response?.text).toBe('Done — all tasks completed.')
    // the response keeps the final's OWN timestamp ...
    expect(turn.response?.timestamp).toBe(base + 300_000)
    // ... which is strictly later than when the turn opened (turn.timestamp)
    expect(turn.timestamp).toBeLessThan(base + 300_000)
  })

  it('turn.timestamp is the first response message; response.timestamp is distinct', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the thing', timestamp: base + 1 },
      { id: 'a-mid', role: 'assistant', content: 'first step', isStreaming: false, isIntermediate: true, timestamp: base + 2 },
      { id: 'a-final', role: 'assistant', content: 'Second step — final.', isStreaming: false, isIntermediate: false, timestamp: base + 450_000 },
    ]
    const turn = getLastAssistantTurn(groupMessagesByTurn(messages, { isSessionProcessing: false }))!
    // the assistant turn opens at its first response message
    expect(turn.timestamp).toBe(base + 2)
    // the bubble must NOT inherit that; it shows the final's own time
    expect(turn.response?.timestamp).toBe(base + 450_000)
    expect(turn.response?.timestamp).not.toBe(turn.timestamp)
  })
})
