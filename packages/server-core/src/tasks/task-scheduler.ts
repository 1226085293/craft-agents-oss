/**
 * Task scheduler — the only thing that starts a task on its own.
 *
 * Two trigger kinds reach here: a cron tick and an external event. Both do the
 * same three things: decide whether the task may run (a pure rule), claim the
 * run lock, and hand the task to a spawn function. Nothing here calls a model.
 *
 * Deliberately separate from the supervisor: a supervisor turn is expensive and
 * has a 90s budget; a trigger check must be cheap and must happen whether or
 * not any session is awake.
 */

import { createLogger } from '@craft-agent/shared/utils';
import { eventTriggerMatches, matchesCron, type Task, type TaskTrigger } from '@craft-agent/shared/tasks';
import type { TaskService } from './task-service.ts';
import { TRIGGER_CLAIM_MS } from './task-service.ts';

const log = createLogger('task-scheduler');

export interface TaskRunnerDeps {
  /** All tasks (the scheduler filters by trigger). */
  listTasks: () => Task[];
  /** The service that owns the run lock and the journal. */
  tasks: TaskService;
  /**
   * Spawn the worker for a claimed run.
   *
   * No longer used for triggers — a trigger wakes the supervisor, which dispatches. Kept for the
   * recovery paths (`recoverAfterRestart`) that must resume a round nobody is deciding about.
   */
  spawnRun: (task: Task, reason: string) => Promise<{ sessionId: string } | null>;
  /**
   * Ask the supervisor what to do about a fired trigger.
   *
   * This is the one place where a cheap scheduler tick is allowed to cost a model turn, and it is
   * deliberate: 「是否停止/完成」 is a judgement, and the scheduler has no standing to make it.
   */
  triggerTask: (task: Task, reason: string) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Whether the session holding a claim is still working.
   *
   * The expiry pass asks this before releasing a claim: a supervisor turn that is still running gets
   * its deadline pushed out, because pulling the lock out from under a turn that is about to dispatch
   * would let a second turn start on the same round.
   */
  isBusy: (sessionId: string) => boolean;
  now?: () => number;
}

/** The task's triggers as a list, tolerating records that still carry only the single slot. */
function taskTriggers(task: Task): TaskTrigger[] {
  return task.triggers ?? (task.trigger ? [task.trigger] : []);
}

/** One cron pass. `at` is the minute boundary being evaluated. */
export async function runCronPass(deps: TaskRunnerDeps, at: Date): Promise<number> {
  let started = 0;
  for (const task of deps.listTasks()) {
    if (task.status === 'completed' || task.status === 'canceled') continue;
    /**
     * Every cron rule on the task, not just the first.
     *
     * One task can be due for more than one reason, so the list is what the scheduler reads;
     * `startTask` claims the lock, so a second matching rule in the same minute finds the run
     * already taken and does not start a duplicate.
     */
    for (const trigger of taskTriggers(task)) {
      if (trigger.kind !== 'cron' || !trigger.enabled) continue;
      if (!matchesCron(trigger.expr, trigger.timezone, at)) continue;
      if (await startTask(deps, task, `cron:${trigger.expr}`)) started += 1;
      break;
    }
  }
  return started;
}

/** One event pass: an ingested event may match any number of task triggers. */
export async function runEventPass(
  deps: TaskRunnerDeps,
  event: { source: string; type: string; title?: string; summary?: string },
): Promise<number> {
  let started = 0;
  for (const task of deps.listTasks()) {
    if (task.status === 'completed' || task.status === 'canceled') continue;
    // Any of the task's event rules may match: the same task can listen to two sources.
    if (!taskTriggers(task).some((trigger) => eventTriggerMatches(trigger, event))) continue;

    if (await startTask(deps, task, `event:${event.source}/${event.type}`)) started += 1;
  }
  return started;
}

/**
 * Hand a fired trigger to the supervisor.
 *
 * It used to spawn the worker directly (`spawnRun` → `spawnTaskRun` → a worker session with the
 * task brief), which made the scheduler the only thing that decided when a task ran. That is how
 * 「每分钟发一次你好」 ran once and stopped: the worker reported `delivered`, the record closed, and
 * no supervisor ever saw the round to ask 「and minute two?」.
 *
 * So a trigger now does two things: it backs the record with a lock (so two ticks cannot both start
 * a round), and it asks the supervisor to decide. A task that is already running, paused or budget-
 * blocked only accumulates the trigger — the decision belongs to the turn that is already in flight.
 *
 * Returns true when the supervisor was asked, which is what the callers count.
 */
