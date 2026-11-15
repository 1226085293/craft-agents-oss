/**
 * What a finished round leaves behind.
 *
 * A round is a task's whole life, run once: it plans, it works, it delivers, and then it is over. For
 * a repeating task the next round starts from the same instruction — not from this round's leftovers.
 * That rule is what the first live per-minute task broke: its plan grew a section per round, its
 * worker sessions piled up one per round, and its acceptance counter carried across rounds until the
 * fourth one tripped 「验收轮数耗尽」 on work that had never been judged in that round.
 *
 * So the reset is explicit rather than "whatever we forgot to delete". Three buckets:
 *
 *   kept    — the task itself, and what the next round must continue from: how many times it has run,
 *             and the last round's result (`stats.lastRound`).
 *   cleared — everything that described *this* round: its plan, its hand-off timeline, its sessions.
 *   untouched — state whose lifetime is deliberately longer than a round: the failure fuse
 *             (`consecutiveFailures`), the counters, and any question still owed an answer.
 *
 * Kept pure and separate from `TaskService` because the cost of getting one entry wrong here is
 * silent: a field cleared that should survive loses the person's data, and a field kept that should
 * be cleared corrupts the next round's judgement.
 */

import type { Task } from './types.ts';

export interface RoundResetOptions {
  now: number;
  /** Sessions this round used — already archived by the caller, removed from the round list. */
  roundSessionIds?: string[];
  /** The plan the round finished; recorded in the journal by the caller, cleared on the record. */
  clearPlan?: boolean;
}

export interface RoundResetResult {
  task: Task;
  /** Sessions that were in the round list, for the caller to archive before this snapshot is used. */
  archivedSessionIds: string[];
}

/**
 * The stats a round leaves alone on purpose.
 *
 * `runs`, `rounds` and `lastRound` are the record's memory of having done this before — the only
 * three things the person asked to keep. `consecutiveFailures` is the fuse: it spans rounds by
 * definition, and resetting it every round would make a task that fails every time run forever.
 */
function keepLifetimeStats(stats: Task['stats']): NonNullable<Task['stats']> {
  /**
   * Rebuilt from a whitelist, not filtered from the old object.
   *
   * A `delete`-based reset silently keeps every field added later — which is how `runs`-style
   * left-overs accumulate. Naming what survives means a new field is cleared by default, which is
   * the safe direction: an over-cleared counter is visible, an over-kept one is not.
   */
  return {
    runs: stats?.runs ?? 0,
    activeMs: stats?.activeMs ?? 0,
    rounds: stats?.rounds ?? { ok: 0, failed: 0 },
    ...(stats?.lastRound ? { lastRound: stats.lastRound } : {}),
    ...(stats?.lastTriggeredAt ? { lastTriggeredAt: stats.lastTriggeredAt } : {}),
    ...(stats?.pendingTriggers?.length ? { pendingTriggers: stats.pendingTriggers } : {}),
    ...(stats?.triggersDeliveredAt ? { triggersDeliveredAt: stats.triggersDeliveredAt } : {}),
    ...(stats?.wakeFailures ? { wakeFailures: stats.wakeFailures } : {}),
    ...(stats?.announcedPauseAt ? { announcedPauseAt: stats.announcedPauseAt } : {}),
  };
}

/**
 * Reset the record for the next round.
 *
 * Deliberately does not touch `decisions`: an unanswered question means the round is not finished,
 * and the caller never closes a round that still has one. Doing it here as well would be a second
 * place to get that rule wrong.
 */
