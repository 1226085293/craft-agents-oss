/**
 * Task watchdog — an external control loop, deliberately separate from the
 * supervisor.
 *
 * Two reasons it does not live inside a session:
 *  - a session that is itself stuck cannot check whether it is stuck;
 *  - the checks are pure rules, so they can run on a timer without spending a
 *    model call.
 *
 * What it looks at is progress, not liveness: a task whose process is alive but
 * which has stopped heartbeating, a task that keeps failing, and a task that has
 * outlived its budget. Model-level "drift" judgement is out of scope here — that
 * belongs to the acceptance gate, which reads the handoff.
 */

import { createLogger } from '@craft-agent/shared/utils';
import {
  isHeartbeatStalled,
  lastActivityOf,
  planProgress,
  processLostRetryDue,
  shouldTripFuse,
  type Task,
} from '@craft-agent/shared/tasks';

const log = createLogger('watchdog');

export type WatchdogFinding =
  | { kind: 'stalled'; task: Task }
  | { kind: 'failing'; task: Task }
  | { kind: 'overdue'; task: Task }
  | { kind: 'orphaned'; task: Task }
  | { kind: 'idle'; task: Task }
  | { kind: 'unreported'; task: Task }
  | { kind: 'resume_lost'; task: Task }
  /**
   * The provider is unreachable, so the task is parked until it comes back.
   *
   * Separate from `resume_lost`: a lost process has an obvious retry (the work is intact, the
   * process is not), while an unreachable provider has nothing to retry — the next request hits
   * the same wall. Only the probe deciding 「it answers again」 is evidence enough to move.
   */
  | {
    kind: 'upstream_wait'
    task: Task
    /**
     * The strategies this task's own sessions are on, deduplicated.
     *
     * Carried on the finding so the wake decision and the message name the same groups the check
     * used — recomputing them later would let the session set drift in between.
     */
    strategies: string[]
  }
  /** Paused with nobody told — the relay that owed the person a sentence died. */
  | { kind: 'unannounced_pause'; task: Task };

export interface WatchdogDeps {
  /** Tasks to inspect (already filtered to the workspace). */
  listTasks: () => Task[];
  /** True while the task's current session exists. */
  sessionExists: (sessionId: string) => boolean;
  /**
   * True while the session is actively working.
   *
   * Distinct from `sessionExists` on purpose: a session that ended its turn is
   * still an object in the session list, so "the session exists" answered yes for
   * a task that nobody was working on. That is the gap this closes — a task sat
   * on 进行中 with an idle session behind it and nothing ever looked.
   *
   * Returning `undefined` means unknown, treated as working: a host that cannot
   * answer must not cause the watchdog to fire.
   */
  sessionWorking?: (sessionId: string) => boolean | undefined;
  /**
   * True while the session is legitimately waiting rather than stalled.
   *
   * A worker that backgrounded a long command ends its turn on purpose: the shell
   * reports back through `shell_completed`, and waking the session in the meantime
   * would make it re-run or pre-empt work that is still going. Same for a session
   * waiting on an event subscription. This is the check that decides whether "idle"
   * means "stuck" or "waiting", and it is more honest than any particular minute
   * count.
   */
  sessionWaiting?: (sessionId: string) => boolean;
  /**
   * Nudge a session that should be doing something it is not.
   *
   * `reason` distinguishes "you stopped mid-work" from "you finished but never
   * filed": telling a worker with a complete plan to 「从上一次中断的地方继续」 gives
   * it an incentive to invent a step so it has something to report.
   *
   * Return whether the wake actually started. A run reported 「已唤醒它继续」 while the
   * subprocess answered `Cannot retry: no re-runnable model step` — the turn had ended
   * normally, so there was nothing to continue. The supervisor was told work had resumed
   * and nothing was working on the task. A claim about an action has to come from the
   * action's result, not from the intent to perform it; `false` or a rejected promise is
   * reported as a failure. `void` means the implementation cannot tell, and is treated as
   * "started" for compatibility.
   */
  /**
   * Which strategy groups this task's own sessions are pinned to.
   *
   * Per task, not global: a supervisor and its workers may each sit on a different group, and a
   * task can only resume when *its own* groups answer. A global answer would resume a task whose
   * worker is still pointed at a group that is down.
   */
  strategiesOf?: (task: Task, sessionIds: string[]) => string[]
  /** Whether one strategy group is servable right now — snapshot + one minimal request. */
  probeStrategy?: (strategyId: string) => Promise<boolean>
  wakeSession?: (
    task: Task,
    sessionId: string,
    reason: 'idle' | 'unreported' | 'pause',
  ) => void | boolean | Promise<boolean>;
  /**
   * Record that the person has been told this task paused.
   *
   * The guard against telling them twice: without it, a pause nobody acknowledges would be
   * announced on every pass.
   */
  markPauseAnnounced?: (id: string) => void;
  /** Pause a task with a reason. */
  /**
   * Park a task, declaring only what a record cannot later prove.
   *
   * `process_lost` is a fact: the process is gone, and once the lock is released the record no
   * longer carries the evidence. Everything else a pause could be labelled with — budget spent,
   * failures piled up, a dependency unfinished — is computable from the record, so the service
   * derives it and the caller passes `null`. Two writers of one label is how the board ended up
   * claiming things the record had stopped saying.
   */
  pause: (id: string, reason: 'process_lost' | null, note: string) => void;
  /**
   * Start a fresh run for a task whose executor was lost.
   *
   * A pause for `process_lost` is the one pause with an obvious recovery: the work did not fail,
   * the process did. The design says retry once and then ask a human, and until now nothing
   * retried at all — the task sat `paused / process_lost` until somebody noticed it on the board.
   *
   * Returns whether the run actually started; a claim about resuming has to come from the result.
   */
  resume?: (task: Task) => void | boolean | Promise<boolean>;
  /**
   * Tell the owning supervisor, in one line.
   *
   * `key` names the subject so duplicate notices collapse: a task that fails twice must not queue two
   * messages that ask the supervisor to do the same thing twice. The caller supplies it because it
   * knows which finding this is; reading it back out of the sentence would be guesswork.
   */
  notify: (supervisorSessionId: string, text: string, key: string) => void;
  /**
   * Apply the default answer to an unanswered decision request.
   *
   * Separate from `pause` because the task is already paused: what changes is
   * that the decision is now resolved as a refusal.
   */
  denyDecision?: (id: string, note: string) => void;
  /**
   * Whether a session is between turns.
   *
   * A message sent to a running session arrives as a steering interruption. For an executor that
   * is the point (it is going the wrong way and should change course); for a supervisor that is
   * being asked to write something, it cancels the writing. Absent means "cannot tell", which
   * behaves as idle so a caller that has not wired this keeps the old behaviour.
   */
  sessionIdle?: (sessionId: string) => boolean;
  now?: () => number;
}

