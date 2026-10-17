import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '../turn-utils'
import type { ActivityItem, AssistantTurn } from '../TurnCard'
import type { Message } from '@craft-agent/core'

/**
 * Compaction token-accounting row (2026-10-17).
 *
 * Both pipeline paths (auto compaction → STATUS event; manual /compact →
 * INFO event) are folded into INFO with statusType 'compaction_summary' and
 * statusParams (before/retained/compacted/checkpoint/viaRelief). The row must:
 *   1. become a completed status activity inside the CURRENT turn's process
 *      block (never a stuck "running" spinner, never its own card), and
 *   2. keep its params (stats survive the round trip).
 */

function infoSummary(params: Record<string, number | string>): Message {
  return {
    id: 'summary-1',
    role: 'info',
    content: 'Compaction summary',
    statusType: 'compaction_summary',
    statusParams: params,
    timestamp: 300,
  } as Message
}

function userMsg(): Message {
  return { id: 'user-1', role: 'user', content: 'hi', timestamp: 100 } as Message
}

function assistantMsg(): Message {
  return { id: 'assistant-1', role: 'assistant', content: 'ok', timestamp: 200 } as Message
}

function assistantTurns(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn[] {
  return turns.filter(t => t.type === 'assistant') as AssistantTurn[]
}

describe('groupMessagesByTurn — compaction_summary row', () => {
  it('becomes a completed activity inside the current turn, no separate card', () => {
    const messages = [userMsg(), assistantMsg(), infoSummary({ before: 43210, compacted: 33333, checkpoint: 1288, viaRelief: 1 })]

    const turns = groupMessagesByTurn(messages)
    // One assistant turn only — no extra card for the summary.
    const assistantTurnsOnly = assistantTurns(turns)
    expect(assistantTurnsOnly).toHaveLength(1)
    const activities = assistantTurnsOnly[0].activities as ActivityItem[]
    const summary = activities.find(a => a.statusType === 'compaction_summary')
    expect(summary).toBeDefined()
    expect(summary!.status).toBe('completed')
    expect(summary!.type).toBe('status')
  })

  it('keeps the token stats in the activity for i18n interpolation', () => {
    const messages = [
      userMsg(),
      assistantMsg(),
      infoSummary({ before: 720133, retained: 10000, compacted: 710000, checkpoint: 1213, viaRelief: 0 }),
    ]
    const turns = groupMessagesByTurn(messages)
    const activities = assistantTurns(turns)[0].activities as ActivityItem[]
    const summary = activities.find(a => a.statusType === 'compaction_summary')!
    expect(summary.statusParams).toEqual({
      before: 720133,
      retained: 10000,
      compacted: 710000,
      checkpoint: 1213,
      viaRelief: 0,
    })
  })
})