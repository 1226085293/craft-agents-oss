/**
 * Message Operation Helpers
 *
 * Pure utility functions for finding and updating messages.
 * All lookups are by ID (turnId, toolUseId) - NEVER by position.
 */

import type { Message, Session } from '../../shared/types'
import type { RetryLadderRow } from '@craft-agent/core'
import { settleRetryRowAsFailed, findActiveRetryRowIndex, findLastRetryRowIndex, findLastRetryRowByStartedAt, findRetryRowForLadder } from '@craft-agent/shared/retry/retry-row'

let messageIdCounter = 0

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`
}

/**
 * Find message index by turnId
 * Returns -1 if not found
 */
export function findMessageByTurnId(
  messages: Message[],
  turnId: string | undefined,
  role?: 'assistant' | 'tool'
): number {
  if (!turnId) return -1
  return messages.findIndex(m =>
    m.turnId === turnId && (!role || m.role === role)
  )
}

/**
 * Find streaming assistant message by turnId
 * Falls back to last streaming assistant if no turnId
 */
export function findStreamingMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId && m.isStreaming
    )
    if (index !== -1) return index
  }
  // Fallback: find last streaming assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * Find assistant message by turnId (streaming or not)
 */
export function findAssistantMessage(
  messages: Message[],
  turnId?: string
): number {
  if (turnId) {
    const index = messages.findIndex(m =>
      m.role === 'assistant' && m.turnId === turnId
    )
    if (index !== -1) return index
  }
  // Fallback: find last streaming assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].isStreaming) {
      return i
    }
  }
  return -1
}

/**
 * Find tool message by toolUseId
 */
export function findToolMessage(
  messages: Message[],
  toolUseId: string
): number {
  return messages.findIndex(m => m.toolUseId === toolUseId)
}

/**
 * Update message at index, returning new session
 * Always creates new references (immutable update)
 * @param updateTimestamp - If true, also update lastMessageAt
 */
export function updateMessageAt(
  session: Session,
  index: number,
  updates: Partial<Message>,
  updateTimestamp = false
): Session {
  if (index < 0 || index >= session.messages.length) {
    return session
  }
  const messages = [...session.messages]
  messages[index] = { ...messages[index], ...updates }
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Append message to session, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function appendMessage(
  session: Session,
  message: Message,
  updateTimestamp = false
): Session {
  // Guard: skip if message with same ID already exists (prevents duplicate events on Windows)
  if (message.id && session.messages.some(m => m.id === message.id)) {
    return session
  }

  // Determine if this message role should update lastMessageRole (for badge display)
  const badgeRoles = ['user', 'assistant', 'plan', 'tool', 'error'] as const
  const roleForBadge = badgeRoles.includes(message.role as typeof badgeRoles[number])
    ? message.role as Session['lastMessageRole']
    : undefined

  return {
    ...session,
    messages: [...session.messages, message],
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
    ...(roleForBadge ? { lastMessageRole: roleForBadge } : {}),
  }
}

/**
 * Insert message at index, returning new session
 * @param updateTimestamp - If false, don't update lastMessageAt (for intermediate/tool messages)
 */
export function insertMessageAt(
  session: Session,
  index: number,
  message: Message,
  updateTimestamp = false
): Session {
  const messages = [...session.messages]
  messages.splice(index, 0, message)
  return {
    ...session,
    messages,
    ...(updateTimestamp ? { lastMessageAt: Date.now() } : {}),
  }
}

/**
 * Upsert the PERSISTED retry-ladder row (role 'status', statusType 'retrying')
 * with a new payload — created on the first backoff, updated in place on
 * backoff/active/end. The row lives in session.messages so it survives
 * session switches and app restarts (mirrors the session manager's own copy).
 */
export function upsertRetryRow(session: Session, payload: RetryLadderRow): Session {
  // Only the row of the CURRENT turn may be updated in place — a row left
  // behind by a previous settled turn must not be recycled (new turn, new
  // ladder, new row). Exception (2026-10-09): a TERMINAL payload (retry end
  // recovered/failed) arriving after a turn boundary (interrupted turn
  // followed by a new user message) must settle the dangling row, or it will
  // keep spinning "重试中" forever — a row still in `retrying` is the
  // un-settled ladder by construction, so the unbound scan cannot touch a
  // settled row of a newer ladder.
  let idx = findActiveRetryRowIndex(session.messages)
  if (idx === -1 && payload.status !== 'retrying') {
    const lastIdx = findLastRetryRowIndex(session.messages)
    if (lastIdx !== -1 && session.messages[lastIdx]!.retry?.status === 'retrying') {
      idx = lastIdx
    } else {
      // 2026-10-10: a soft `end` already settled the row — the terminal `end`
      // (same ladder, same startedAt) must re-settle it IN PLACE, not stack
      // a second row. (Mirrors the server's case 'retry' fallback exactly.)
      idx = findLastRetryRowByStartedAt(session.messages, payload.startedAt)
    }
  }
  // 2026-10-10 (apt-lion): a backoff/active of the SAME ladder that follows
  // a soft-settled "recovered" row revives that one row instead of stacking a
  // new line — one ladder, one row, until its terminal end.
  if (idx === -1 && payload.status === 'retrying') {
    idx = findRetryRowForLadder(session.messages, payload.startedAt)
  }
  if (idx !== -1) {
    return {
      ...session,
      messages: session.messages.map((m, i) => (i === idx ? { ...m, retry: payload } : m)),
    }
  }
  return appendMessage(session, {
    id: generateMessageId(),
    role: 'status',
    statusType: 'retrying',
    content: '',
    timestamp: payload.startedAt,
    retry: payload,
  } as Message)
}

/**
 * Fail-safe for the persisted retry row: a ladder that ended WITHOUT its
 * terminal `retry end` event (subprocess exit, guardrail stop, unexpected
 * generator failure, stale restored rung) must not leave a spinning
 * "重试中 · 第 x 次" line in the process block. Settle it to 'failed' — the
 * retries did not recover. No-op when the row is absent or already terminal.
 */
export function settleStuckRetryRow(session: Session, now = Date.now()): Session {
  // 2026-10-10: while a retry ladder is STILL retrying (backoff/active
  // received, no terminal end yet), the row must not be settled — a
  // "重试 1 次后失败 · 00:00" popping up beside "第 N 次重试中" was exactly
  // this fail-safe firing mid-ladder. Success/failure only appear when the
  // retry has REALLY finished (the end event flips retryLadderActive off).
  if (session.retryLadderActive) return session
  // 2026-10-09: scan TURN-UNBOUND — a retry row left dangling by an
  // interrupted turn (user stop / new message while the retried run was in
  // flight) still shows status 'retrying' AFTER the next user message, which
  // the turn-scoped findActiveRetryRowIndex never reaches. findLastRetryRowIndex
  // also requires the nested status to be 'retrying', so settled rows
  // (recovered/failed) are never re-settled.
  const idx = findLastRetryRowIndex(session.messages)
  if (idx === -1) return session
  const row = session.messages[idx]!
  if (row.retry?.status !== 'retrying') return session
  return {
    ...session,
    messages: session.messages.map((m, i) =>
      i === idx ? { ...m, retry: settleRetryRowAsFailed(row.retry, now) } : m
    ),
  }
}

/**
 * Drop a pending "Compacting context..." status row when the turn fails.
 * The error card itself carries the failure, so a still-spinning compacting
 * row would wrongly suggest compaction is in flight. Status rows are
 * transient (not persisted), so removing them is safe.
 */
export function dropCompactingStatus(session: Session): Session {
  const hasCompacting = session.messages.some(m => m.role === 'status' && m.statusType === 'compacting')
  const isCompacting = session.currentStatus?.statusType === 'compacting'
  if (!hasCompacting && !isCompacting) return session
  return {
    ...session,
    messages: hasCompacting
      ? session.messages.filter(m => !(m.role === 'status' && m.statusType === 'compacting'))
      : session.messages,
    ...(isCompacting ? { currentStatus: undefined } : {}),
  }
}

/** Create an empty session for a given ID. */
export function createEmptySession(sessionId: string, workspaceId: string, workspaceName: string = ''): Session {
  return {
    id: sessionId,
    workspaceId,
    workspaceName,
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: true,
  }
}
