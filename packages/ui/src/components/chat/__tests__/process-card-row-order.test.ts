import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

/**
 * Process-card row order for mid-stream user guidance (2026-10-07).
 *
 * A guidance message is stamped with its SEND time. Assistant thinking blocks
 * are stamped with their COMPLETION time, which lands AFTER the guidance when
 * the user steers mid-stream — so sorting rows by that timestamp rendered the
 * guidance ABOVE the blocks that were already visible when it was sent.
 *
 * Fix: thinking blocks carry `startedAt` (their first text_delta). The
 * process card sorts rows by `startedAt ?? timestamp`, so guidance lands
 * after the blocks that had already started streaming.
 */

const base = 1_700_000_000_000

function assistantTurns(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn[] {
  return turns.filter((t): t is AssistantTurn => t.type === 'assistant')
}

function rowKeys(turns: ReturnType<typeof groupMessagesByTurn>): string[] {
  // The last assistant turn holds the still-running process card; its
  // activities carry stable ids (message ids / tool ids).
  const last = assistantTurns(turns).at(-1)
  expect(last).toBeDefined()
  return last!.activities.map(a => a.id)
}

describe('process card row order: mid-stream guidance (startedAt)', () => {
  it('guidance sent during a thinking block sorts AFTER that block', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'list my desktop folders', timestamp: base + 52 },
      // Thinking block m1: started streaming at +53, completed at +59.
      {
        id: 'a-m1', role: 'assistant', content: 'The user is asking…',
        timestamp: base + 59, startedAt: base + 53,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      // Tool call: started at +55 (tool rows keep their start-time stamp).
      {
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 55, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      // Guidance sent at +57 — AFTER m1 started (53) and the tool started (55).
      {
        id: 'u-guide', role: 'user', content: '还有你叫什么？',
        timestamp: base + 57, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
      // Next thinking block: started at +60, completed at +63.
      {
        id: 'a-m3', role: 'assistant', content: 'Let me answer both…',
        timestamp: base + 63, startedAt: base + 60,
        isIntermediate: true, turnId: 'pi-turn-1__m3',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    expect(rowKeys(turns)).toEqual(['a-m1', 'tool-1', 'u-guide', 'a-m3'])
  })

  it('legacy records without startedAt fall back to the completion timestamp', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'list my desktop folders', timestamp: base + 52 },
      // No startedAt (pre-fix persisted records) — key = completion time +59.
      {
        id: 'a-m1', role: 'assistant', content: 'The user is asking…',
        timestamp: base + 59, isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      {
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 55, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      {
        id: 'u-guide', role: 'user', content: '还有你叫什么？',
        timestamp: base + 57, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    // Fallback ordering: tool(55) → guidance(57) → m1(59).
    expect(rowKeys(turns)).toEqual(['tool-1', 'u-guide', 'a-m1'])
  })

  it('streaming (pending) thinking rows keep sorting last via display sort', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'list my desktop folders', timestamp: base + 52 },
      {
        id: 'a-m1', role: 'assistant', content: 'The user is asking…',
        timestamp: base + 59, startedAt: base + 53,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      {
        id: 'u-guide', role: 'user', content: '还有你叫什么？',
        timestamp: base + 57, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
      // Still streaming — startedAt not known yet; pending rows render last.
      {
        id: 'a-m3', role: 'assistant', content: 'Let me…',
        timestamp: base + 60, startedAt: base + 60,
        isIntermediate: true, isPending: true, isStreaming: true, turnId: 'pi-turn-1__m3',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: true })
    // Completed rows sort chronologically; the pending row is flagged running
    // and sortActivitiesForDisplay (render-time) keeps it at the tail.
    const last = assistantTurns(turns).at(-1)!
    const completed = last.activities.filter(a => a.status !== 'running')
    expect(completed.map(a => a.id)).toEqual(['a-m1', 'u-guide'])
    expect(last.activities.find(a => a.id === 'a-m3')?.status).toBe('running')
  })

  it('guidance stamped at the guide click (startedAt) sorts AFTER the steps visible at that moment', () => {
    // 2026-10-07 plain-jade: the user sent the guidance (+54, after the
    // question) while the card only showed "Thinking…", saw the thinking
    // block (started +56) and tool row (+58) appear, and only THEN clicked
    // 引导 (+65). The main process stamps `startedAt` on the guide click; the
    // row position must follow it — not the earlier send time.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'list my desktop folders', timestamp: base + 52 },
      {
        id: 'a-m1', role: 'assistant', content: 'The user is asking…',
        timestamp: base + 62, startedAt: base + 56,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      {
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 58, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      {
        id: 'u-guide', role: 'user', content: '还有你叫什么？',
        timestamp: base + 54, startedAt: base + 65, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    // m1(56) → tool(58) → guidance (guide click 65, NOT send time 54).
    expect(rowKeys(turns)).toEqual(['a-m1', 'tool-1', 'u-guide'])
  })

  it('guidance without a guide-click stamp keeps its send-time position', () => {
    // Pre-stamp persisted records (and direct sends, never queued) have no
    // startedAt → the row falls back to the send timestamp (+54, before the
    // thinking block that started at +56).
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'list my desktop folders', timestamp: base + 52 },
      {
        id: 'a-m1', role: 'assistant', content: 'The user is asking…',
        timestamp: base + 62, startedAt: base + 56,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      {
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 58, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      {
        id: 'u-guide', role: 'user', content: '还有你叫什么？',
        timestamp: base + 54, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    // Send-time fallback: guidance(54) → m1(56) → tool(58).
    expect(rowKeys(turns)).toEqual(['u-guide', 'a-m1', 'tool-1'])
  })

  it('drain re-stamp groups the guidance into the DRAIN card (after the first answer), not the first card', () => {
    // 2026-10-07 plain-jade round 2: “你的名字叫什麼” is answered (+72);
    // “告訴我桌面有什麼文件夾” was TYPED at +60 (before answer 1) but the
    // agent READ it at the drain (+78 — the re-stamp). The row must sit in
    // the SECOND card (between answer 1 and the drain round's steps), not in
    // the first card above answer 1.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '你的名字叫什麼？', timestamp: base + 56 },
      { // Answer 1's thinking block.
        id: 'a-m1', role: 'assistant', content: 'The user is asking my name…',
        timestamp: base + 70, startedAt: base + 58,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      { // Answer 1 (the Agnes bubble) — completed +72, turn ends.
        id: 'a-m2', role: 'assistant', content: '我是 Agnes-3.0-flash。',
        timestamp: base + 72, startedAt: base + 71, isIntermediate: false, turnId: 'pi-turn-1__m2',
      },
      { // Guidance: typed +60, guide-click +65, drain re-stamp +78.
        id: 'u-guide', role: 'user', content: '告訴我桌面有什麼文件夾',
        timestamp: base + 60, startedAt: base + 78, isGuidance: true, isQueued: false, turnId: 'pi-turn-1',
      },
      { // The drain round's work.
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 80, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      { // Answer 2's thinking (started just after the drain splice).
        id: 'a-m3', role: 'assistant', content: 'Let me filter out the folders…',
        timestamp: base + 85, startedAt: base + 79,
        isIntermediate: true, turnId: 'pi-turn-1__m3',
      },
      { // Answer 2 (the folders bubble) — completed +95, turn ends.
        id: 'a-m4', role: 'assistant', content: '你桌面上共 11 個文件夾',
        timestamp: base + 95, startedAt: base + 94, isIntermediate: false, turnId: 'pi-turn-1__m4',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const cards = assistantTurns(turns)
    expect(cards.length).toBeGreaterThanOrEqual(2)
    // First card: only answer 1's thinking — NO guidance row.
    expect(cards[0]!.activities.map(a => a.id)).toEqual(['a-m1'])
    // Second card: the guidance row leads (drain time 78 < thinking start 79
    // < tool 80), then the drain round's steps — i.e. AFTER answer 1.
    expect(rowKeys(turns)).toEqual(['u-guide', 'a-m3', 'tool-1'])
    expect(cards.at(-1)!.activities.map(a => a.id)).toEqual(['u-guide', 'a-m3', 'tool-1'])
  })

  it('complete-time pairing: the guidance row leads its answering card, ABOVE the paired thinking', () => {
    // 2026-10-07 clobber-marble round 2: three finals ([folders, name, date])
    // and two guidances. The main process pairs g1 ↔ name round, g2 ↔ date
    // round and keys each row at "previous final ts + 1" — so each row sorts
    // BEFORE the paired round's THINKING block (which started earlier than
    // the final reply it belongs to).
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: '告诉我桌面有什么文件夹', timestamp: base + 56_000 },
      { // Round 1 (folders).
        id: 'a-m1', role: 'assistant', content: 'thinking folders…',
        timestamp: base + 70_000, startedAt: base + 58_000,
        isIntermediate: true, turnId: 'pi-turn-1__m1',
      },
      {
        id: 'tool-1', role: 'tool', content: 'Ls result',
        timestamp: base + 71_000, toolName: 'Ls', toolUseId: 'tc-1',
        toolStatus: 'completed', toolResult: 'ok', turnId: 'pi-turn-1',
      } as Message,
      { // Finals in round order: folders → name → date.
        id: 'a-m2', role: 'assistant', content: '你桌面上共 11 個文件夾',
        timestamp: base + 72_000, startedAt: base + 71_500, isIntermediate: false, turnId: 'pi-turn-1__m2',
      },
      { id: 'g1', role: 'user', content: '告诉我你的名字',
        timestamp: base + 60_000, startedAt: base + 72_001, isGuidance: true, turnId: 'pi-turn-1',
      },
      { // The name round's thinking started BEFORE the name reply…
        id: 'a-m3', role: 'assistant', content: 'The user is asking for my name…',
        timestamp: base + 75_000, startedAt: base + 74_000,
        isIntermediate: true, turnId: 'pi-turn-1__m3',
      },
      {
        id: 'a-m4', role: 'assistant', content: '我是 Craft Agent…',
        timestamp: base + 76_000, startedAt: base + 75_500, isIntermediate: false, turnId: 'pi-turn-1__m4',
      },
      { id: 'g2', role: 'user', content: '告诉我今天的日期',
        timestamp: base + 61_000, startedAt: base + 76_001, isGuidance: true, turnId: 'pi-turn-1',
      },
      {
        id: 'a-m5', role: 'assistant', content: 'The user is asking for the date…',
        timestamp: base + 79_000, startedAt: base + 78_000,
        isIntermediate: true, turnId: 'pi-turn-1__m5',
      },
      {
        id: 'a-m6', role: 'assistant', content: '今天是 2026年10月7日…',
        timestamp: base + 80_000, startedAt: base + 79_500, isIntermediate: false, turnId: 'pi-turn-1__m6',
      },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const cards = assistantTurns(turns)
    expect(cards.length).toBe(3)
    // Card 1 (folders): no guidance rows.
    expect(cards[0]!.activities.map(a => a.id)).toEqual(['a-m1', 'tool-1'])
    // Card 2 (name): g1 LEADS — above the paired thinking (72001 < 74000).
    expect(cards[1]!.activities.map(a => a.id)).toEqual(['g1', 'a-m3'])
    // Card 3 (date): g2 leads the last card.
    expect(cards[2]!.activities.map(a => a.id)).toEqual(['g2', 'a-m5'])
  })
})
