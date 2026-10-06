import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const SESSION_ID = 'session-1'
const RETRY_TURN_ID = 'turn-retry'

function makeState(
  messages: any[] = [],
  options: {
    streaming?: SessionState['streaming']
    currentStatus?: { message: string; statusType?: string }
  } = {},
): SessionState {
  return {
    session: {
      id: SESSION_ID,
      messages,
      lastMessageAt: 1,
      isProcessing: true,
      currentStatus: options.currentStatus,
    } as any,
    streaming: options.streaming ?? null,
  }
}

/** Exercise the public processor dispatch so new event union cases cannot be wired only at handler level. */
function applyEvent(state: SessionState, event: AgentEvent): SessionState {
  return processEvent(state, event).state
}

/**
 * The retry ladder's process-block line is a PERSISTED status row
 * (2026-10-08): exactly ONE `status` message with statusType 'retrying'
 * per ladder, carrying the structured `retry` payload (retrying →
 * recovered/failed). Asserting its state guards the three-state display
 * (重试中 / 重试成功 / 重试失败) and the no-stacking invariant.
 */
function retryRows(state: SessionState): any[] {
  return state.session.messages.filter(
    message => message.role === 'status' && message.statusType === 'retrying',
  )
}

function retryPayload(state: SessionState): any {
  return retryRows(state)[0]?.retry
}

function beginBackoff(
  state: SessionState,
  opts: { message?: string; attempt?: number; nextRetryInMs?: number } = {},
): SessionState {
  return applyEvent(state, {
    type: 'retry',
    sessionId: SESSION_ID,
    phase: 'backoff',
    message: opts.message ?? 'Connection Error. Retrying in 2s (attempt 1)...',
    ...(opts.attempt != null ? { attempt: opts.attempt } : {}),
    ...(opts.nextRetryInMs != null ? { nextRetryInMs: opts.nextRetryInMs } : {}),
  })
}

function messageIds(state: SessionState): string[] {
  return state.session.messages.map(message => message.id)
}

