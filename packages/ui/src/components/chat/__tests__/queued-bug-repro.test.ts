/**
 * Reproduction test for the queued-message bug:
 * "When a new message is sent while a session is still processing,
 *  the UI incorrectly shows an extra reply box containing the latest thinking process."
 */
import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn, type UserTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

const base = 1000000

function describeTurns(turns: ReturnType<typeof groupMessagesByTurn>): string {
  return turns.map((t, i) => {
    if (t.type === 'user') return `[${i}] USER: "${(t as UserTurn).message.content}" (queued=${(t as UserTurn).message.isQueued})`
    if (t.type === 'assistant') {
      const at = t as AssistantTurn
      return `[${i}] ASSISTANT: turnId=${at.turnId} activities=${at.activities.length} response=${at.response ? `"${at.response.text.slice(0, 30)}..."` : 'none'} streaming=${at.isStreaming} complete=${at.isComplete}`
    }
    return `[${i}] ${t.type}`
  }).join('\n')
}

describe('queued message bug reproduction', () => {
  it('scenario: T1 streaming final response, user sends queued message', () => {
    // T1 is streaming its final response
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'completed', toolResult: 'done' },
      { id: 'a1', role: 'assistant', content: 'Here is my answer...', timestamp: base + 200, isStreaming: true, isIntermediate: false },
      // User sends message 2 mid-stream (optimistic, queued)
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 300, isQueued: true, isPending: false },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
    console.log('=== Scenario 1: T1 streaming, queued message ===')
    console.log(describeTurns(turns))

    // Expected: 3 turns - user1, assistant T1 (streaming), queued user2
    expect(turns).toHaveLength(3)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns[2]?.type).toBe('user')
  })

  it('scenario: T1 streaming, queued message, isProcessing=false (queued event arrived)', () => {
    // Same as above but isProcessing is false (handleUserMessage set it to false for 'queued')
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'completed', toolResult: 'done' },
      { id: 'a1', role: 'assistant', content: 'Here is my answer...', timestamp: base + 200, isStreaming: true, isIntermediate: false },
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 300, isQueued: true, isPending: false },
    ]

    // isProcessing is false because handleUserMessage set it to false for 'queued' status
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    console.log('=== Scenario 2: T1 streaming, queued message, isProcessing=false ===')
    console.log(describeTurns(turns))

    // This is the BUG scenario: isProcessing=false triggers the session-complete fallback
    // which marks T1 as complete even though it's still streaming
    expect(turns).toHaveLength(3)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns[2]?.type).toBe('user')
  })

  it('scenario: T1 in tool-active phase (no response), queued message, isProcessing=false', () => {
    // T1 is in tool-active phase (no response yet)
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'running' },
      // User sends message 2 mid-stream (optimistic, queued)
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 200, isQueued: true, isPending: false },
    ]

    // isProcessing is false because handleUserMessage set it to false for 'queued' status
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    console.log('=== Scenario 3: T1 tool-active, queued message, isProcessing=false ===')
    console.log(describeTurns(turns))

    // BUG: isProcessing=false triggers session-complete fallback
    // T1 gets marked complete and flushed, then queued user2 is flushed
    // But T1 is still running!
    expect(turns).toHaveLength(3)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns[2]?.type).toBe('user')
  })

  it('scenario: T1 tool-active, queued message, isProcessing=true (correct)', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'running' },
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 200, isQueued: true, isPending: false },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
    console.log('=== Scenario 4: T1 tool-active, queued message, isProcessing=true ===')
    console.log(describeTurns(turns))

    expect(turns).toHaveLength(3)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns[2]?.type).toBe('user')
  })

  it('scenario: T1 has intermediate text (thinking), queued message, isProcessing=false', () => {
    // T1 has intermediate text (thinking process) but no final response
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'completed', toolResult: 'done' },
      { id: 'a1', role: 'assistant', content: 'Let me think about this...', timestamp: base + 200, isStreaming: false, isIntermediate: true },
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 300, isQueued: true, isPending: false },
    ]

    // isProcessing is false because handleUserMessage set it to false for 'queued' status
    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    console.log('=== Scenario 5: T1 intermediate text, queued message, isProcessing=false ===')
    console.log(describeTurns(turns))

    // BUG: isProcessing=false triggers session-complete fallback
    // T1 gets marked complete, intermediate text promoted to response
    // This creates a "final" card for T1 that shouldn't be there yet
    expect(turns).toHaveLength(3)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns[2]?.type).toBe('user')
  })
})
