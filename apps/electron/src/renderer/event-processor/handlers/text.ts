/**
 * Text Event Handlers
 *
 * Handles text_delta and text_complete events.
 * Pure functions that return new state - no side effects.
 */

import type { SessionState, StreamingState, TextDeltaEvent, TextCompleteEvent, TextDemoteEvent, TextPromoteEvent, TextDiscardEvent } from '../types'
import type { Message } from '../../../shared/types'
import {
  findStreamingMessage,
  findAssistantMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/** Discard only the failed attempt's unfinished text, never completed history. */
export function handleTextDiscard(state: SessionState, event: TextDiscardEvent): SessionState {
  return {
    session: {
      ...state.session,
      messages: state.session.messages.filter(m => !(
        m.role === 'assistant' && m.turnId === event.turnId && (m.isStreaming || m.isPending)
      )),
    },
    streaming: state.streaming?.turnId === event.turnId ? null : state.streaming,
  }
}

/**
 * Handle text_demote - fold an already-emitted final reply into the
 * process block (2026-10-02 verification flow). The verified replay (or
 * the follow-up continuation) becomes the turn's single final bubble, so
 * the draft must not survive as a second, identical reply card.
 */
export function handleTextDemote(state: SessionState, event: TextDemoteEvent): SessionState {
  let index = -1
  for (let i = state.session.messages.length - 1; i >= 0; i--) {
    const m = state.session.messages[i]
    if (m.role === 'assistant' && m.turnId === event.turnId && m.isIntermediate !== true) {
      index = i
      break
    }
  }
  if (index === -1) return state
  const messages = state.session.messages.map((m, i) =>
    i === index ? { ...m, isIntermediate: true } : m
  )
  return {
    session: { ...state.session, messages },
    streaming: state.streaming?.turnId === event.turnId ? null : state.streaming,
  }
}

/**
 * Handle text_promote - re-promote a demoted main reply back to a result
 * bubble (2026-10-07 wise-horizon / slim-badger, in-app live counterpart of
 * the SessionManager persistence flip).
 *
 * When a mid-turn user steer was queued, the MAIN reply completed as a
 * process-card line (text_complete with isIntermediate under the
 * queued-follow-up hold). The drain's terminal stop releases the hold and
 * the main process emits text_promote (turnId + text of the demoted reply)
 * AND flips the persisted record. Without this handler the live display
 * keeps the demoted line in the process card, so the user sees only the
 * drain's answer as a result bubble until a reload. Flipping it back here
 * makes the live view agree with the persisted one: two result bubbles
 * (the original answer + the steer's answer).
 */
export function handleTextPromote(state: SessionState, event: TextPromoteEvent): SessionState {
  let index = -1
  for (let i = state.session.messages.length - 1; i >= 0; i--) {
    const m = state.session.messages[i]
    if (m.role === 'assistant' && m.turnId === event.turnId && m.isIntermediate === true) {
      index = i
      break
    }
  }
  // No matching demoted record (duplicate/late event, or the reply was
  // never demoted live) - no-op, keep state reference unchanged.
  if (index === -1) return state
  const messages = state.session.messages.map((m, i) =>
    i === index ? { ...m, isIntermediate: false } : m
  )
  return {
    session: { ...state.session, messages },
    streaming: state.streaming,
  }
}

/**
 * Handle text_delta - accumulate streaming content
 *
 * Creates a new streaming message if none exists, otherwise updates existing.
 * Uses turnId for lookup, never position.
 */
export function handleTextDelta(
  state: SessionState,
  event: TextDeltaEvent
): SessionState {
  // Output may have been batched before a retry began. Only an explicit retry
  // lifecycle event can clear the backoff indicator.
  const { session, streaming } = state

  // Accumulate in streaming state
  const newStreaming: StreamingState = streaming
    ? {
        ...streaming,
        content: streaming.content + event.delta,
        turnId: event.turnId ?? streaming.turnId
      }
    : {
        content: event.delta,
        turnId: event.turnId
      }

  // Find existing streaming message by turnId
  const streamingIndex = findStreamingMessage(session.messages, event.turnId)

  if (streamingIndex !== -1) {
    // Message exists - update its content
    const currentMsg = session.messages[streamingIndex]
    const updatedSession = updateMessageAt(session, streamingIndex, {
      content: currentMsg.content + event.delta,
    })
    return { session: updatedSession, streaming: newStreaming }
  }

  // No streaming message found - create new one
  // Don't update lastMessageAt for streaming messages (they're intermediate)
  const newMessage: Message = {
    id: generateMessageId(),
    role: 'assistant',
    content: event.delta,
    timestamp: Date.now(),
    isStreaming: true,
    isPending: true,
    turnId: event.turnId,
  }

  return {
    session: appendMessage(session, newMessage, false),
    streaming: newStreaming,
  }
}

/**
 * Handle text_complete - finalize the streaming message
 *
 * Sets isStreaming: false, isPending: false.
 * If message not found, CREATES it (fixes race condition bug).
 * Uses complete text from SDK (event.text), not accumulated content.
 */
export function handleTextComplete(
  state: SessionState,
  event: TextCompleteEvent
): SessionState {
  const { session, streaming } = state

  // Find message by turnId (try streaming first, then any assistant)
  let msgIndex = findStreamingMessage(session.messages, event.turnId)
  if (msgIndex === -1) {
    msgIndex = findAssistantMessage(session.messages, event.turnId)
  }

  if (msgIndex !== -1) {
    const existingMsg = session.messages[msgIndex]

    // Don't overwrite a completed intermediate message with another intermediate —
    // each thinking block (e.g. Codex reasoning between tool calls) should be distinct
    if (!existingMsg.isStreaming && existingMsg.isIntermediate && event.isIntermediate) {
      msgIndex = -1
    }
  }

  if (msgIndex !== -1) {
    // Update existing message with final content
    // Only update lastMessageAt for final (non-intermediate) messages
    const shouldUpdateTimestamp = !event.isIntermediate
    const existingMsg = session.messages[msgIndex]
    // Fallback chain: SDK event text → accumulated streaming content → existing message content.
    // Guards against SDK quirks or race conditions where event.text arrives empty.
    const resolvedContent = event.text || streaming?.content || existingMsg?.content || ''
    const updatedSession = updateMessageAt(session, msgIndex, {
      // Replace temporary renderer-generated ID with authoritative main-process ID
      // so branchFromMessageId always resolves against persisted session.jsonl.
      ...(event.messageId ? { id: event.messageId } : {}),
      content: resolvedContent,
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      // Overwrite text_delta's Date.now() with main process monotonic timestamp
      // This ensures reload order matches live order
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      // Streaming start time (first text_delta) — the process card orders rows
      // by when each block first became visible
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    }, shouldUpdateTimestamp)
    return { session: updatedSession, streaming: null }
  }

  // Message not found - CREATE IT
  // This handles the race condition where text_complete arrives
  // before text_delta's setSessions has been processed
  const newMessage: Message = {
    id: event.messageId ?? generateMessageId(),
    role: 'assistant',
    content: event.text || streaming?.content || '',
    timestamp: event.timestamp ?? Date.now(),
    startedAt: event.startedAt,
    isStreaming: false,
    isPending: false,
    isIntermediate: event.isIntermediate,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  // Only update lastMessageAt for final (non-intermediate) messages
  const shouldUpdateTimestamp = !event.isIntermediate

  return {
    session: appendMessage(session, newMessage, shouldUpdateTimestamp),
    streaming: null,
  }
}