export function resetRoundState(task: Task, options: RoundResetOptions): RoundResetResult {
  const { now } = options;
  const stats = task.stats ?? { runs: 0, activeMs: 0 };
  /**
   * The list to archive: the round's, or — for a record written before the field existed — the one
   * session that was holding it. An empty list is not 「nothing to archive」 on such a record, it is
   * 「this round predates the list」, so the fallback covers both.
   */
  /**
   * The last accepted report, read before the timeline is cleared.
   *
   * Only an accepted one counts: a refused hand-off is an attempt, not a report, and the worker
   * still owes one.
   */
  const lastHandoff = [...(task.handoffs ?? [])].reverse().find((handoff) => handoff.passed !== false)
  const roundList = options.roundSessionIds ?? task.roundSessionIds ?? [];
  const archivedSessionIds = roundList.length
    ? roundList
    : task.currentWorkerSessionId
      ? [task.currentWorkerSessionId]
      : [];

  const next: Task = {
    ...task,
    // The round's executor is gone: archiving it and clearing this is what makes the next dispatch
    // open a fresh conversation instead of continuing this one.
    currentWorkerSessionId: undefined,
    // The round's holder goes with the round: the next one starts by claiming a run, which writes
    // both fields again. Leaving it would name a session that no longer holds anything.
    currentStageSessionId: undefined,
    roundSessionIds: [],
    // The hand-off timeline is the round's, and `stats.lastRound.summary` already carries the one
    // sentence the next round reads. The full history is in the journal, which is append-only.
    handoffs: [],
    ...(options.clearPlan && task.spec ? { spec: { ...task.spec, plan: [] } } : {}),
    stats: {
      ...keepLifetimeStats(stats),
      /**
       * The round's timeline goes, the fact that it reported stays.
       *
       * `handoffs` is cleared below because the next round must not inherit this round's attempts.
       * But the watchdog asks 「did this run file?」 through it, so clearing it silently made every
       * closed round look unreported until the next hand-off arrived. Live: T-1 closed round 5 and
       * the supervisor was told 「T-1 的执行者已停止但没交作业」 about the session that had just
       * reported it.
       */
      ...(lastHandoff ? { lastHandoffAt: lastHandoff.at, lastHandoffSessionId: lastHandoff.fromSessionId } : {}),
      // Wake bookkeeping is 「how many times this round had to be nudged」, not a lifetime tally.
      wakeAttempts: undefined,
      lastWakeAt: undefined,
      lostRetries: undefined,
      // A stale 「上次触发时间」 reads as 「this round started then」 and skews the watchdog's staleness.
      runStartedAt: undefined,
      lockSessionId: undefined,
      lockDeadlineAt: undefined,
      lastHeartbeatAt: undefined,
    },
    /**
     * The acceptance counter is not reset here.
     *
     * It used to be, on the reading that 「round 2 was never judged, so it should not start at the
     * cap」. That is true of a *recurring* task, where each round is a new piece of work. It is
     * wrong for the thing `closeRound` is also used for: a one-off task that delivered, was judged
     * and failed, and is being handed back to try again. Clearing the counter there threw away the
     * only record of how many times the same finished plan had been judged, so `maxIterations`
     * could never be reached.
     *
     * Measured on T-1: twelve verification sessions, `verifyRounds` never above 2, and the cap of 3
     * never fired — because every `delivered` hand-off ran a reset that zeroed it. Four of those
     * twelve re-checked the same claim.
     *
     * The caller that genuinely wants a fresh budget says so: `setAcceptance` resets it when the
     * requirement itself changes, which is the one case where the previous judgements were about a
     * different question.
     */
    updatedAt: now,
  };

  /**
   * The last verdict is the previous round's opinion of the previous round's work.
   *
   * Left in place it reads as 「this round already passed」 on a round nobody has judged yet — and the
   * panel prints it as 验收：通过.
   */
  if (task.verify) {
    const { lastVerdict: _verdict, lastVerifiedRevision: _revision, ...verifyRest } = task.verify;
    next.verify = verifyRest;
  }

  /**
   * The previous round's pause reason is not this round's.
   *
   * `lastError` / `lastPausedAt` describe why a *round* stopped; carrying them means a round that
   * starts clean still shows the last one's failure, and `deriveGateReason` reads it back as current.
   */
  if (task.lifecycle) {
    const { lastError: _error, lastPausedAt: _pausedAt, ...lifecycleRest } = task.lifecycle;
    next.lifecycle = lifecycleRest;
  }

  return { task: next, archivedSessionIds };
}
