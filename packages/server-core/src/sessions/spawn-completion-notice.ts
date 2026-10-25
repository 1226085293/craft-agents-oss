/**
 * Hand-back notice for a spawned sub-session's finished turn.
 *
 * `spawn_session` is fire-and-forget: the parent's tool call returns
 * `{status:'started'}`, its turn ends, and a child that finishes minutes later
 * had no way to reach the conversation that asked for it. That is what happened
 * in 2026-10-25 `261025-dynamic-crow`: the parent answered "结果出来后我会汇总
 * 给你", ended its turn at 07:23:13, and the child's answer landed at 07:25:17
 * in a session nobody opened. The Tasks Conductor always reported its own
 * children back; this is the same for ad-hoc spawns.
 *
 * Kept pure (no SessionManager imports) so the guard rules and the wording are
 * unit-testable without building a manager.
 */

export interface SpawnedChildSummary {
  id: string
  name?: string
  /** Set on `spawn_session` children; the session that is waiting for the result. */
  parentSessionId?: string
  /** Set on Conductor-owned children — the runner already sequences those. */
  taskRunId?: string
  /** Generate-time draft orchestrator: not an adopted subtask yet. */
  taskDraft?: boolean
  hidden?: boolean
}

export type SpawnedTurnStopReason = 'complete' | 'interrupted' | 'error' | 'timeout'

/** How much of the child's answer is repeated in the notice. */
export const SPAWN_NOTICE_MAX_CHARS = 4000

/**
 * Whether this child's turn should be reported to its parent at all.
 *
 * Three exclusions matter:
 *  - Conductor children (`taskRunId`): TaskRunner reads the session-completion
 *    seam itself and drives the node to done/failed. A second notice would tell
 *    the orchestrator to summarize a node it is still scheduling.
 *  - Draft orchestrators (`taskDraft`): hidden until adopted; nothing waits.
 *  - Hidden sessions: internal helper runs, not delegations a user is waiting on.
 */
export function shouldNotifyParent(
  child: SpawnedChildSummary | null | undefined,
  parentExists: boolean,
): boolean {
  if (!child) return false
  if (!child.parentSessionId) return false
  if (!parentExists) return false
  if (child.taskRunId) return false
  if (child.taskDraft || child.hidden) return false
  return true
}

function clauseFor(reason: SpawnedTurnStopReason): string {
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

function instructionFor(reason: SpawnedTurnStopReason): string {
  return reason === 'complete'
    ? 'Present this result to the user now, or continue the work the sub-session was delegated as part of. Do not spawn a duplicate sub-session for the same task.'
    : 'Tell the user it did not finish successfully, and decide whether to retry or continue without it. Do not retry silently.'
}

/**
 * Build the hidden message injected into the parent session.
 *
 * Mirrors the background-task-completion nudge: a tag the model can recognise,
 * the child's verbatim answer, then one line about what to do next. Long answers
 * are truncated (the parent can still ask the child, or read its session) so one
 * verbose child cannot flood the parent's context.
 */
export function buildSpawnCompletionNotice(
  child: SpawnedChildSummary,
  reason: SpawnedTurnStopReason,
  finalText: string | undefined,
): string {
  const label = child.name ? `"${child.name}"` : 'sub-session'
  const raw = (finalText ?? '').trim()
  const body = raw
    ? raw.length > SPAWN_NOTICE_MAX_CHARS
      ? `${raw.slice(0, SPAWN_NOTICE_MAX_CHARS)}\n… (truncated — the full text is in sub-session ${child.id})`
      : raw
    : '(the sub-session produced no text output)'

  return [
    `[subtask-${reason}] The sub-session you spawned (${label}, ${child.id}) ${clauseFor(reason)}:`,
    '',
    body,
    '',
    instructionFor(reason),
  ].join('\n')
}
