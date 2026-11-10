import { describe, expect, it } from 'bun:test'
import { handleInfo } from '../handlers/session.ts'
import type { InfoEvent } from '../types.ts'
import type { SessionState } from '../handlers/session.ts'

/**
 * A freshly pushed decision card rendered wrong until the session was reopened.
 *
 * The live event arrives as `type: 'info'` with `statusType: 'decision_request'` and a
 * `decisionRequest` payload. The handler copied the statusType and dropped the payload,
 * so the row announced a card and had nothing to draw — it fell through to the plain
 * info branch. Reopening the session read the persisted row, where every field exists,
 * and it looked correct. Same message, two shapes, depending on how you arrived.
 */
const emptyState = {
  session: { id: 'sess-1', messages: [] },
  streaming: false,
} as unknown as SessionState

const request = {
  id: 'req-1',
  askedBySessionId: 'session-supervisor',
  askedByLabel: '督导 · 任务',
  taskIdentifier: 'T-1',
  question: '计划中还剩 3 步未授权，是否继续？',
  options: ['放行', '到此为止'],
  askedAt: 1_700_000_000_000,
}

describe('a decision request arriving live', () => {
  it('keeps the payload the card is drawn from', () => {
    const event: InfoEvent = {
      type: 'info',
      sessionId: 'sess-1',
      message: request.question,
      statusType: 'decision_request',
      timestamp: request.askedAt,
      decisionRequest: request,
    }

    const result = handleInfo(emptyState, event)
    const appended = result.state.session.messages.at(-1)

    expect(appended?.role).toBe('info')
    expect(appended?.statusType).toBe('decision_request')
    // Without this the renderer draws a plain line: the branch it needs requires BOTH
    // the status type and the payload.
    expect(appended?.decisionRequest).toEqual(request)
  })

  it('still appends an ordinary notice without inventing a payload', () => {
    const result = handleInfo(emptyState, {
      type: 'info',
      sessionId: 'sess-1',
      message: '后台任务已完成',
    })

    const appended = result.state.session.messages.at(-1)
    expect(appended?.content).toBe('后台任务已完成')
    expect(appended?.decisionRequest).toBeUndefined()
  })
})

/**
 * The same drift, one row over: a report to the person rendered as system chrome.
 *
 * `report_to_user` is persisted with `role: 'assistant'` and `isRelayed: true` — an agent
 * telling a person something — but it was pushed as a plain `info` event, so the live row was
 * a grey status line and only read as a bubble after reopening the session. The event now
 * carries the record's answer.
 */
describe('a report meant for the person', () => {
  it('is pushed as an assistant bubble, not a notice line', () => {
    const result = handleInfo(emptyState, {
      type: 'info',
      sessionId: 'sess-1',
      message: 'T-1 本轮范围（仅 1.1）已交付并验收通过。',
      level: 'success',
      asAssistantBubble: true,
      messageId: 'msg-relayed-1',
    } as InfoEvent)

    const [row] = result.state.session.messages
    expect(row.role).toBe('assistant')
    // Relayed, so nothing mistakes it for this session's own reply.
    expect(row.isRelayed).toBe(true)
    // The persisted id travels with it: a reload must not add a second copy.
    expect(row.id).toBe('msg-relayed-1')
  })

  it('leaves an ordinary notice as an info row', () => {
    const result = handleInfo(emptyState, {
      type: 'info',
      sessionId: 'sess-1',
      message: '已压缩上下文',
    } as InfoEvent)
    expect(result.state.session.messages[0]!.role).toBe('info')
  })
})
