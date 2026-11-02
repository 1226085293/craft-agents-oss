/**
 * 2026-10-22 queued-panel: queued messages are NOT transcript bubbles anymore.
 *
 * The pending queue renders in a panel above the composer, fed by the backend's
 * `queued_messages_changed` snapshot. The turn grouper must therefore SKIP any
 * row still flagged `isQueued` so the transcript shows only what the agent has
 * actually been given.
 *
 * Queued rows are panel content, not turns — the grouper drops them.
 */
import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn, type UserTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

const base = 1000000

describe('queued messages stay out of the transcript', () => {
  it('drops a queued message while the current turn is streaming', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Running Bash...', timestamp: base + 100, toolName: 'Bash', toolUseId: 'call-1', toolStatus: 'completed', toolResult: 'done' },
      { id: 'a1', role: 'assistant', content: 'Here is my answer...', timestamp: base + 200, isStreaming: true, isIntermediate: false },
      { id: 'u2', role: 'user', content: 'follow up question', timestamp: base + 300, isQueued: true, isPending: false },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })

    // user1 → assistant T1 only; the queued message is panel content.
    expect(turns).toHaveLength(2)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    expect(turns.some(t => t.type === 'user' && (t as UserTurn).message.id === 'u2')).toBe(false)
  })

  it('drops queued messages even when several stack up', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'a1', role: 'assistant', content: 'answer', timestamp: base + 100, isStreaming: true },
      { id: 'u2', role: 'user', content: 'queued 1', timestamp: base + 200, isQueued: true },
      { id: 'u3', role: 'user', content: 'queued 2', timestamp: base + 300, isQueued: true },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
    const userIds = turns.filter(t => t.type === 'user').map(t => (t as UserTurn).message.id)
    expect(userIds).toEqual(['u1'])
  })

  it('keeps a queued row out of the transcript while tools are active', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'tool1', role: 'tool', content: 'Grep', timestamp: base + 100, toolName: 'Grep', toolUseId: 'c1', toolStatus: 'executing' },
      { id: 'u2', role: 'user', content: 'queued during tools', timestamp: base + 200, isQueued: true },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
    expect(turns.filter(t => t.type === 'user')).toHaveLength(1)
    const assistant = turns.find(t => t.type === 'assistant') as AssistantTurn
    // The tool row still renders inside the active process card.
    expect(assistant?.activities.some(a => a.toolName === 'Grep')).toBe(true)
  })

  it('renders the same message normally once the queued flag is cleared (replay)', () => {
    const queued: Message[] = [
      { id: 'u1', role: 'user', content: 'question 1', timestamp: base },
      { id: 'a1', role: 'assistant', content: 'answer', timestamp: base + 100, isIntermediate: false },
      { id: 'u2', role: 'user', content: 'queued 1', timestamp: base + 200, isQueued: true },
    ]
    expect(groupMessagesByTurn(queued).filter(t => t.type === 'user')).toHaveLength(1)

    // The backend clears isQueued when the row is drained into a real turn.
    const drained = queued.map(m => (m.id === 'u2' ? { ...m, isQueued: false } : m))
    const turns = groupMessagesByTurn(drained)
    expect(turns.filter(t => t.type === 'user')).toHaveLength(2)
    expect(turns[turns.length - 1]?.type).toBe('user')
  })
})
