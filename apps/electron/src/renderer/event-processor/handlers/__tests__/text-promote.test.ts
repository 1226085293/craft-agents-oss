import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const SESSION_ID = 'session-1'

function makeState(messages: any[] = []): SessionState {
  return {
    session: {
      id: SESSION_ID,
      messages,
      lastMessageAt: 1,
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

function applyEvent(state: SessionState, event: AgentEvent): SessionState {
  return processEvent(state, event).state
}

function complete(
  state: SessionState,
  turnId: string,
  text: string,
  isIntermediate: boolean,
): SessionState {
  return applyEvent(state, {
    type: 'text_complete',
    sessionId: SESSION_ID,
    text,
    turnId,
    isIntermediate,
  } as AgentEvent)
}

/**
 * text_promote (2026-10-07 wise-horizon / slim-badger): when a mid-turn user
 * steer is drained, the demoted MAIN reply must return to a result bubble in
 * the LIVE in-app display — not only on reload (the SessionManager flips the
 * persisted record; the live display needs this handler to agree).
 */
describe('text_promote re-promotes a demoted main reply in the live display', () => {
  it('flips the demoted (intermediate) reply back to a result bubble; the drain stays final', () => {
    // 1) main reply completes UNDER the queued-follow-up hold → intermediate.
    let state = complete(makeState(), 'pi-turn-1__m2', '你桌面上的文件夹有这些：模型、uni-api', true)
    // 2) the drain's answer completes as the turn's result (non-intermediate).
    state = complete(state, 'pi-turn-1__m4', '我是 Craft Agent，由 Sapiens AI 开发。', false)
    // 3) the hold releases on the drain's terminal stop → text_promote.
    state = applyEvent(state, {
      type: 'text_promote',
      sessionId: SESSION_ID,
      turnId: 'pi-turn-1__m2',
      text: '你桌面上的文件夹有这些：模型、uni-api',
    } as AgentEvent)

    const m2 = state.session.messages.find((m: any) => m.turnId === 'pi-turn-1__m2')
    const m4 = state.session.messages.find((m: any) => m.turnId === 'pi-turn-1__m4')
    expect(m2?.isIntermediate).toBe(false)
    expect(m4?.isIntermediate).toBe(false)
  })

  it('is a no-op when no intermediate record matches (duplicate or late event)', () => {
    let state = complete(makeState(), 'pi-turn-1__m2', 'main reply', false)
    const before = applyEvent(state, {
      type: 'text_promote',
      sessionId: SESSION_ID,
      turnId: 'pi-turn-1__m2',
      text: 'main reply',
    } as AgentEvent)
    // No demoted record to flip → identical state reference (true no-op).
    expect(before).toBe(state)
  })

  it('leaves other turns untouched', () => {
    let state = complete(makeState(), 'pi-turn-0__m9', 'earlier final', false)
    state = complete(state, 'pi-turn-1__m2', 'demoted main', true)
    state = complete(state, 'pi-turn-1__m4', 'drain final', false)
    state = applyEvent(state, {
      type: 'text_promote',
      sessionId: SESSION_ID,
      turnId: 'pi-turn-1__m2',
      text: 'demoted main',
    } as AgentEvent)

    const m0 = state.session.messages.find((m: any) => m.turnId === 'pi-turn-0__m9')
    const m2 = state.session.messages.find((m: any) => m.turnId === 'pi-turn-1__m2')
    const m4 = state.session.messages.find((m: any) => m.turnId === 'pi-turn-1__m4')
    expect(m0?.isIntermediate).toBe(false)
    expect(m2?.isIntermediate).toBe(false)
    expect(m4?.isIntermediate).toBe(false)
  })
})