async function startTask(deps: TaskRunnerDeps, task: Task, reason: string): Promise<boolean> {
  const kind: 'cron' | 'event' = reason.startsWith('event:') ? 'event' : 'cron';
  /**
   * A supervisor that is already working cannot take this round.
   *
   * Claiming first and waking second looked safe because the wake cannot be lost — it is queued on
   * the session. But a supervisor stuck mid-turn (its last message a `user` row with no reply) leaves
   * `isProcessing` true, so the notice was held, the claim expired three minutes later, the next tick
   * claimed again, and the cycle repeated: the task held a lock nobody was using and produced no
   * rounds at all. Recording the trigger instead costs nothing and the supervisor sees it the moment
   * it finishes.
   */
  if (deps.isBusy(task.supervisorSessionId ?? '')) {
    log.info(`[task-scheduler] ${task.id} supervisor busy; trigger recorded`);
    deps.tasks.recordTrigger(task.id, { kind, at: deps.now?.() ?? Date.now(), detail: reason });
    return false;
  }
  const claimed = deps.tasks.claimTrigger(task.id, { kind, at: (deps.now?.() ?? Date.now()), detail: reason });
  if (!claimed) {
    // Running, paused, or out of budget: the trigger is on the record and the supervisor will see
    // it in the report that ends the current round.
    log.info(`[task-scheduler] ${task.id} trigger accumulated: ${reason}`);
    return false;
  }

  try {
    const woken = await deps.triggerTask(claimed, reason);
    if (!woken.ok) {
      // Nothing was asked. Keep the backlog (the trigger is real) but release the claim so the
      // next tick can try again instead of waiting out the deadline.
      log.warn(`[task-scheduler] ${task.id} not woken: ${woken.reason ?? 'unknown'}`);
      deps.tasks.releaseTriggerClaim(task.id, woken.reason ?? 'wake failed');
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[task-scheduler] failed to wake for ${task.id}`, { error: message });
    deps.tasks.releaseTriggerClaim(task.id, message);
    return false;
  }
}

/**
 * Expire claims whose supervisor turn never started.
 *
 * A trigger claims the lock before anything exists, so a turn that died after claiming would hold
 * it forever. The watchdog deliberately skips `pending:` claims — there is no session to inspect —
 * which is why expiry is driven by `lockDeadlineAt` rather than by liveness.
 *
 * A supervisor that is still processing gets its deadline pushed back instead of losing the lock:
 * expiring it out from under a turn that is about to dispatch would let a second turn start on the
 * same round.
 */
export function expireTriggerClaims(
  deps: TaskRunnerDeps,
  now: number,
  options: { busy: (task: Task) => boolean; claimMs: number },
): number {
  let expired = 0;
  for (const task of deps.listTasks()) {
    const deadline = task.stats?.lockDeadlineAt;
    if (!deadline || !task.stats?.lockSessionId?.startsWith('pending:')) continue;
    if (deadline > now) continue;
    if (options.busy(task)) {
      deps.tasks.extendTriggerClaim(task.id, now + options.claimMs);
      continue;
    }
    deps.tasks.expireTriggerClaim(task.id, now);
    expired += 1;
  }
  return expired;
}

/** Default cadence: cron has minute resolution, so check once a minute. */
export const TASK_SCHEDULER_INTERVAL_MS = 60_000;

/** How far back a startup scan will look, in minutes (one week). */
export const MAX_CATCHUP_SCAN_MINUTES = 7 * 24 * 60;

/**
 * Record cron minutes that elapsed while the app was not running.
 *
 * The policy is **skip and record**, never catch up:
 *  - catching up would run a day's worth of "scan the issues" jobs at launch,
 *    each spawning a worker, which is exactly the flood the design avoids;
 *  - and "sometimes catch up, sometimes skip" is worse than either, because the
 *    user cannot reason about when the job last ran.
 *
 * So a gap becomes a journal line (`cron_missed`) with a count, and the next
 * real tick runs normally. Recording it is what makes the skip auditable.
 */
export function recordMissedCronRuns(deps: TaskRunnerDeps, now: Date): number {
  let recorded = 0;
  const nowMs = now.getTime();
  // The minute in progress is not "missed" yet — it is being evaluated.
  const currentMinuteStart = Math.floor(nowMs / 60_000) * 60_000;

  for (const task of deps.listTasks()) {
    const trigger = taskTriggers(task).find((entry) => entry.kind === 'cron' && entry.enabled);
    if (!trigger || trigger.kind !== 'cron') continue;
    if (task.status === 'completed' || task.status === 'canceled') continue;

    const last = task.stats?.lastTriggeredAt;
    // A task that never ran has no baseline: its first run is the next tick, not
    // a gap. Treating "created but never fired" as missed would report a gap on
    // every newly created task.
    if (typeof last !== 'number' || last <= 0) continue;

    const fromMinute = Math.floor(last / 60_000) * 60_000;
    const scanStart = Math.max(fromMinute, currentMinuteStart - MAX_CATCHUP_SCAN_MINUTES * 60_000);
    if (scanStart >= currentMinuteStart) continue;

    let missed = 0;
    let firstMissed: number | undefined;
    let lastMissed: number | undefined;
    for (let at = scanStart; at < currentMinuteStart; at += 60_000) {
      const minute = new Date(at);
      // The minute the run actually started on is not a miss.
      if (at === fromMinute) continue;
      if (!matchesCron(trigger.expr, trigger.timezone, minute)) continue;
      missed += 1;
      firstMissed ??= at;
      lastMissed = at;
    }
    if (missed === 0) continue;

    deps.tasks.recordCronGap(task.id, {
      missed,
      firstMissedAt: firstMissed,
      lastMissedAt: lastMissed,
      expr: trigger.expr,
      at: nowMs,
    });
    recorded += 1;
  }

  return recorded;
}

/**
 * Start the cron loop. Returns a disposer.
 *
 * `unref` so a pending timer never keeps the host process alive on shutdown.
 */
export function startTaskScheduler(deps: TaskRunnerDeps, intervalMs = TASK_SCHEDULER_INTERVAL_MS): () => void {
  // Before the loop starts, account for the minutes that passed while the app was
  // closed. Deterministic skip; the gap is journaled so "why didn't it run at 9?"
  // has an answer.
  try {
    const recorded = recordMissedCronRuns(deps, new Date());
    if (recorded > 0) log.info(`[task-scheduler] recorded ${recorded} cron gap(s) as skipped`);
  } catch (error) {
    log.warn('[task-scheduler] missed-schedule scan failed', { error });
  }

  let lastMinute = '';
  const timer = setInterval(() => {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    /**
     * Claim expiry runs every tick, not once a minute.
     *
     * A claim that expired 40 seconds into a minute should not hold the round for the other 20 —
     * the next trigger may arrive inside that window. It is also the only guard on the window
     * between 「claimed」 and 「a supervisor turn exists」, and that window is where a turn can die.
     */
    try {
      const expired = expireTriggerClaims(deps, now.getTime(), {
        busy: (task) => {
          // The lock holder here is a `pending:` placeholder, which is not a session — asking
          // `isBusy` about it always answers 「no」, so the turn that is still working lost its
          // claim 3 minutes in. The supervisor is the session that matters.
          const supervisor = task.supervisorSessionId;
          return Boolean(supervisor && deps.isBusy(supervisor));
        },
        claimMs: TRIGGER_CLAIM_MS,
      });
      if (expired > 0) log.info(`[task-scheduler] expired ${expired} stale trigger claim(s)`);
    } catch (error) {
      log.warn('[task-scheduler] claim expiry failed', { error });
    }

    // A slow tick must not double-fire the same minute.
    if (minute === lastMinute) return;
    lastMinute = minute;
    /**
     * One line a minute, so 「is the loop alive」 is answerable.
     *
     * Nothing else here logs on success — a claim that works is silent by design — which meant a
     * stalled loop and an idle one looked identical in the log. This is the cheapest way to tell
     * them apart, and it is one line.
     */
    log.debug(`[task-scheduler] tick ${minute}`);
    void runCronPass(deps, now).catch((error) => {
      log.warn('[task-scheduler] cron pass failed', { error });
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
