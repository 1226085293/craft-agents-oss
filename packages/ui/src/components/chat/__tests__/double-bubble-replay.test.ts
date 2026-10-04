/**
 * Regression test for the double-bubble incident (2026-10-03, session
 * 261001-active-eclipse): a defense-verified final reply is DEMOTED to
 * intermediate (isIntermediate=true, message 314) and then REPLAYED as the
 * real final (message 315) with the SAME turnId. When the turn flushes
 * BETWEEN the two (a user interjection, a compaction status, or a reload),
 * the promotion logic promoted 314 into Turn A's visible reply while 315
 * became Turn B's reply → two response bubbles for one turn.
 *
 * Fix contract:
 *  - Only a landed non-intermediate assistant message is a response bubble.
 *  - Demoted/intermediate commentary is never promoted when a replay is absent;
 *    a failed/aborted run must not invent a result.
 */
import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

const base = 1000000
const TURN = 'm-1'

const DEMOTED_TEXT = 'demoted intermediate (314)'
const REPLAY_TEXT = 'replayed final (315)'

function responseBubbles(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn[] {
  return turns.filter((t) => t.type === 'assistant' && (t as AssistantTurn).response) as AssistantTurn[]
}

describe('double-bubble: demoted intermediate + same-turnId replay', () => {
  it('emits exactly ONE response bubble when the replay lands', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the task', timestamp: base },
      // Demoted verification reply (314): intermediate, turnId m-1
      { id: 'a-314', role: 'assistant', content: DEMOTED_TEXT, timestamp: base + 100, isIntermediate: true, turnId: TURN },
      // Interjection flushes the current turn BETWEEN 314 and 315
      { id: 'u2', role: 'user', content: 'another question', timestamp: base + 200 },
      // Replayed final (315): non-intermediate, SAME turnId m-1
      { id: 'a-315', role: 'assistant', content: REPLAY_TEXT, timestamp: base + 300, isIntermediate: false, isStreaming: false, turnId: TURN },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const bubbles = responseBubbles(turns)

    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]?.response?.text).toBe(REPLAY_TEXT)
    // The first turn only contains demoted commentary; the replay is the sole response.
    expect((turns.find(t => t.type === 'assistant') as AssistantTurn).response).toBeUndefined()
  })

  it('flushing via a compaction status message also yields ONE bubble', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the task', timestamp: base },
      { id: 'a-314', role: 'assistant', content: DEMOTED_TEXT, timestamp: base + 100, isIntermediate: true, turnId: TURN },
      // Reload/flush edge: a user message arrives before the replay
      { id: 'u2', role: 'user', content: 'queued interjection', timestamp: base + 200, isQueued: true },
      { id: 'a-315', role: 'assistant', content: REPLAY_TEXT, timestamp: base + 300, isIntermediate: false, isStreaming: false, turnId: TURN },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const bubbles = responseBubbles(turns)

    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]?.response?.text).toBe(REPLAY_TEXT)
  })

  it('does not promote demoted intermediate when the replay never lands', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the task', timestamp: base },
      { id: 'a-314', role: 'assistant', content: DEMOTED_TEXT, timestamp: base + 100, isIntermediate: true, turnId: TURN },
      // No 315 — verification failed without re-delivery
      { id: 'u2', role: 'user', content: 'another question', timestamp: base + 200 },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const bubbles = responseBubbles(turns)

    expect(bubbles).toHaveLength(0)
    expect(turns.some(t => t.type === 'assistant' && (t as AssistantTurn).activities.some(a => a.type === 'intermediate'))).toBe(true)
  })

  it('a BLANK replay still produces no response bubble', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do the task', timestamp: base },
      { id: 'a-314', role: 'assistant', content: DEMOTED_TEXT, timestamp: base + 100, isIntermediate: true, turnId: TURN },
      { id: 'u2', role: 'user', content: 'another question', timestamp: base + 200 },
      // Blank final: rendered nowhere (blank-response filter) but present
      { id: 'a-315', role: 'assistant', content: '   \n  ', timestamp: base + 300, isIntermediate: false, isStreaming: false, turnId: TURN },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const bubbles = responseBubbles(turns)

    // Blank final and prior commentary are not final results.
    expect(bubbles).toHaveLength(0)
  })
})
