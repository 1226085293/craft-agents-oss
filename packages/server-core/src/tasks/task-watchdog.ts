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
  lastPlanChangeAt,
  planProgress,
  planStalled,
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
  | { kind: 'decision_timeout'; task: Task }
  | { kind: 'looping'; task: Task }
  | { kind: 'off_track'; task: Task }
  | { kind: 'resume_lost'; task: Task };

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
  wakeSession?: (
    task: Task,
    sessionId: string,
    reason: 'idle' | 'unreported',
  ) => void | boolean | Promise<boolean>;
  /** Pause a task with a reason. */
  pause: (id: string, reason: 'failures' | 'budget' | 'process_lost' | 'waiting', note: string) => void;
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
  /** Tell the owning supervisor, in one line. */
  notify: (supervisorSessionId: string, text: string) => void;
  /**
   * Apply the default answer to an unanswered decision request.
   *
   * Separate from `pause` because the task is already paused: what changes is
   * that the decision is now resolved as a refusal.
   */
  denyDecision?: (id: string, note: string) => void;
  now?: () => number;
}

/**
 * Consecutive handoffs that say the same thing = the worker is turning in
 * circles: still alive, still handing off, never progressing.
 *
 * Three is deliberate: one repeat is a retry, two is bad luck, three means the
 * task will not finish on its own and a human should look.
 */
export const MAX_REPEATED_HANDOFFS = 3;

/**
 * How long a plan may sit unchanged before the worker is considered off track.
 *
 * Longer than the stall window on purpose: a step can legitimately take twenty
 * minutes (a build, a test run), and pausing a worker that is mid-task is worse
 * than letting a stuck one run a little longer.
 */
export const OFF_TRACK_MS = 40 * 60_000;

