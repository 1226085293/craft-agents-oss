import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const SESSION_ID = 'session-1'

function makeState(
  messages: any[] = [],
  options: {
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
    streaming: null,
  }
}

function applyEvent(state: SessionState, event: AgentEvent): SessionState {
  return processEvent(state, event).state
}

function compactingRows(state: SessionState): any[] {
  return state.session.messages.filter(
    m => m.role === 'status' && m.statusType === 'compacting',
  )
}

function emitCompacting(state: SessionState, message = 'Compacting context...'): SessionState {
  return applyEvent(state, {
    type: 'status',
    sessionId: SESSION_ID,
    message,
    statusType: 'compacting',
  })
}

describe('Compacting status lifecycle in event processing', () => {
  it('appends the first compacting status as a single row', () => {
    const state = emitCompacting(makeState())
    expect(compactingRows(state)).toHaveLength(1)
    expect(state.session.messages[0]).toMatchObject({
      role: 'status',
      statusType: 'compacting',
      content: 'Compacting context...',
    })
    expect(state.session.currentStatus).toMatchObject({
      message: 'Compacting context...',
      statusType: 'compacting',
    })
  })

  it('dedupes repeated compacting statuses into one row (updated in place)', () => {
    let state = emitCompacting(makeState())
    const firstId = compactingRows(state)[0].id

    // A second compacting status (e.g. re-emitted start) must not stack a new row.
    state = emitCompacting(state, 'Compacting context...')
    expect(compactingRows(state)).toHaveLength(1)
    expect(compactingRows(state)[0].id).toBe(firstId)
    expect(compactingRows(state)[0].content).toBe('Compacting context...')
  })

  it('keeps non-compacting status messages appending normally', () => {
    let state = makeState()
    state = applyEvent(state, {
      type: 'status',
      sessionId: SESSION_ID,
      message: 'Verifying final reply...',
      statusType: 'verification',
    })
    state = applyEvent(state, {
      type: 'status',
      sessionId: SESSION_ID,
      message: 'Other status',
    })
    expect(state.session.messages.filter(m => m.role === 'status')).toHaveLength(2)
  })

  it('drops the pending compacting row when a plain error arrives', () => {
    let state = emitCompacting(makeState())
    expect(compactingRows(state)).toHaveLength(1)

    state = applyEvent(state, {
      type: 'error',
      sessionId: SESSION_ID,
      error: 'Context compaction did not finish: no completion for 305s (compaction timeout 300s). Please retry the message.',
    })

    expect(compactingRows(state)).toHaveLength(0)
    expect(state.session.messages.some(m => m.role === 'error')).toBe(true)
    expect(state.session.currentStatus?.statusType).not.toBe('compacting')
  })

  it('drops the pending compacting row when a typed error arrives', () => {
    let state = emitCompacting(makeState())
    expect(compactingRows(state)).toHaveLength(1)

    state = applyEvent(state, {
      type: 'typed_error',
      sessionId: SESSION_ID,
      error: { message: 'Upstream error', canRetry: true },
    } as any)

    expect(compactingRows(state)).toHaveLength(0)
    expect(state.session.messages.some(m => m.role === 'error')).toBe(true)
  })

  it('errors without a pending compacting row are unaffected', () => {
    const state = applyEvent(makeState([
      { id: 'keep', role: 'assistant', content: 'hi', timestamp: 1 },
    ]), {
      type: 'error',
      sessionId: SESSION_ID,
      error: 'Something failed',
    })
    expect(state.session.messages.map(m => m.id)).toEqual(['keep', expect.anything()])
    expect(state.session.messages[1].role).toBe('error')
  })

  it('still converts the compacting row on successful compaction_complete', () => {
    let state = emitCompacting(makeState())
    state = applyEvent(state, {
      type: 'info',
      sessionId: SESSION_ID,
      message: 'Compacted context to fit within limits',
      statusType: 'compaction_complete',
    } as any)
    expect(compactingRows(state)).toHaveLength(0)
    expect(
      state.session.messages.some(
        m => m.role === 'info' && m.statusType === 'compaction_complete',
      ),
    ).toBe(true)
  })
})
