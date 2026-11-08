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
  | { kind: 'off_track'; task: Task };

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
 * How long a session may sit idle before the task behind it counts as abandoned.
 *
 * Five minutes, matching the watchdog's own cadence, and that is the honest reason:
 * the check cannot fire more often than a pass runs, so a threshold below the
 * interval buys nothing but a longer wait before the next opportunity to notice. It
 * was eight — a number I picked without evidence — which meant the user watched
 * 进行中 for nearly nine minutes while the recovery sat waiting for a pass that had
 * already gone by.
 *
 * What actually separates "stuck" from "between turns" is not duration, it is
 * `sessionWaiting`: a worker that backgrounded a shell, or is waiting on an event, is
 * idle on purpose and is never woken however long it sits. The clock only decides
 * when to look at everyone else.
 */
export const IDLE_SESSION_MS = 5 * 60_000; // same as a watchdog pass; see above

/**
 * Wakes before the task is handed to a person.
 *
 * One wake is a correction: the worker ended its turn without finishing and may
 * simply have lost the thread. A second one means the nudge is not working, and a
 * third would be a loop paying for a model turn each time.
 */
export const MAX_IDLE_WAKES = 2;

/** The newest evidence that something in this task moved. */
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
    const runStartedAt = task.stats?.runStartedAt
    const filedThisRun = task.handoffs.some(
      (handoff) =>
        handoff.outcome !== 'needs_decision' &&
        handoff.fromSessionId === task.currentSessionId &&
        (!runStartedAt || handoff.at >= runStartedAt),
    )
    if (deps.sessionWorking && task.currentSessionId && !waiting && !filedThisRun) {
      const working = deps.sessionWorking(task.currentSessionId)
      if (working === false && now - lastActivityOf(task) >= IDLE_SESSION_MS) {
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
export const MAX_WATCHDOG_SLEEP_MS = 30 * 60_000;

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
        soonest = Math.min(soonest, lastActivityOf(task) + IDLE_SESSION_MS - now);
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
 */
export function clampSleep(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_WATCHDOG_SLEEP_MS;
  return Math.min(MAX_WATCHDOG_SLEEP_MS, Math.max(MIN_WATCHDOG_SLEEP_MS, delayMs));
}

/**
 * Start the loop. Returns a disposer.
 *
 * `unref` so a pending timer never keeps the host process alive on shutdown.
 */
export function startWatchdog(
  deps: WatchdogDeps,
  intervalMs = WATCHDOG_INTERVAL_MS,
  options: WatchdogLoopOptions = {},
): () => void {
  let failures = 0;
  let lastError = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      runWatchdogPass(deps);
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
  timer = setTimeout(tick, 0);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