/** Strip whitespace so a reformatted repeat still counts as a repeat. */
function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

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
  return task.handoffs.some(
    (handoff) =>
      handoff.outcome !== 'needs_decision' &&
      handoff.fromSessionId === task.currentSessionId &&
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

function lastActivityOf(task: Task): number {
  return Math.max(
    task.lastHeartbeatAt ?? 0,
    task.stats?.lastHeartbeatAt ?? 0,
    task.updatedAt ?? 0,
    task.stats?.lastWakeAt ?? 0,
  );
}

/**
 * Detect a worker that keeps reporting the same thing.
 *
 * Only the tail matters: an early repeated summary followed by real progress is
 * normal, and a task that changed direction legitimately starts a new run of
 * distinct summaries.
 */
export function isLooping(task: Task): boolean {
  const handoffs = task.handoffs;
  if (handoffs.length < MAX_REPEATED_HANDOFFS) return false;
  const tail = handoffs.slice(-MAX_REPEATED_HANDOFFS).map((handoff) => normalizeSummary(handoff.summary));
  const first = tail[0];
  if (!first) return false;
  return tail.every((summary) => summary === first);
}

/** One automatic retry per loss; the second time a person decides. */
export const MAX_PROCESS_LOST_RETRIES = 1;

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
    // A decision request that nobody answered expires on its own. Checked before
    // the running-state filters because a waiting task is paused, not running.
    const decision = task.decision;
    if (decision && !decision.resolvedAt && decision.deadlineAt <= now) {
      findings.push({ kind: 'decision_timeout', task });
      continue;
    }

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
    if (task.status === 'paused' && task.pauseReason === 'process_lost') {
      const retries = task.stats?.lostRetries ?? 0
      if (retries < MAX_PROCESS_LOST_RETRIES && now - lastActivityOf(task) >= processLostGraceMs()) {
        findings.push({ kind: 'resume_lost', task })
      }
      continue
    }

    if (task.status !== 'running') continue;

    const sessionAlive = task.currentSessionId
      ? deps.sessionExists(task.currentSessionId)
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
    const waiting = task.currentSessionId ? deps.sessionWaiting?.(task.currentSessionId) === true : false
    const filedThisRun = hasFiledThisRun(task)
    if (deps.sessionWorking && task.currentSessionId && !waiting && !filedThisRun) {
      const working = deps.sessionWorking(task.currentSessionId)
      if (working === false && now - lastActivityOf(task) >= stoppedGrace(task)) {
        findings.push({ kind: 'unreported', task })
        continue
      }
    }

    // Liveness is not the same as progress: the session object outlives the turn.
    // A running task whose session is sitting idle (and has been for a while) is
    // the state the user sees as "进行中 but nothing is happening".
    if (deps.sessionWorking && task.currentSessionId && !waiting) {
      const working = deps.sessionWorking(task.currentSessionId);
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
    // Checked after liveness: a looping worker is alive and heartbeating, which
    // is exactly why the cheap checks never caught it.
    if (isLooping(task)) {
      findings.push({ kind: 'looping', task });
      continue;
    }
    // Structural drift: the plan exists, is unfinished, and nothing has moved in
    // it. This replaces guessing whether the worker "went off target" — a
    // checklist that stopped moving is the same claim, and it is a timestamp
    // comparison rather than a model call.
    const plan = task.spec?.plan;
    if (plan?.length && !planProgress(plan).complete) {
      const lastChange = Math.max(lastPlanChangeAt(plan), task.updatedAt);
      if (planStalled(plan, lastChange, now, OFF_TRACK_MS)) {
        findings.push({ kind: 'off_track', task });
        continue;
      }
    }
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
  result: void | boolean | Promise<boolean>,
  successText: string,
  failureText: string,
): void {
  const fail = (): void => deps.notify(task.supervisorSessionId, failureText)
  if (result === false) {
    fail()
    return
  }
  if (result && typeof (result as Promise<boolean>).then === 'function') {
    void (result as Promise<boolean>).then((ok) => {
      if (ok === false) fail()
      else deps.notify(task.supervisorSessionId, successText)
    }, fail)
    return
  }
  deps.notify(task.supervisorSessionId, successText)
}

/** Apply the fixes for a batch of findings. Pure rules; no model calls. */
export function applyFindings(deps: WatchdogDeps, findings: WatchdogFinding[]): number {
  let acted = 0;
  for (const finding of findings) {
    switch (finding.kind) {
      case 'decision_timeout':
        // Silence is refusal, never consent.
        deps.denyDecision?.(
          finding.task.id,
          `「${finding.task.decision?.label ?? '决策请求'}」超时未响应，已按拒绝处理。`,
        );
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 的决策请求已超时，默认按拒绝处理，任务未继续。`,
        );
        acted += 1;
        break;
      case 'off_track': {
        const progress = planProgress(finding.task.spec?.plan);
        deps.pause(finding.task.id, 'waiting', 'plan stopped moving');
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 的计划已 ${Math.round(OFF_TRACK_MS / 60_000)} 分钟没有推进（完成 ${progress.done}/${progress.total}），任务已暂停，需要确认它是否偏离目标。`,
        );
        acted += 1;
        break;
      }
      case 'looping':
        deps.pause(finding.task.id, 'failures', 'repeated identical handoffs');
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 连续 ${MAX_REPEATED_HANDOFFS} 次交接内容相同，Worker 在原地打转，任务已暂停。`,
        );
        acted += 1;
        break;
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
            deps.notify(
              finding.task.supervisorSessionId,
              started === false
                ? `${finding.task.id} 的会话丢失后自动重试没有启动（可能超出预算或被门禁拦住），需要你看一下。`
                : `${finding.task.id} 的会话丢失，已自动重试一次。再丢就需要人工确认。`,
            )
          })
          .catch((error) => {
            log.warn('[watchdog] resume after process loss failed', { id: finding.task.id, error: String(error) })
            deps.notify(
              finding.task.supervisorSessionId,
              `${finding.task.id} 的会话丢失后自动重试失败，需要你看一下。`,
            )
          })
        acted += 1
        break
      }
      case 'orphaned':
        deps.pause(finding.task.id, 'process_lost', 'session disappeared');
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 的会话已消失，任务已暂停（可续跑）。`,
        );
        acted += 1;
        break;
      case 'unreported': {
        const sessionId = finding.task.currentSessionId
        if (sessionId && deps.wakeSession) {
          // The nudge text adapts to whether the plan is finished; see
          // formatUnreportedBrief. The wake itself does not depend on it.
          const result = deps.wakeSession(finding.task, sessionId, 'unreported')
          announceWake(
            deps,
            finding.task,
            result,
            `${finding.task.id} 的执行者已停止但没交作业，已提醒它用 report_result 交接。`,
            `${finding.task.id} 的执行者已停止且没有交接，唤醒失败——任务卡在这里，需要你确认下一步。`,
          )
        } else {
          deps.pause(finding.task.id, 'waiting', 'stopped without filing a hand-off')
          deps.notify(
            finding.task.supervisorSessionId,
            `${finding.task.id} 没有交接且会话也不在了，任务已暂停。`,
          )
        }
        acted += 1
        break;
      }
      case 'idle': {
        const attempts = finding.task.stats?.wakeAttempts ?? 0;
        const sessionId = finding.task.currentSessionId;
        if (attempts >= MAX_IDLE_WAKES || !sessionId || !deps.wakeSession) {
          // Out of attempts (or nobody to wake with): stop pretending the task is
          // running. A task that says 进行中 while nothing is working on it is
          // worse than a paused one, because the user waits instead of looking.
          deps.pause(finding.task.id, 'process_lost', 'session idle with no progress');
          deps.notify(
            finding.task.supervisorSessionId,
            `${finding.task.id} 的会话已空闲 ${Math.round(IDLE_SESSION_MS / 60_000)} 分钟以上，唤醒失败 ${attempts} 次仍未推进，任务已暂停，需要你确认下一步。`,
          );
        } else {
          const result = deps.wakeSession(finding.task, sessionId, 'idle')
          announceWake(
            deps,
            finding.task,
            result,
            `${finding.task.id} 的会话空闲了，已唤醒它继续（第 ${attempts + 1} 次）。`,
            `${finding.task.id} 的会话空闲了，但唤醒失败（第 ${attempts + 1} 次），需要你确认下一步。`,
          )
        }
        acted += 1;
        break;
      }
      case 'stalled':
        deps.pause(finding.task.id, 'process_lost', 'heartbeat stalled');
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 超过两个心跳没有动静，任务已暂停。`,
        );
        acted += 1;
        break;
      case 'failing':
        deps.pause(finding.task.id, 'failures', 'consecutive failures');
        deps.notify(
          finding.task.supervisorSessionId,
          `${finding.task.id} 连续失败，任务已暂停，需要你决定是否重试。`,
        );
        acted += 1;
        break;
      case 'overdue':
        deps.pause(finding.task.id, 'budget', 'deadline passed');
        deps.notify(finding.task.supervisorSessionId, `${finding.task.id} 已过截止时间，任务已暂停。`);
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
export function runWatchdogPass(deps: WatchdogDeps): number {
  return applyFindings(deps, inspectTasks(deps));
}

/** Default cadence: often enough to catch a stall, cheap enough to ignore. */
export const WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** A silent session is suspicious after this long, not immediately. */
export const SILENT_SESSION_MS = 5 * 60_000;

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
 *  - a paused task with a decision is due at its `deadlineAt`;
 *  - a task that has not changed for 30 minutes is due now (no progress);
 *  - a session that went silent 5 minutes ago is due now.
 *
 * Returns `Infinity` when nothing is pending — the caller then sleeps to its cap.
 */
export function nextCheckDelayMs(deps: WatchdogDeps, now = Date.now()): number {
  let soonest = Number.POSITIVE_INFINITY;

  for (const task of deps.listTasks()) {
    const decision = task.decision;
    if (decision && !decision.resolvedAt) {
      soonest = Math.min(soonest, decision.deadlineAt - now);
      continue;
    }
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
    if (deps.sessionWorking && task.currentSessionId) {
      // A session that is waiting on a background shell is not late for anything.
      const waiting = deps.sessionWaiting?.(task.currentSessionId) === true;
      const working = deps.sessionWorking(task.currentSessionId);
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

  const tick = (): void => {
    if (stopped) return;
    try {
      const acted = runWatchdogPass(deps);
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
    }

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