/**
 * Consecutive handoffs that say the same thing = the worker is turning in
 * circles: still alive, still handing off, never progressing.
 *
 * Three is deliberate: one repeat is a retry, two is bad luck, three means the
 * task will not finish on its own and a human should look.
 */



/**
 * How long a session that has already filed may sit idle before the task counts as stuck.
 *
 * This window belongs to the supervisor: the executor did its job and reported, so the
 * next move is a dispatch, and dispatching takes thought. Five minutes is the supervisor's
 * budget, not evidence about the worker.
 */
export const IDLE_SESSION_MS = 5 * 60_000;

/**
 * How long a session that filed nothing may sit idle before it is asked for a hand-off.
 *
 * Much shorter than the idle window, because the two situations are not symmetric. A
 * worker that ended its turn without `report_result` owes something and nothing else is
 * going to happen — no dispatch is coming for a run that has not reported. The supervisor
 * needs no time here, and every minute spent waiting is a minute the user watches 进行中.
 *
 * It used to share the five-minute window, on the reasoning that a check cannot fire more
 * often than a pass runs. That stopped being true when `nextCheckDelayMs` began computing
 * the exact deadline and the loop began sleeping to it: latency is now the grace itself, so
 * the grace is the only thing to set. Ninety seconds is long enough for a session that is
 * genuinely scribbling a `report_result` call to finish it.
 */
export const UNREPORTED_GRACE_MS = 90_000;


/**
 * How long a pause may sit unannounced before the relay is woken again.
 *
 * Long enough that the wake which caused the pause has time to finish — a pause is written first
 * and the sentence second, and interrupting that gap would double every pause notification.
 */
export const UNANNOUNCED_PAUSE_GRACE_MS = 90_000;

/**
 * How long to wait when this run has already done something and then stopped.
 *
 * The ninety-second grace answers "did the worker even start?", and that question is
 * only open while the run has produced nothing. Once it has — a heartbeat, a plan
 * step, a tool result — a session that is no longer working is not mid-sentence, it
 * is finished. The old rule applied the spawn grace to both cases, so a worker that
 * ended its turn in twelve seconds was left alone for ninety: a real run sat idle
 * from 16:26 to 16:27:40 with nothing to wait for. Five seconds is one watchdog pass
 * of slack for the `isProcessing` flag to settle, not a deadline to be lived through.
 */
export const STOPPED_AFTER_WORK_GRACE_MS = 5_000;

/**
 * Wakes before the task is handed to a person.
 *
 * One wake is a correction: the worker ended its turn without finishing and may
 * simply have lost the thread. A second one means the nudge is not working, and a
 * third would be a loop paying for a model turn each time.
 */
export const MAX_IDLE_WAKES = 2;

/** The newest evidence that something in this task moved. */
/**
 * Did THIS execution run file a hand-off?
 *
 * Not "any hand-off ever": a task's second and third legs would look reported forever
 * because the first session's report is still in the record. The session id and the run
 * start are what make the question answerable.
 */
function hasFiledThisRun(task: Task): boolean {
  const runStartedAt = task.stats?.runStartedAt;
  /**
   * The stamp first, because `handoffs` empties when a round closes.
   *
   * A run that reported and then had its round closed is finished, not unreported: `round_reset`
   * clears the timeline (the next round must not inherit those attempts) and keeps
   * `lastHandoffAt`/`lastHandoffSessionId` for exactly this question. Without it, the watchdog read
   * every closed round as 「执行者已停止但没交作业」 and nudged a session that had already reported.
   * Live: T-1 closed round 5, claimed the next one, and the supervisor got that message about the
   * worker that had just handed off.
   */
  if (
    typeof task.stats?.lastHandoffAt === 'number' &&
    task.stats.lastHandoffSessionId === task.currentWorkerSessionId &&
    (!runStartedAt || task.stats.lastHandoffAt >= runStartedAt)
  ) {
    return true;
  }
  /**
   * A stamp from this run is a report, whoever is `currentWorkerSessionId` now.
   *
   * The check above is about 「the session I am looking at reported」, which is the right question
   * for a nudge addressed to that session. This one is about "is there anything to nudge at all" —
   * and when the stamp is newer than the run's own claim, the answer is no regardless of what
   * `currentWorkerSessionId` has been rewritten to. Live 2026-11-15 on T-2: the worker handed off at
   * 16:40:44 and `currentWorkerSessionId` had already moved to another session, so both checks above
   * missed and the same worker was re-woken with the same brief three times.
   */
  if (
    typeof task.stats?.lastHandoffAt === 'number' &&
    typeof runStartedAt === 'number' &&
    task.stats.lastHandoffAt >= runStartedAt
  ) {
    return true;
  }
  return task.handoffs.some(
    (handoff) =>
      handoff.outcome !== 'needs_decision' &&
      // An attempt the gate refused is not a report: the worker still owes one, and
      // treating it as filed is how a worker that gave up after a rejection went silent.
      handoff.passed !== false &&
      handoff.fromSessionId === task.currentWorkerSessionId &&
      (!runStartedAt || handoff.at >= runStartedAt),
  );
}

