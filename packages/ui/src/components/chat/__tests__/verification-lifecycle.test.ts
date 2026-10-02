/**
 * Verification-card lifecycle (2026-10-02 user-approved redesign):
 * a status(verification) card appears as a process step; on pass
 * (info verification_passed) the card completes and the replayed final
 * bubble (a real assistant message) becomes the turn's single response;
 * on fail (info verification_failed) the card errors and the follow-up
 * assistant reply renders as the turn response.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

let seq = 0
function msg(partial: Partial<Message> & { role: Message['role'] }): Message {
  seq += 1
  return {
    id: `m-${seq}`,
    content: '',
    timestamp: Date.now() + seq * 100,
    ...partial,
  } as Message
}

function verifyCard(turn: AssistantTurn) {
  return turn.activities.find((a) => a.type === 'status' && a.statusType === 'verification')
}

describe('turn lifecycle — verification class (2026-10-02)', () => {
  beforeEach(() => { seq = 0 })

  it('verification card completes on pass and the replayed final bubble is the single response', () => {
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '部署完成后总结' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({ role: 'info', content: 'Verification passed — delivering final reply', statusType: 'verification_passed' }),
      msg({ role: 'assistant', content: '部署完成 ✅', isIntermediate: false }),
    ])
    expect(turns.length).toBe(2)
    const assistantTurn = turns[1] as AssistantTurn
    const card = verifyCard(assistantTurn)
    expect(card).toBeDefined()
    expect(card!.status).toBe('completed')
    expect(assistantTurn.response?.text).toBe('部署完成 ✅')
  })

  it('verification card errors on fail; no forced response', () => {
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '部署完成后总结' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed' }),
    ])
    const assistantTurn = turns[1] as AssistantTurn
    const card = verifyCard(assistantTurn)
    expect(card).toBeDefined()
    expect(card!.status).toBe('error')
    expect(assistantTurn.response).toBeUndefined()
  })

  it('follow-up reply after a failed verdict becomes the turn response', () => {
    const turns = groupMessagesByTurn([
      msg({ role: 'user', content: '部署完成后总结' }),
      msg({ role: 'status', content: 'Verifying final reply…', statusType: 'verification' }),
      msg({ role: 'info', content: 'Verification failed — continuing', statusType: 'verification_failed' }),
      msg({ role: 'assistant', content: '补充说明：任务已完成', isIntermediate: false }),
    ])
    const assistantTurn = turns[turns.length - 1] as AssistantTurn
    expect(assistantTurn.response?.text).toBe('补充说明：任务已完成')
  })
})