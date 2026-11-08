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
  /** Nudge a session that should be working but is not. */
  wakeSession?: (task: Task, sessionId: string) => void;
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
 * Long enough not to fight a worker that is between turns by design (a handoff, a
 * tool the model is waiting on), short enough that the user is not staring at
 * 进行中 for half an hour.
 */
export const IDLE_SESSION_MS = 8 * 60_000;

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
    // Liveness is not the same as progress: the session object outlives the turn.
    // A running task whose session is sitting idle (and has been for a while) is
    // the state the user sees as "进行中 but nothing is happening".
    if (deps.sessionWorking && task.currentSessionId) {
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
            `${finding.task.id} 的会话已空闲 ${Math.round(IDLE_SESSION_MS / 60_000)} 分钟以上，已唤醒 ${attempts} 次仍未推进，任务已暂停，需要你确认下一步。`,
          );
        } else {
          deps.wakeSession(finding.task, sessionId);
          deps.notify(
            finding.task.supervisorSessionId,
            `${finding.task.id} 的会话空闲了，已唤醒它继续（第 ${attempts + 1} 次）。`,
          );
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
      const working = deps.sessionWorking(task.currentSessionId);
      if (working === false) {
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
