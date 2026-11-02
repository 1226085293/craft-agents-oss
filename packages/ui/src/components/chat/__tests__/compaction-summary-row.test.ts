import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn, turnHasNoMeaningfulWork, isSoleCompactionResult } from '../turn-utils'
import type { ActivityItem, AssistantTurn } from '../TurnCard'
import type { Message } from '@craft-agent/core'

/**
 * Compaction token-accounting row (2026-10-17, placement fixed 2026-10-19).
 *
 * Both pipeline paths emit a row with statusType 'compaction_summary' and
 * statusParams (before/retained/compacted/checkpoint/after/viaRelief), but the
 * EVENT TYPE is the authoritative manual/auto discriminator:
 *
 *   manual  /compact → INFO  event. Its own turn, NO assistant reply.
 *                         Renders as a STANDALONE card.
 *   auto   threshold  → STATUS event. Fired mid-turn.
 *                         Renders INSIDE that turn's process block.
 *
 * Previously the manual row was appended to whatever turn happened to be open,
 * so on a reload it showed up as a stray line at the bottom of an unrelated
 * conversation (2026-10-19 session 261019-first-crane).
 *
 * The row must be a completed status activity (never a stuck spinner), and it
 * must keep its params so the numbers survive the round trip.
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

/** Auto path: the same row arrives as a STATUS event instead of INFO. */
function statusSummary(params: Record<string, number | string>): Message {
  return {
    id: 'summary-auto-1',
    role: 'status',
    content: 'Compaction summary',
    statusType: 'compaction_summary',
    statusParams: params,
    timestamp: 250,
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
  // 2026-10-19 first-crane: the manual /compact row is emitted as an INFO
  // event, and it used to be appended to whatever turn was still open (or
  // borrowed the previous assistant turn), so the stats read as a stray line
  // at the bottom of an unrelated conversation. It is now its own card.
  it('manual /compact (info) becomes its OWN card, not part of the previous turn', () => {
    const messages = [
      userMsg(),
      assistantMsg(),
      { id: 'u2', role: 'user', content: '/compact', timestamp: 300 } as Message,
      infoSummary({ before: 43210, retained: 20400, compacted: 22810, checkpoint: 1288, viaRelief: 1 }),
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurnsOnly = assistantTurns(turns)
    // 2 assistant turns: the reply, then the standalone compaction card.
    expect(assistantTurnsOnly).toHaveLength(2)
    const summaryTurn = assistantTurnsOnly[1]
    const activities = summaryTurn.activities as ActivityItem[]
    expect(activities).toHaveLength(1)
    const summary = activities[0]
    expect(summary.statusType).toBe('compaction_summary')
    expect(summary.status).toBe('completed')
    expect(summary.type).toBe('status')
    // The earlier turn kept nothing.
    expect(assistantTurnsOnly[0].activities).toHaveLength(0)
  })

  it('auto compaction that lands between two blocks joins the block it enabled', () => {
    // 2026-10-25: the relief pass ends the SDK turn, so the summary is emitted
    // with nothing open and becomes a one-row card *between* two blocks of the
    // same work — "压缩完成" then looked like a notice outside the process
    // block. It belongs at the top of the block it made room for.
    const messages = [
      userMsg(),
      { id: 'tool-1', role: 'tool', content: 'read a file', timestamp: 210 } as Message,
      { id: 'a-1', role: 'assistant', content: 'done', timestamp: 250, isIntermediate: false } as Message,
      infoSummary({ before: 862000, retained: 20100, compacted: 841300, checkpoint: 600, viaRelief: 1 }),
      { id: 'tool-2', role: 'tool', content: 'ran a command', timestamp: 400 } as Message,
      { id: 'a-2', role: 'assistant', content: 'done again', timestamp: 450, isIntermediate: false } as Message,
    ]
    const turns = groupMessagesByTurn(messages)
    const assistantTurnCount = turns.filter(t => t.type === 'assistant').length
    expect(assistantTurnCount).toBe(2)
    const second = turns.filter(t => t.type === 'assistant')[1] as AssistantTurn
    // The row moved into the following block, ahead of its own steps.
    expect(second.activities[0]?.statusType).toBe('compaction_summary')
  })

  it('auto compaction (status) stays INSIDE the turn that triggered it', () => {
    const messages = [
      userMsg(),
      // Auto compaction always fires while a turn is in flight.
      { id: 'tool-1', role: 'tool', content: 'read a file', timestamp: 210 } as Message,
      statusSummary({ before: 43210, retained: 20400, compacted: 22810, checkpoint: 1288, viaRelief: 1 }),
    ]
    const turns = groupMessagesByTurn(messages)
    // One user turn + one assistant turn holding the row — the compaction
    // happened inside that turn, so that is where it must render.
    expect(turns.map(t => t.type)).toEqual(['user', 'assistant'])
    const assistantTurn = turns.find(t => t.type === 'assistant') as AssistantTurn
    const rows = (assistantTurn.activities as ActivityItem[])
      .filter(a => a.statusType === 'compaction_summary')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
  })

  it('keeps the token stats in the activity for i18n interpolation', () => {
    const messages = [
      userMsg(),
      assistantMsg(),
      { id: 'u2', role: 'user', content: '/compact', timestamp: 300 } as Message,
      infoSummary({ before: 720133, retained: 10000, compacted: 710000, checkpoint: 1213, viaRelief: 0 }),
    ]
    const turns = groupMessagesByTurn(messages)
    const assistantTurnsOnly = assistantTurns(turns)
    const summary = (assistantTurnsOnly[1].activities as ActivityItem[])[0]
    expect(summary.statusParams).toEqual({
      before: 720133,
      retained: 10000,
      compacted: 710000,
      checkpoint: 1213,
      viaRelief: 0,
    })
  })
})

/**
 * Manual /compact produces a compaction_summary row and NO assistant response
 * at all. TurnCard used to treat that row as "no meaningful work" and return
 * null for the whole card, so the user never saw 压缩完成：约 A → B
 * (2026-10-18 true-sparrow). The row must keep the card alive.
 */
describe('turnHasNoMeaningfulWork — compaction-only turn stays visible', () => {
  it('keeps a /compact turn (summary row, no response) renderable', () => {
    const messages = [
      { id: 'u1', role: 'user', content: '/compact', timestamp: 100 } as Message,
      infoSummary({ before: 294303, retained: 18629, compacted: 275674, checkpoint: 1969, viaRelief: 1 }),
    ]
    const turn = assistantTurns(groupMessagesByTurn(messages))[0]
    expect(turn).toBeDefined()
    const activities = turn.activities as ActivityItem[]
    expect(activities.some(a => a.statusType === 'compaction_summary')).toBe(true)
    expect(turnHasNoMeaningfulWork(activities, false)).toBe(false)
  })

  it('still hides an interrupted turn with only failed tools', () => {
    const activities: ActivityItem[] = [
      { id: 't1', type: 'tool', status: 'error', timestamp: 1 },
    ]
    expect(turnHasNoMeaningfulWork(activities, false)).toBe(true)
  })

  it('treats verification verdict rows as meaningful', () => {
    const verdict: ActivityItem[] = [
      { id: 'v', type: 'status', status: 'completed', statusType: 'verification_passed', timestamp: 1 },
    ]
    expect(turnHasNoMeaningfulWork(verdict, false)).toBe(false)
  })

  it('is never empty when a response exists', () => {
    expect(turnHasNoMeaningfulWork([], true)).toBe(false)
    const failedTool: ActivityItem[] = [{ id: 't', type: 'tool', status: 'error', timestamp: 1 }]
    expect(turnHasNoMeaningfulWork(failedTool, true)).toBe(false)
  })

  /**
   * Shape of the card, not just its visibility (2026-10-19 true-sparrow):
   * the /compact turn used to render through the assistant path, so a RESULT
   * wore process-card chrome — chevron + step-count badge "1" + collapsible
   * body — and expanding it printed the same line twice (header preview plus
   * body row). The reported symptom was "the compaction result went into a
   * process block". Such a turn must render flat.
   */
  it('renders a /compact result flat, not as a process block', () => {
    const messages = [
      { id: 'u1', role: 'user', content: '/compact', timestamp: 100 } as Message,
      infoSummary({ before: 336702, retained: 20059, compacted: 314688, checkpoint: 2014, after: 22073, viaRelief: 1 }),
    ]
    const turn = assistantTurns(groupMessagesByTurn(messages))[0]
    const activities = turn.activities as ActivityItem[]
    expect(activities).toHaveLength(1)
    expect(isSoleCompactionResult(activities, false)).toBe(true)
  })

  it('keeps auto compaction inside its turn (never flat)', () => {
    // A turn that also did work keeps its process block; the row rides there.
    const withWork: ActivityItem[] = [
      { id: 't1', type: 'tool', status: 'completed', timestamp: 1 },
      { id: 's1', type: 'status', status: 'completed', statusType: 'compaction_summary', timestamp: 2 },
    ]
    expect(isSoleCompactionResult(withWork, false)).toBe(false)
    // ...and a turn that ended with a response is never flat either.
    const sole: ActivityItem[] = [
      { id: 's1', type: 'status', status: 'completed', statusType: 'compaction_summary', timestamp: 1 },
    ]
    expect(isSoleCompactionResult(sole, true)).toBe(false)
  })
})