/**
 * Has THIS run produced anything at all?
 *
 * `runStartedAt` is written when the run is claimed; the heartbeat moves on every tool
 * result and turn boundary. So "last activity after the run began" is the difference
 * between a session that has never got going (still spawning, still reading its brief)
 * and one that has worked and stopped — two states that need different patience.
 */
function hasWorkedThisRun(task: Task): boolean {
  const startedAt = task.stats?.runStartedAt;
  if (typeof startedAt !== 'number') return true;
  return lastActivityOf(task) > startedAt;
}

/** How long a stopped session gets, given whether it ever started. */
function stoppedGrace(task: Task): number {
  return hasWorkedThisRun(task) ? STOPPED_AFTER_WORK_GRACE_MS : UNREPORTED_GRACE_MS;
}


/** Re-exported so the loop and the board cannot drift on how many retries 「一次」 is. */
/**
 * How often the shared probe asks whether a downed provider is back.
 *
 * One minute because it is the granularity a person perceives as 「it resumed by itself」 — quick
 * enough that a blip is invisible, slow enough that an hour-long outage costs 60 requests total
 * instead of one per attempt per task.
 */
export const UPSTREAM_PROBE_INTERVAL_MS = 60_000;

/**
 * Can this task start again, given what the probe found?
 *
 * Every strategy the task's own sessions are pinned to must answer. A task whose supervisor is on
 * one group and whose worker is on another is only resumable when both are back — resuming on one
 * of them just moves the 503 one hop further and parks the task again.
 *
 * Pure so the rule is testable without a gateway or a timer: the caller collects the task's
 * strategies, probes each, and hands the answers here.
 */
export function upstreamRecoveredFor(
  needed: readonly string[],
  answers: ReadonlyMap<string, boolean>,
): boolean {
  // No recorded strategy means nothing to wait on: the task was parked for a reason this probe
  // cannot evaluate, so it must not be resumed on this probe's authority.
  if (needed.length === 0) return false;
  return needed.every((strategyId) => answers.get(strategyId) === true);
}

export { MAX_PROCESS_LOST_RETRIES } from '@craft-agent/shared/tasks';

/**
 * How long a `process_lost` pause waits before the retry.
 *
 * Long enough that a process still coming up is not mistaken for a dead one, short enough that
 * "the app restarted" does not mean "the task waits for a human".
 */
export function processLostGraceMs(): number {
  return STOPPED_AFTER_WORK_GRACE_MS
}