describe('Pi retry lifecycle event processing', () => {
  it('routes text_discard through the processor and removes only unfinished assistant text for its turn', () => {
    const state = makeState(
      [
        { id: 'user', role: 'user', content: 'hello', timestamp: 1 },
        {
          id: 'completed-same-turn',
          role: 'assistant',
          content: 'keep completed',
          timestamp: 2,
          turnId: RETRY_TURN_ID,
          isStreaming: false,
          isPending: false,
        },
        {
          id: 'intermediate-same-turn',
          role: 'assistant',
          content: 'keep intermediate',
          timestamp: 3,
          turnId: RETRY_TURN_ID,
          isIntermediate: true,
          isStreaming: false,
          isPending: false,
        },
        {
          id: 'failed-partial',
          role: 'assistant',
          content: 'discard this partial',
          timestamp: 4,
          turnId: RETRY_TURN_ID,
          isStreaming: true,
          isPending: true,
        },
        {
          id: 'other-turn-partial',
          role: 'assistant',
          content: 'keep other turn',
          timestamp: 5,
          turnId: 'turn-other',
          isStreaming: true,
          isPending: true,
        },
        {
          id: 'same-turn-tool',
          role: 'tool',
          timestamp: 6,
          turnId: RETRY_TURN_ID,
          toolUseId: 'tool-1',
          toolName: 'Read',
          toolStatus: 'completed',
          toolResult: 'ok',
        },
      ],
      {
        streaming: { content: 'discard this partial', turnId: RETRY_TURN_ID },
      },
    )

    const next = applyEvent(state, {
      type: 'text_discard',
      sessionId: SESSION_ID,
      turnId: RETRY_TURN_ID,
    })

    expect(messageIds(next)).toEqual([
      'user',
      'completed-same-turn',
      'intermediate-same-turn',
      'other-turn-partial',
      'same-turn-tool',
    ])
    expect(next.streaming).toBeNull()
  })

  it('does not clear streaming state belonging to a different turn', () => {
    const state = makeState(
      [
        {
          id: 'failed-partial',
          role: 'assistant',
          content: 'discard this partial',
          timestamp: 1,
          turnId: RETRY_TURN_ID,
          isStreaming: true,
          isPending: true,
        },
      ],
      {
        streaming: { content: 'other partial', turnId: 'turn-other' },
      },
    )

    const next = applyEvent(state, {
      type: 'text_discard',
      sessionId: SESSION_ID,
      turnId: RETRY_TURN_ID,
    })

    expect(next.session.messages).toHaveLength(0)
    expect(next.streaming).toEqual({ content: 'other partial', turnId: 'turn-other' })
  })

  it('keeps failed attempts out of a later successful response while preserving completed, intermediate, and other-turn messages', () => {
    let state = makeState([
      {
        id: 'completed-same-turn',
        role: 'assistant',
        content: 'earlier completed response',
        timestamp: 1,
        turnId: RETRY_TURN_ID,
        isStreaming: false,
        isPending: false,
      },
      {
        id: 'intermediate-same-turn',
        role: 'assistant',
        content: 'earlier tool commentary',
        timestamp: 2,
        turnId: RETRY_TURN_ID,
        isIntermediate: true,
        isStreaming: false,
        isPending: false,
      },
      {
        id: 'other-turn-message',
        role: 'assistant',
        content: 'unrelated completed response',
        timestamp: 3,
        turnId: 'turn-other',
        isStreaming: false,
        isPending: false,
      },
    ])

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'First failed answer. ',
      turnId: RETRY_TURN_ID,
    })
    state = applyEvent(state, { type: 'text_discard', sessionId: SESSION_ID, turnId: RETRY_TURN_ID })
    state = beginBackoff(state, { attempt: 0, nextRetryInMs: 1000 })
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'active' })

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'Different failed answer. ',
      turnId: RETRY_TURN_ID,
    })
    state = applyEvent(state, { type: 'text_discard', sessionId: SESSION_ID, turnId: RETRY_TURN_ID })
    state = beginBackoff(state, { message: 'Connection Error. Retrying in 4s (attempt 2)...', attempt: 1, nextRetryInMs: 4000 })
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'active' })

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'Good answer.',
      turnId: RETRY_TURN_ID,
    })
    state = applyEvent(state, {
      type: 'text_complete',
      sessionId: SESSION_ID,
      text: 'Good answer.',
      turnId: RETRY_TURN_ID,
      messageId: 'successful-response',
      timestamp: 10,
    })
    // The retried run recovered: the terminal `retry end` carries recovered=true.
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'end', recovered: true, attempt: 2 })

    expect(messageIds(state)).toEqual([
      'completed-same-turn',
      'intermediate-same-turn',
      'other-turn-message',
      expect.stringMatching(/^msg-/), // persisted retry row at ladder start
      'successful-response',
    ])
    // Chronological order: the retry row (triggered at backoff, before the
    // retried run) sits BEFORE the recovered run's final response.
    const retryIdx = messageIds(state).findIndex(id => id === retryRows(state)[0]?.id)
    const responseIdx = messageIds(state).indexOf('successful-response')
    expect(retryIdx).toBeGreaterThanOrEqual(0)
    expect(retryIdx).toBeLessThan(responseIdx)
    expect(state.session.messages.find(message => message.id === 'successful-response')?.content).toBe('Good answer.')
    expect(state.session.messages.some(message => message.content?.includes('First failed answer'))).toBe(false)
    expect(state.session.messages.some(message => message.content?.includes('Different failed answer'))).toBe(false)
    // The retry ladder leaves exactly ONE persisted status row, settled to 'recovered'.
    expect(retryRows(state)).toHaveLength(1)
    expect(retryPayload(state)).toMatchObject({ status: 'recovered', attempt: 2 })
    expect(state.session.currentStatus).toBeUndefined()
    expect(state.streaming).toBeNull()
  })

  it('keeps exhausted partial output out of the transcript and preserves unrelated messages', () => {
    let state = makeState([
      {
        id: 'completed',
        role: 'assistant',
        content: 'keep completed',
        timestamp: 1,
        turnId: RETRY_TURN_ID,
        isStreaming: false,
        isPending: false,
      },
      {
        id: 'intermediate',
        role: 'assistant',
        content: 'keep intermediate',
        timestamp: 2,
        turnId: RETRY_TURN_ID,
        isIntermediate: true,
        isStreaming: false,
        isPending: false,
      },
      {
        id: 'other-turn',
        role: 'assistant',
        content: 'keep other turn',
        timestamp: 3,
        turnId: 'turn-other',
        isStreaming: false,
        isPending: false,
      },
    ])

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'final failed partial',
      turnId: RETRY_TURN_ID,
    })
    state = applyEvent(state, { type: 'text_discard', sessionId: SESSION_ID, turnId: RETRY_TURN_ID })
    state = beginBackoff(state, { attempt: 1, nextRetryInMs: 10000 })
    // Ladder gave up: terminal `retry end` with recovered=false.
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'end', recovered: false, attempt: 2 })
    state = applyEvent(state, {
      type: 'typed_error',
      sessionId: SESSION_ID,
      error: {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not reach the AI service.',
        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
        canRetry: true,
      },
      timestamp: 20,
    })
    state = applyEvent(state, { type: 'complete', sessionId: SESSION_ID })

    expect(messageIds(state)).toEqual([
      'completed',
      'intermediate',
      'other-turn',
      expect.stringMatching(/^msg-/), // persisted retry row
      expect.stringMatching(/^msg-/), // terminal error card
    ])
    expect(state.session.messages.some(message => message.content?.includes('final failed partial'))).toBe(false)
    expect(state.session.messages.at(-1)?.role).toBe('error')
    // Exactly one persisted retry row, settled to 'failed' by `retry end`.
    expect(retryRows(state)).toHaveLength(1)
    expect(retryPayload(state)).toMatchObject({ status: 'failed', attempt: 2 })
    expect(state.session.currentStatus).toBeUndefined()
    // The 'failed' outcome lingers on complete (it is durable, not cleared
    // by the next user turn).
    expect(state.streaming).toBeNull()
  })

  // --- the persisted retry row drives the single process-block retry line ---

  it('creates a single persisted retry row on backoff (no currentStatus)', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 5000 })
    expect(retryRows(state)).toHaveLength(1)
    expect(state.session.currentStatus).toBeUndefined()
    expect(retryPayload(state)).toMatchObject({ status: 'retrying', attempt: 1 })
    expect(retryPayload(state)?.nextRetryAt).toBeGreaterThan(Date.now() + 4000)
    // Ladder start anchors the terminal "total elapsed" line.
    expect(typeof retryPayload(state)?.startedAt).toBe('number')
    // The row timestamp anchors its chronological position.
    expect(retryRows(state)[0]?.timestamp).toBe(retryPayload(state)?.startedAt)
  })

  it('drops the countdown once the retry is in flight, and freezes elapsed on a plain end', () => {
    let state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 5000 })
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'active' })
    expect(retryPayload(state)?.status).toBe('retrying')
    // In flight → no stale 00:00 countdown target.
    expect(retryPayload(state)?.nextRetryAt).toBeUndefined()
    state = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'end' })
    expect(retryPayload(state)).toMatchObject({ status: 'failed', attempt: 1 })
    expect(typeof retryPayload(state)?.elapsedMs).toBe('number')
    // Still exactly one row — updated in place, never stacked.
    expect(retryRows(state)).toHaveLength(1)
  })

  it('marks the retry row recovered on a successful end and keeps the ladder start', () => {
    const state = beginBackoff(makeState(), { attempt: 2, nextRetryInMs: 10000 })
    const next = applyEvent(state, { type: 'retry', sessionId: SESSION_ID, phase: 'end', recovered: true, attempt: 2 })
    expect(retryPayload(next)).toMatchObject({ status: 'recovered', attempt: 2 })
    expect(retryPayload(next)?.startedAt).toBe(retryPayload(state)?.startedAt)
    expect(typeof retryPayload(next)?.elapsedMs).toBe('number')
  })

  it('advances the single retry row across backoff attempts without stacking rows', () => {
    const compacting = {
      id: 'compacting',
      role: 'status',
      content: 'Compacting context...',
      statusType: 'compacting',
      timestamp: 1,
    }
    let state = beginBackoff(makeState([compacting]), { attempt: 1, nextRetryInMs: 1000 })
    state = beginBackoff(state, { message: 'Connection Error. Retrying in 4s (attempt 2)...', attempt: 2, nextRetryInMs: 4000 })

    expect(retryRows(state)).toHaveLength(1)
    expect(messageIds(state)).toContain('compacting')
    expect(retryPayload(state)).toMatchObject({ status: 'retrying', attempt: 2 })
    expect(state.session.currentStatus).toBeUndefined()
  })

  it('does not change the retry row on a text delta or tool start during backoff', () => {
    let state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 2000 })

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'late failed-attempt delta',
      turnId: RETRY_TURN_ID,
    })
    expect(retryPayload(state)?.status).toBe('retrying')

    state = applyEvent(state, {
      type: 'tool_start',
      sessionId: SESSION_ID,
      toolUseId: 'tool-1',
      toolName: 'Read',
      toolInput: { file_path: 'README.md' },
      turnId: RETRY_TURN_ID,
    })
    expect(retryPayload(state)?.status).toBe('retrying')
    expect(retryRows(state)).toHaveLength(1)
  })

  // --- fail-safe on terminal events ---

  it('settles a stuck retrying row to failed on complete (never a stale spinner)', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 1000 })
    const next = applyEvent(state, { type: 'complete', sessionId: SESSION_ID })
    expect(retryRows(next)).toHaveLength(1)
    expect(retryPayload(next)).toMatchObject({ status: 'failed', attempt: 1 })
  })

  it('marks a stuck retrying row failed on a terminal error', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 1000 })
    const next = applyEvent(state, {
      type: 'error',
      sessionId: SESSION_ID,
      error: 'request failed',
      timestamp: 10,
    })
    expect(retryPayload(next)).toMatchObject({ status: 'failed', attempt: 1 })
    expect(next.session.messages.at(-1)?.role).toBe('error')
  })

  it('does not settle the retry row on a non-terminal retryPending error card', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 1000 })
    const next = applyEvent(state, {
      type: 'error',
      sessionId: SESSION_ID,
      error: 'API error — retrying in the background',
      retryPending: true,
      retryAttempt: 1,
      timestamp: 10,
    })
    // The ladder is still running — the row stays 'retrying'.
    expect(retryPayload(next)).toMatchObject({ status: 'retrying', attempt: 1 })
  })

  it('marks a stuck retrying row failed on a terminal typed_error', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 1000 })
    const next = applyEvent(state, {
      type: 'typed_error',
      sessionId: SESSION_ID,
      error: {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not reach the AI service.',
        actions: [],
        canRetry: true,
      },
      timestamp: 10,
    })
    expect(retryPayload(next)).toMatchObject({ status: 'failed', attempt: 1 })
  })

  it('keeps the persisted retry row on interruption, settled to failed', () => {
    const state = beginBackoff(makeState(), { attempt: 1, nextRetryInMs: 1000 })
    const next = applyEvent(state, {
      type: 'interrupted',
      sessionId: SESSION_ID,
      message: {
        id: 'interrupted',
        role: 'info',
        content: 'Response interrupted',
        timestamp: 10,
      },
    })
    // The row is durable: it survives the interruption and shows the terminal
    // state (the ladder did not recover).
    expect(retryRows(next)).toHaveLength(1)
    expect(retryPayload(next)).toMatchObject({ status: 'failed', attempt: 1 })
  })

  it('keeps the session processing after an error until the actual complete event', () => {
    let state = makeState([], { streaming: { content: 'partial response', turnId: RETRY_TURN_ID } })
    state = applyEvent(state, {
      type: 'error',
      sessionId: SESSION_ID,
      error: 'stream disconnected before completion',
      timestamp: 5,
    })

    expect(state.session.isProcessing).toBe(true)
    expect(state.session.messages.at(-1)?.role).toBe('error')

    state = applyEvent(state, {
      type: 'text_delta',
      sessionId: SESSION_ID,
      delta: 'recovery is still running',
      turnId: 'recovery-turn',
    })
    expect(state.session.isProcessing).toBe(true)

    state = applyEvent(state, { type: 'complete', sessionId: SESSION_ID })
    expect(state.session.isProcessing).toBe(false)
  })

  it('closes verification state before a verified final text is appended', () => {
    let state = makeState([
      { id: 'verify', role: 'status', content: 'Verifying final reply…', statusType: 'verification', timestamp: 1 },
    ])

    state = applyEvent(state, {
      type: 'info',
      sessionId: SESSION_ID,
      message: 'Verification passed — delivering final reply',
      statusType: 'verification_passed',
      timestamp: 2,
    })
    expect(state.session.messages.some(message => message.role === 'assistant' && message.content === 'Verified answer')).toBe(false)
    expect(state.session.messages[0]).toMatchObject({ role: 'info', statusType: 'verification_passed' })

    state = applyEvent(state, {
      type: 'text_complete',
      sessionId: SESSION_ID,
      text: 'Verified answer',
      timestamp: 3,
      messageId: 'verified-final',
    })
    expect(state.session.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Verified answer' })
  })
})
