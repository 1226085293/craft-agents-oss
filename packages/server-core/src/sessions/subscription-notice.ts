/**
 * Wake notice for a session that SUBSCRIBED to another session's turns.
 *
 * Replaces the old parent-child-only "spawn completion" notice: any session may
 * subscribe to any other session in the same workspace, and every finished turn
 * is pushed to the subscribers as a hidden message. Unlike a quiet inbox this
 * deliberately wakes the subscriber — that is the point of subscribing — so a
 * busy subscriber receives it as a queued message (never a mid-turn steer).
 *
 * Kept pure (no SessionManager imports) so the wording is unit-testable without
 * building a manager.
 */

export interface SubscribedSessionSummary {
  id: string
  name?: string
}

export type SubscribedTurnStopReason = 'complete' | 'interrupted' | 'error' | 'timeout'

/** How much of the target's answer is repeated in the notice. */
export const SUBSCRIPTION_NOTICE_MAX_CHARS = 4000

function clauseFor(reason: SubscribedTurnStopReason): string {
  switch (reason) {
    case 'complete':
      return 'has finished'
    case 'interrupted':
      return 'was interrupted'
    case 'timeout':
      return 'timed out'
    case 'error':
    default:
      return 'failed'
  }
}

function instructionFor(reason: SubscribedTurnStopReason): string {
  return reason === 'complete'
    ? 'Handle this result as part of the work you are doing with that session. Do not spawn a duplicate session for the same task. If that session\'s task is now complete and you have no further follow-up to send it, call unsubscribe_session to stop following it.'
    : 'Tell the user it did not finish successfully, and decide whether to retry or continue without it. Do not retry silently.'
}

/**
 * Build the hidden message injected into every subscriber.
 *
 * Carries the target's verbatim final answer (truncated) plus its session id, so
 * the subscriber usually does not need to read the transcript. Long answers are
 * truncated; the full text stays in `sessions/{id}/session.jsonl`.
 */
export function buildSubscriptionNotice(
  target: SubscribedSessionSummary,
  reason: SubscribedTurnStopReason,
  finalText: string | undefined,
): string {
  const label = target.name ? `"${target.name}"` : 'session'
  const raw = (finalText ?? '').trim()
  const body = raw
    ? raw.length > SUBSCRIPTION_NOTICE_MAX_CHARS
      ? `${raw.slice(0, SUBSCRIPTION_NOTICE_MAX_CHARS)}\n… (truncated — the full text is in session ${target.id})`
      : raw
    : '(the session produced no text output)'

  return [
    `[session-turn-${reason}] The session you subscribed to (${label}, ${target.id}) ${clauseFor(reason)}:`,
    '',
    body,
    '',
    instructionFor(reason),
  ].join('\n')
}