/** Only tasks that claim to be running are worth inspecting. */
export function inspectTasks(deps: WatchdogDeps): WatchdogFinding[] {
  const now = (deps.now ?? Date.now)();
  const findings: WatchdogFinding[] = [];

  for (const task of deps.listTasks()) {
    /**
     * A task holding an unanswered question is not inspected at all.
     *
     * This used to sit in the middle of the running-state rules, which left two gaps. A task that
     * was `running` with an open question still ran the rules above it (`process_lost`,
     * `awaiting_release`), and a *paused* task never reached the check at all — it had already
     * `continue`d on `status !== 'running'`. Both gaps let the loop act on a task whose next move
     * belongs to a person: live 2026-11-15 T-2 accumulated eleven questions while the watchdog kept
     * reading the task as 「nobody working」.
     *
     * The rule is now the first thing the loop asks. A question that is open means the task is
     * waiting for an answer, and no rule in here can produce one — not a nudge, not a retry, not a
     * pause, and not a resume. Answering it is what puts the task back under inspection.
     */
    if ((task.decisions ?? []).some((entry) => !entry.resolvedAt)) continue

    /**
     * A task paused because its executor died is the one paused task with an obvious recovery.
     *
     * Everything below this line inspects `running` tasks, so a `process_lost` pause was never
     * looked at again: the work had not failed, the process had, and the task waited for a person
     * to notice it on the board. The design says retry once and then ask; this is the retry.
     *
     * The counter lives on the task, so "once" survives a restart — a watchdog that retried on
     * every boot would turn one lost process into an endless loop of fresh runs.
     */

    /**
     * A task parked on an unreachable provider is waiting for something no rule below can supply.
     *
     * Idle / unreported / off-track all read 「the session stopped」 and wake it — which, while the
     * provider is down, means one more request into the same 503. Live 2026-11-15: a 502 ended the
     * supervisor's turn mid-dispatch, the watchdog read the silence as 「stopped without filing」,
     * and the same brief was delivered three times. The task is reported as `upstream_wait` so the
     * probe owns the decision to resume, and nothing else touches it.
     */
    if (task.status === 'paused' && task.pauseReason === 'upstream') {
      /**
       * The holder and the supervisor — nothing else.
       *
       * `currentStageSessionId` is whoever is holding the task: the supervisor while it decides, a
       * worker while it works, the acceptance session while it judges. The flow is serial, so
       * 「is the provider back」 has one answer per task and nothing to reconcile. The supervisor is
       * added separately because it is what resumes the task afterwards, so its group must be
       * reachable too.
       *
       * No fallback to `currentWorkerSessionId`: `normalizeTask` already fills this field on read
       * for records written before the split, so a missing value here means a task that genuinely
       * has no holder — not a record that needs translating.
       *
       * Deduplicated because the supervisor is often the holder: once the baton goes back after a
       * hand-off they are the same session, and probing one group twice buys nothing.
       */
      const sessionIds = [...new Set([task.currentStageSessionId, task.supervisorSessionId])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
      findings.push({
        kind: 'upstream_wait',
        task,
        strategies: [...new Set(deps.strategiesOf?.(task, sessionIds) ?? [])],
      })
      continue
    }

    if (task.status === 'paused' && task.pauseReason === 'process_lost') {
      if (processLostRetryDue(task, now, processLostGraceMs())) {
        findings.push({ kind: 'resume_lost', task })
      }
      continue
    }

    /**
     * A pause the person was never told about.
     *
     * The supervisor is the only one who speaks to the user, and it is woken to do it — but that
     * wake is one turn, and a turn can die. Observed on a real run: T-1's hand-off landed at
     * 16:53:29 and parked the task as `awaiting_release`; the supervisor was woken at 16:53:46,
     * the upstream stream went silent for 60 seconds, the retry was exhausted, and the turn ended
     * in an error. The task then sat paused with a correct board and no sentence anywhere saying
     * 「按你的指示停了，要放行吗」 — and every rule below skipped it, because they all inspect
     * `running` tasks. The watchdog reported 「0 finding(s)」 for the next twelve minutes.
     *
     * `awaiting_release` is a legitimate state; the defect is that nobody was told. The test is
     * the record, not the wording: the pause happened after the last announced activity. Woken
     * once — a pause that was announced and then left alone is a person's decision to make, not a
     * loop for this loop to enter.
     *
     * No `sessionWorking` check, deliberately: the thing being repaired is a turn that *ended*, so
     * by the time the grace has passed the supervisor is idle in the normal case, and in the busy
     * case `sendMessage` queues the brief behind the running turn rather than steering it.
     */
    if (
      task.status === 'paused' &&
      task.pauseReason === 'awaiting_release' &&
      !task.stats?.announcedPauseAt &&
      now - (task.lifecycle?.lastPausedAt ?? task.updatedAt ?? now) >= UNANNOUNCED_PAUSE_GRACE_MS
    ) {
      findings.push({ kind: 'unannounced_pause', task });
      continue;
    }

    if (task.status !== 'running') continue;

    /**
     * A `pending:` lock is a spawn in flight, not a session that disappeared.
     *
     * `startRun` claims with a placeholder before the session exists (claim-before-spawn), so
     * for a moment the lock reads `pending:dispatch`. `sessionExists` cannot answer yes to
     * that, and the orphaned rule below read the no as 「the process is gone」: live on T-1 the
     * task went running → paused(process_lost) twenty-three milliseconds after the claim,
     * which released the lock the spawn was about to bind — the bind then counted as a second
     * run and the supervisor spent a turn explaining a process loss that never happened.
     *
     * Nothing about a session that does not exist yet can be inspected, so every rule below
     * waits. A crash in this window is not lost: `recoverAfterRestart` still treats a leftover
     * `pending:` lock as a dead run and pauses it resumably.
     */
    if (task.stats?.lockSessionId?.startsWith('pending:')) continue;

    const sessionAlive = task.currentWorkerSessionId
      ? deps.sessionExists(task.currentWorkerSessionId)
      : false;

    if (!sessionAlive) {
      findings.push({ kind: 'orphaned', task });
      continue;
    }
    /**
     * Stopped working without filing a hand-off.
     *
     * The rule used to ask "is the plan finished" first, and that is the wrong question.
     * A worker that finished its assigned slice but not the whole plan never reached it:
     * one such worker wrote a summary in the transcript, never called `report_result`, and
     * the task sat on 进行中 with zero hand-offs and a supervisor that was never woken. The
     * only thing that happened was the idle rule five minutes later, which resumed a turn
     * that had ended normally — the subprocess answered `Cannot retry: no re-runnable model
     * step`, the wake did nothing, and the supervisor was told 「已唤醒它继续」 anyway.
     *
     * Whether the plan is complete changes what the nudge should SAY, not whether it is
     * owed. The condition that matters is the one stated plainly: the task is running, its
     * executor has stopped, nobody is waiting on a background command, and THIS run has
     * not filed a hand-off. Checking "any hand-off ever" would silence every later leg of a
     * task, because the earlier sessions' reports are still in the record.
     */
    const waiting = task.currentWorkerSessionId ? deps.sessionWaiting?.(task.currentWorkerSessionId) === true : false
    const filedThisRun = hasFiledThisRun(task)
    if (deps.sessionWorking && task.currentWorkerSessionId && !waiting && !filedThisRun) {
      const working = deps.sessionWorking(task.currentWorkerSessionId)
      if (working === false && now - lastActivityOf(task) >= stoppedGrace(task)) {
        findings.push({ kind: 'unreported', task })
        continue
      }
    }

    // Liveness is not the same as progress: the session object outlives the turn.
    // A running task whose session is sitting idle (and has been for a while) is
    // the state the user sees as "进行中 but nothing is happening".
    /**
     * A session that already filed its report is not idle, it is done.
     *
     * `unreported` has always excluded this run's hand-off; `idle` did not, so a task
     * whose worker handed off and stopped — correctly, the report says so — was woken
     * six minutes later with 「继续」, and the supervisor read that as work that needed
     * resuming. Observed live: hand-off at 09:01:53, idle wake at 09:08:19, and a
     * supervisor that then asked the person whether to continue on the strength of a
     * nudge to a session with nothing left to do.
     */
    if (deps.sessionWorking && task.currentWorkerSessionId && !waiting && !filedThisRun) {
      const working = deps.sessionWorking(task.currentWorkerSessionId);
      if (working === false && now - lastActivityOf(task) >= IDLE_SESSION_MS) {
        findings.push({ kind: 'idle', task });
        continue;
      }
    }

    if (isHeartbeatStalled(task, now)) {
      findings.push({ kind: 'stalled', task });
      continue;
    }
    if (shouldTripFuse(task.lifecycle)) {
      findings.push({ kind: 'failing', task });
      continue;
    }
    /**
     * A running task is never paused for 「the plan has not moved」.
     *
     * This rule used to pause any task whose plan sat unchanged for forty minutes, on the theory
     * that a checklist which stops moving is evidence of drift. It is not: the expensive, valuable
     * steps are exactly the ones that leave the plan untouched for an hour — an end-to-end run, a
     * real-device verification sweep, a full test suite. Live 2026-11-15/16 on T-1: the worker was
     * mid-delivery, its plan frozen since the last sub-step, and the rule paused the task and told
     * the person it had 「偏离目标」 while it was in fact still working.
     *
     * Liveness is what the rules above already measure, and they measure it properly: `stalled`
     * on a dead heartbeat, `orphaned` when the session is gone, `unreported` when a session ends a
     * turn owing a hand-off. A worker that is alive and working is not off track, however long its
     * current step takes.
     */
    const plan = task.spec?.plan;
    void plan;
    if (task.budget.deadline && now > task.budget.deadline) {
      findings.push({ kind: 'overdue', task });
    }
  }

  return findings;
}

/**
 * Tell the supervisor what actually happened, not what was attempted.
 *
 * Split out because both wake cases need it and because "已唤醒" was a lie in production:
 * the call returned without error, the subprocess refused the turn, and the supervisor read
 * that work had resumed while the task sat idle for minutes.
 */
function announceWake(
  deps: WatchdogDeps,
  task: Task,
  /** What this wake was about — `idle` and `unreported` are different subjects for one task. */
  subject: string,
  result: void | boolean | Promise<boolean>,
  successText: string,
  failureText: string,
): void {
  const key = `${task.id}:${subject}`
  const fail = (): void => deps.notify(task.supervisorSessionId, failureText, `${key}-failed`)
  if (result === false) {
    fail()
    return
  }
  if (result && typeof (result as Promise<boolean>).then === 'function') {
    void (result as Promise<boolean>).then((ok) => {
      if (ok === false) fail()
      else deps.notify(task.supervisorSessionId, successText, key)
    }, fail)
    return
  }
  deps.notify(task.supervisorSessionId, successText, key)
}

/** Apply the fixes for a batch of findings. Pure rules; no model calls. */
export function applyFindings(
  deps: WatchdogDeps,
  findings: WatchdogFinding[],
  /**
   * Probe answers per strategy id.
   *
   * Absent when the caller has no probe (`runWatchdogPass` without `probeStrategy`, or the tests
   * that drive `applyFindings` directly) — an absent answer is 「not known to be back」, so a
   * parked task stays parked rather than resuming on missing evidence.
   */
  probeAnswers: ReadonlyMap<string, boolean> = new Map(),
): number {
  let acted = 0;
  for (const finding of findings) {
    /**
     * One subject per finding: the task and what the finding is.
     *
     * Everything below writes to the same supervisor, and a task can produce several findings in one
     * pass. Naming the subject here — from the finding, not from the sentence — is what lets the
     * outbound queue collapse two notices about the same fact into one.
     */
    const notify = (text: string) =>
      deps.notify(finding.task.supervisorSessionId, text, `${finding.task.id}:${finding.kind}`)
    switch (finding.kind) {
      case 'unannounced_pause': {
        /**
         * The task paused and nobody said so — the sentence is owed by the supervisor, not by this
         * loop. Marked before the wake is attempted, deliberately: the wake is what died last time,
         * and retrying it every pass would turn one failed turn into a stream of them.
         *
         * If the wake fails, `announceWake` notifies the supervisor again through the same session,
         * which is the right second attempt: the failure was one turn, not the whole session. If
         * that session is gone, the notice is dropped — the board still shows the pause, and this
         * loop has no way to reach the person without a supervisor to speak through.
         */
        deps.markPauseAnnounced?.(finding.task.id)
        if (deps.wakeSession && finding.task.supervisorSessionId) {
          const result = deps.wakeSession(finding.task, finding.task.supervisorSessionId, 'pause')
          announceWake(
            deps,
            finding.task,
            'pause',
            result,
            `${finding.task.id} 已暂停（等你放行），已提醒督导向你说明。`,
            `${finding.task.id} 已暂停但督导没能说明——任务卡在这里，需要你看一眼。`,
          )
        } else {
          notify(`${finding.task.id} 已暂停，但没有人能替你总结它，需要你看一眼。`, )
        }
        acted += 1
        break;
      }
      case 'upstream_wait': {
        const recovered = upstreamRecoveredFor(finding.strategies, probeAnswers)
        if (!recovered) break
        /**
         * Starting the run is what lifts the pause; a nudge is not.
         *
         * The first version of this branch called `wakeSession(..., 'pause')`, which sends the
         * supervisor a sentence and leaves the task exactly as paused as it was — so the next pass
         * found the same finding and sent it again, every couple of seconds, forever. Live
         * 2026-11-15 21:30: 「Task T-2 … is paused and waiting for you」 re-steered into the same
         * turn dozens of times and the task never moved.
         *
         * `resume` claims a run through the task service, which is the transition that both clears
         * `upstream` and puts the work back in motion.
         */
        if (!deps.resume) break
        const outcome = deps.resume(finding.task)
        Promise.resolve(outcome)
          .then((started) => {
            notify(
              started === false
                ? `${finding.task.id} 的上游已恢复，但没能重新启动，需要你看一下。`
                : `${finding.task.id} 的上游已恢复，已继续。`,
            )
          })
          .catch((error) => {
            log.warn('[watchdog] resume after upstream outage failed', {
              id: finding.task.id,
              error: String(error),
            })
          })
        acted += 1
        break
      }
      case 'resume_lost': {
        /**
         * The pass itself stays synchronous — it is a pure rule sweep and making it async would
         * push `await` through the loop and every caller. Starting a run is asynchronous, so its
         * outcome is handled where it arrives. The one thing this must not do is announce a retry
         * before knowing whether it started: a run refused by the budget gate needs a person, and
         * 「已自动重试」 would be the same lie the supervisor told in an earlier incident.
         */
        const outcome = deps.resume?.(finding.task)
        Promise.resolve(outcome)
          .then((started) => {
            notify(started === false
                ? `${finding.task.id} 的会话丢失后自动重试没有启动（可能超出预算或被门禁拦住），需要你看一下。`
                : `${finding.task.id} 的会话丢失，已自动重试一次。再丢就需要人工确认。`,
            )
          })
          .catch((error) => {
            log.warn('[watchdog] resume after process loss failed', { id: finding.task.id, error: String(error) })
            notify(`${finding.task.id} 的会话丢失后自动重试失败，需要你看一下。`,
            )
          })
        acted += 1
        break
      }
      case 'orphaned':
        deps.pause(finding.task.id, 'process_lost', '会话已消失');
        notify(`${finding.task.id} 的会话已消失，任务已暂停（可续跑）。`,
        );
        acted += 1;
        break;
      case 'unreported': {
        const sessionId = finding.task.currentWorkerSessionId
        /**
         * The same budget as 「idle」, because it is the same loop.
         *
         * A worker that stops without filing is woken to file; one that never files was
         * being woken forever, one model turn at a time, while the idle path next door
         * gave up after two tries. The budget is about what a wake can achieve, and it
         * cannot achieve more here.
         */
        const unreportedAttempts = finding.task.stats?.wakeAttempts ?? 0
        if (sessionId && deps.wakeSession && unreportedAttempts >= MAX_IDLE_WAKES) {
          deps.pause(finding.task.id, null, '执行者多次提醒后仍未交接')
          notify(
            `${finding.task.id} 的执行者已停止且多次提醒仍未交作业，任务已暂停，需要你确认下一步。`,
          )
          acted += 1
          break
        }
        if (sessionId && deps.wakeSession) {
          // The nudge text adapts to whether the plan is finished; see
          // formatUnreportedBrief. The wake itself does not depend on it.
          const result = deps.wakeSession(finding.task, sessionId, 'unreported')
          announceWake(
            deps,
            finding.task,
            'unreported',
            result,
            `${finding.task.id} 的执行者已停止但没交作业，已提醒它用 report_result 交接。`,
            `${finding.task.id} 的执行者已停止且没有交接，唤醒失败——任务卡在这里，需要你确认下一步。`,
          )
        } else {
          deps.pause(finding.task.id, null, '执行者已停止且没有交接')
          notify(`${finding.task.id} 没有交接且会话也不在了，任务已暂停。`,
          )
        }
        acted += 1
        break;
      }
      case 'idle': {
        const attempts = finding.task.stats?.wakeAttempts ?? 0;
        const sessionId = finding.task.currentWorkerSessionId;
        if (attempts >= MAX_IDLE_WAKES || !sessionId || !deps.wakeSession) {
          // Out of attempts (or nobody to wake with): stop pretending the task is
          // running. A task that says 进行中 while nothing is working on it is
          // worse than a paused one, because the user waits instead of looking.
          deps.pause(finding.task.id, 'process_lost', '会话空闲且没有进展');
          notify(`${finding.task.id} 的会话已空闲 ${Math.round(IDLE_SESSION_MS / 60_000)} 分钟以上，唤醒失败 ${attempts} 次仍未推进，任务已暂停，需要你确认下一步。`,
          );
        } else {
          const result = deps.wakeSession(finding.task, sessionId, 'idle')
          announceWake(
            deps,
            finding.task,
            'idle',
            result,
            `${finding.task.id} 的会话空闲了，已唤醒它继续（第 ${attempts + 1} 次）。`,
            `${finding.task.id} 的会话空闲了，但唤醒失败（第 ${attempts + 1} 次），需要你确认下一步。`,
          )
        }
        acted += 1;
        break;
      }
      case 'stalled':
        deps.pause(finding.task.id, 'process_lost', '心跳已停滞');
        notify(`${finding.task.id} 超过两个心跳没有动静，任务已暂停。`,
        );
        acted += 1;
        break;
      case 'failing':
        deps.pause(finding.task.id, null, '连续失败');
        notify(`${finding.task.id} 连续失败，任务已暂停，需要你决定是否重试。`,
        );
        acted += 1;
        break;
      case 'overdue':
        deps.pause(finding.task.id, null, '已过截止时间');
        notify(`${finding.task.id} 已过截止时间，任务已暂停。`);
        acted += 1;
        break;
      default:
        break;
    }
  }
  if (acted > 0) log.info(`[watchdog] acted on ${acted} finding(s)`);
  return acted;
}

/** One pass: inspect then apply. Returns how many tasks were paused. */
/**
 * One pass: inspect, ask the probe about any parked task, then act.
 *
 * The probe is asynchronous while `inspectTasks` stays pure and synchronous — so the pass collects
 * findings first, resolves the one question only I/O can answer, and hands the rest to
 * `applyFindings`. Keeping `inspectTasks` synchronous is what lets every rule stay unit-testable
 * with a fixed `now`.
 */
export async function runWatchdogPass(deps: WatchdogDeps): Promise<number> {
  const findings = inspectTasks(deps);
  const parked = findings.filter(
    (finding): finding is Extract<WatchdogFinding, { kind: 'upstream_wait' }> =>
      finding.kind === 'upstream_wait',
  );
  if (parked.length === 0) return applyFindings(deps, findings);

  /**
   * One probe per distinct strategy, shared by every task that waits on it.
   *
   * This is the whole point of a shared probe: ten tasks parked on the same outage cost one
   * request per minute, not ten. A failed probe is `false`, never an exception — a probe that
   * throws must not be read as 「recovered」.
   */
  const answers = new Map<string, boolean>();
  const asked = [...new Set(parked.flatMap((finding) => finding.strategies))];
  for (const strategyId of asked) {
    if (!deps.probeStrategy) break;
    try {
      answers.set(strategyId, await deps.probeStrategy(strategyId));
    } catch {
      answers.set(strategyId, false);
    }
  }

  return applyFindings(deps, findings, answers);
}

/** Default cadence: often enough to catch a stall, cheap enough to ignore. */
export const WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** No progress at all for this long is a different (worse) signal. */
export const STALE_TASK_MS = 30 * 60_000;

/** Never sleep longer than this, even when nothing is due. */

/** Never spin faster than this, even when a deadline is already past. */
export const MIN_WATCHDOG_SLEEP_MS = 15_000;

/** Consecutive failed passes before the watchdog reports that it is broken. */
export const MAX_WATCHDOG_FAILURES = 3;

export interface WatchdogLoopOptions {
  /**
   * Called when the watchdog itself looks broken.
   *
   * A timer that throws every pass is indistinguishable from a timer that finds
   * nothing, and "the supervisor never told me" is how a whole automation layer
   * dies quietly. The host turns this into one visible message.
   */
  onSelfFailure?: (info: { failures: number; lastError: string }) => void;
}

/**
 * When the next check is actually due.
 *
 * A fixed interval is wrong in both directions: it fires when nothing can have
 * changed, and it fires late when a deadline passed a minute ago. Every signal
 * the watchdog acts on already has a timestamp, so the interval is derived from
 * the task state instead of from the clock:
 *
 *  - a running task is due at `lastHeartbeatAt + 2 × interval` (the stall rule);
 *  - a paused task with an open question has nothing scheduled: it waits for the person;
 *  - a task that has not changed for 30 minutes is due now (no progress);
 *  - a session that went silent 5 minutes ago is due now.
 *
 * Returns `Infinity` when nothing is pending — the caller then sleeps to its cap.
 */
export function nextCheckDelayMs(deps: WatchdogDeps, now = Date.now()): number {
  let soonest = Number.POSITIVE_INFINITY;

  for (const task of deps.listTasks()) {
    /**
     * An open question schedules nothing — the task waits for the person, however long that takes.
     *
     * A question is asked once and stays open, so there is no future moment when looking at it
     * again would change anything — it schedules nothing. Skipping it also keeps `NaN` out of the
     * arithmetic: `Math.min(Infinity, undefined)` poisons `soonest`, and `clampSleep` would then
     * quietly cap every pass at 30 seconds instead of sleeping to the real deadline.
     */
    // The queue, not the `decision` mirror: a task can hold several open questions at once, and
    // `decision` is only the newest one. Both sides of the loop must read the same set, or the
    // scheduler would keep waking for a task the inspection pass then refuses to look at.
    if ((task.decisions ?? []).some((entry) => !entry.resolvedAt)) continue
    if (task.status !== 'running') continue;

    // Stall deadline: two heartbeat windows without a beat.
    const lastBeat = task.stats?.lastHeartbeatAt ?? task.lastHeartbeatAt;
    if (typeof lastBeat === 'number') {
      soonest = Math.min(soonest, lastBeat + task.heartbeatIntervalMin * 60_000 * 2 - now);
    } else {
      const startedAt = task.stats?.runStartedAt ?? task.updatedAt;
      soonest = Math.min(soonest, startedAt + task.heartbeatIntervalMin * 60_000 * 2 - now);
    }

    // A running task whose session is idle is due once the idle window elapses —
    // that is the whole point of noticing it, so waiting for the heartbeat or
    // stale windows would delay the only check that can recover it.
    if (deps.sessionWorking && task.currentWorkerSessionId) {
      // A session that is waiting on a background shell is not late for anything.
      const waiting = deps.sessionWaiting?.(task.currentWorkerSessionId) === true;
      const working = deps.sessionWorking(task.currentWorkerSessionId);
      if (working === false && !waiting) {
        // The deadline the matching rule uses, not the coarser one: scheduling the
        // earlier of the two would wake for a task that is not due yet.
        const grace = hasFiledThisRun(task) ? IDLE_SESSION_MS : stoppedGrace(task);
        soonest = Math.min(soonest, lastActivityOf(task) + grace - now);
      }
    }

    // A running task whose session is alive but producing nothing for 30 minutes
    // is a finding of its own, so it is due as soon as that window elapses.
    // A missing timestamp is *unknown*, not ancient: treating 0 as "stale since
    // 1970" would make a freshly migrated task check forever.
    if (typeof task.updatedAt === 'number' && task.updatedAt > 0) {
      soonest = Math.min(soonest, task.updatedAt + STALE_TASK_MS - now);
    }
  }

  return soonest;
}

/**
 * Sleep until the next due moment, bounded at both ends.
 *
 * The bounds matter: a past-due task must not turn into a busy loop, and an idle
 * system must still wake occasionally in case a task was edited on disk.
 *
 * The upper bound is the responsiveness, and it was 30 minutes. That is fine for a
 * deadline, wrong for a state that changes while the loop sleeps: the loop computed its
 * sleep *before* the worker's turn ended, so the 90-second grace for a silent worker was
 * acted on three minutes late — the deadline had already been re-derived from an older
 * state, and nothing re-evaluated it until the timer fired. Sleeping at most 30 seconds
 * costs one pure-rules pass (no model, no I/O beyond the task store) and makes the grace
 * the actual latency.
 */
export const MAX_WATCHDOG_SLEEP_MS = 30_000;

export function clampSleep(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_WATCHDOG_SLEEP_MS;
  return Math.min(MAX_WATCHDOG_SLEEP_MS, Math.max(MIN_WATCHDOG_SLEEP_MS, delayMs));
}

/**
 * Start the loop. Returns a disposer.
 *
 * `unref` so a pending timer never keeps the host process alive on shutdown.
 */
/** The running loop: a disposer, plus a way to ask for a pass right now. */
export type WatchdogLoop = (() => void) & {
  /**
   * Run a pass at the next tick instead of when the timer happens to expire.
   *
   * The loop waits for a *deadline*, but the state it checks changes on events:
   * a worker's turn ends, and the moment it does the task may be "running, executor
   * stopped, nothing filed" — true right then, not in ninety seconds. Polling cannot
   * see that moment, so it waits for a promise the state already made. A real run
   * showed it: the session stopped at 16:26, the watchdog only noticed at 16:27:40,
   * and the model had been sitting idle for the whole gap.
   *
   * Safe to call from anywhere: a pending timer is replaced, never doubled.
   */
  wake: () => void;
};

export function startWatchdog(
  deps: WatchdogDeps,
  intervalMs = WATCHDOG_INTERVAL_MS,
  options: WatchdogLoopOptions = {},
): WatchdogLoop {
  let failures = 0;
  let lastError = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /**
   * One pass, and never two at once.
   *
   * The pass now awaits the upstream probe, so a slow probe would overlap the next tick. Two
   * overlapping passes could both see a parked task and both wake it — the double-wake this loop
   * has already produced once (T-2, 2 ms apart). `ticking` makes the pass self-serialising.
   */
  /**
   * One pass, and never two at once.
   *
   * The pass now awaits the upstream probe, so a slow probe would overlap the next tick. Two
   * overlapping passes could both see the same parked task and both wake it — the double-wake this
   * loop has already produced once (T-2, two turns 2 ms apart). `ticking` keeps the pass
   * self-serialising; the timer below still schedules the next one regardless of the outcome.
   */
  let ticking = false;
  const tick = (): void => {
    if (stopped || ticking) return;
    ticking = true;
    void (async () => {
      try {
        const acted = await runWatchdogPass(deps);
        // A silent pass is indistinguishable from a loop that is not running. One line
        // per pass is the difference between "nothing to do" and "not alive", and this
        // loop has already been reported dead twice while the code looked correct.
        log.info(`[watchdog] pass: ${acted} finding(s)`);
        failures = 0;
        lastError = '';
      } catch (error) {
        failures += 1;
        lastError = error instanceof Error ? error.message : String(error);
        log.warn(`[watchdog] pass failed (${failures}/${MAX_WATCHDOG_FAILURES})`, { error: lastError });
        // Report once per outage, not every pass: a broken watchdog must not add
        // its own flood to the problem.
        if (failures === MAX_WATCHDOG_FAILURES) {
          try {
            options.onSelfFailure?.({ failures, lastError });
          } catch {
            // Nothing left to report to.
          }
        }
      } finally {
        ticking = false;
      }

      /**
       * Schedule from inside the pass, not from the callback's end.
       *
       * Awaiting the probe means the callback returns before the pass finishes; scheduling outside
       * this block would queue the next tick while `ticking` is still set, and every tick after a
       * slow probe would be skipped.
       */
      if (stopped) return;
      // Derive the next wake-up from what is actually pending. `intervalMs` is the
      // floor when a caller wants a faster sweep than the state suggests.
      //
      // This read is inside its own guard on purpose: `nextCheckDelayMs` touches the
      // task store, and a store that throws here would otherwise escape the timer
      // callback and stop the loop for good — the exact failure mode the self-
      // monitor exists to catch.
      let suggested = Number.POSITIVE_INFINITY;
      try {
        suggested = nextCheckDelayMs(deps);
      } catch (error) {
        log.warn('[watchdog] cannot compute the next check; retrying later', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      let delay = clampSleep(suggested);
      if (Number.isFinite(intervalMs) && intervalMs > 0) delay = Math.min(delay, intervalMs);
      timer = setTimeout(tick, delay);
      timer.unref?.();
    })();
  };

  // First pass immediately: a task may already be stalled when the app starts.
  log.info('[watchdog] started');
  timer = setTimeout(tick, 0);
  timer.unref?.();

  const loop = (() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  }) as WatchdogLoop;

  loop.wake = () => {
    if (stopped) return;
    // Replace the pending wait rather than adding a second one: two timers would
    // double every later pass, and the loop is cheap but not free.
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, 0);
    timer.unref?.();
  };

  return loop;
}
