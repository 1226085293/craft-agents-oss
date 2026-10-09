/**
 * Thinking Event Handlers
 *
 * Handles thinking_delta and thinking_complete (2026-10-09 d4f "invisible
 * process" fix). Reasoning channels (deepseek-v4-flash etc.) stream nearly all
 * their narrative as thinking blocks; without these the UI stayed blank for the
 * whole (often multi-minute) stream.
 *
 * Implementation note: thinking deltas REUSE the text streaming machinery —
 * each thinking step carries its own turnId (adapter 't' sub-turn ids), so
 * `handleTextDelta` creates/updates a DISTINCT pending assistant message per
 * thinking block. turn-utils already renders pending/intermediate assistant
 * messages as process-card steps, so a live reasoning row appears while the
 * model works, and `handleTextComplete` (isIntermediate: true) finalizes it.
 * The only differences from answer text: the terminal event is
 * thinking_complete (not text_complete) and the row is ALWAYS intermediate.
 */

import type { SessionState, ThinkingDeltaEvent, ThinkingCompleteEvent } from '../types'
import { handleTextDelta, handleTextComplete } from './text'

/** Accumulate a live thinking step (same streaming message machinery as text). */
export function handleThinkingDelta(
  state: SessionState,
  event: ThinkingDeltaEvent
): SessionState {
  return handleTextDelta(state, {
    type: 'text_delta',
    sessionId: event.sessionId,
    delta: event.delta,
    turnId: event.turnId,
  })
}

/**
 * Finalize a thinking step — always intermediate (a process row, never a
 * result bubble). Carries the FULL reasoning text for the live view.
 */
export function handleThinkingComplete(
  state: SessionState,
  event: ThinkingCompleteEvent
): SessionState {
  return handleTextComplete(state, {
    type: 'text_complete',
    sessionId: event.sessionId,
    text: event.text,
    turnId: event.turnId,
    isIntermediate: true,
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    ...(event.messageId ? { messageId: event.messageId } : {}),
  })
}