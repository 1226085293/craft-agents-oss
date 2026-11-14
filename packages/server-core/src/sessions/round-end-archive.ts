/**
 * When a finished round may take its worker session with it.
 *
 * A round ends inside `report_result`, which is a tool call of the turn that reported the hand-off.
 * The worker is therefore *always* mid-turn at the moment the round closes. The old rule refused to
 * archive in that case and simply dropped the request, so no round ever archived its worker: one live
 * task accumulated one session per round (broad-swan, lucid-beach) while its record said every round
 * was closed.
 *
 * The decision is split out here because the three states are easy to confuse and the cost of getting
 * them wrong is silent — a session that nobody reuses but nobody cleans up either.
 */

/** What the round-end hook was told to do with the session that ran the round. */
export type RoundEndArchive = 'archive' | 'defer' | 'skip'

export interface RoundEndWorker {
  /** Absent means "never archived" — the field is only ever set to `true`. */
  isArchived?: boolean
  isProcessing: boolean
}

/**
 * `archive` — idle already: archive now.
 * `defer`   — mid-turn (the normal case): park it and archive when the turn ends.
 * `skip`    — already archived, or the session is gone: nothing to do.
 */
export function decideRoundEndArchive(worker: RoundEndWorker | undefined): RoundEndArchive {
  if (!worker) return 'skip'
  if (worker.isArchived === true) return 'skip'
  return worker.isProcessing ? 'defer' : 'archive'
}

/**
 * Whether a parked request may be spent now.
 *
 * The turn that reported the hand-off ends first; a *later* turn (a queued message, a watchdog nudge)
 * must not keep the session alive forever, but it must also not be torn down under itself. So the
 * request is spent only once the session is idle, and it stays parked while it is busy.
 */
export function canSpendParkedArchive(worker: RoundEndWorker | undefined, parked: boolean): boolean {
  if (!parked || !worker) return false
  return worker.isArchived !== true && !worker.isProcessing
}
