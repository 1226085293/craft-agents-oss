import type { Message } from '../../shared/types'

/**
 * Is a tool still in flight?
 *
 * A tool message with a non-terminal status (pending / executing) means the
 * agent is legitimately busy and will emit events when the tool completes.
 * Long-running tools (e.g. `sleep 240`, installers) produce no events for
 * potentially minutes, so the stale-session watchdog must NOT treat such a
 * session as stuck — refreshing it mid-tool would clobber transient UI state
 * (queued bubbles, optimistic timestamps).
 *
 * Terminal statuses (from ToolStatus): completed / error / backgrounded.
 */
export function hasRunningTool(messages: Message[] | undefined): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some(m =>
    m.role === 'tool' && (m.toolStatus === 'executing' || m.toolStatus === 'pending')
  )
}

/**
 * How close a fetched user message must sit to a local queued message (ms).
 * Mirrors the content+timestamp fallback used by handleUserMessage so the
 * optimistic queued bubble can be re-identified after a server snapshot.
 */
const QUEUE_MATCH_TIMESTAMP_TOLERANCE_MS = 5_000

/**
 * Re-apply optimistic renderer-only flags (isQueued) to a freshly-fetched
 * message list.
 *
 * When the renderer replaces a session's messages from a server snapshot
 * (stale-recovery refresh, reconnect), the server-side copy of a queued user
 * message carries `isQueued: false` / no flag — `isQueued` is renderer-only
 * and never persisted. Without this, a queued bubble would silently lose its
 * "排队中" badge and fall back to a plain sent message (with the queue-time
 * timestamp), which also makes groupMessagesByTurn sort it INTO the middle of
 * the running turn's process blocks instead of deferring it to the end.
 *
 * Matching: by id, else content + timestamp within 5s (same fallback heuristic
 * as handleUserMessage). The optimistic id is preserved so the bubble identity
 * (getTurnKey keys user bubbles by id) survives the replacement and the queued
 * chip doesn't remount mid-flight.
 */
export function preserveQueuedFlags(
  freshMessages: Message[],
  prevMessages: Message[] | undefined,
): Message[] {
  if (!prevMessages || prevMessages.length === 0) return freshMessages

  const queuedByContent = new Map<string, Message>()
  for (const m of prevMessages) {
    if (m.role === 'user' && m.isQueued) {
      queuedByContent.set(m.content, m)
    }
  }
  if (queuedByContent.size === 0) return freshMessages

  return freshMessages.map(fresh => {
    if (fresh.role !== 'user') return fresh

    // Prefer an exact id match; then fall back to content match.
    const prev = queuedByContent.get(fresh.id)
      ?? queuedByContent.get(fresh.content)
    if (!prev) return fresh

    if (Math.abs(prev.timestamp - fresh.timestamp) > QUEUE_MATCH_TIMESTAMP_TOLERANCE_MS) {
      return fresh
    }

    // Re-attach the queued flag and keep the optimistic id so the bubble
    // identity / queued chip survive the replacement.
    return {
      ...fresh,
      id: prev.id,
      isQueued: true,
    }
  })
}