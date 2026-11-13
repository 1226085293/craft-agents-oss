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

const log = createLogger('task-scheduler');

export interface TaskRunnerDeps {
  /** All tasks (the scheduler filters by trigger). */
  listTasks: () => Task[];
  /** The service that owns the run lock and the journal. */
  tasks: TaskService;
  /**
   * Spawn the worker for a claimed run. Must return the created session id.
   * Called only after the lock is held, so it may assume exclusivity.
   */
  spawnRun: (task: Task, reason: string) => Promise<{ sessionId: string } | null>;
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
 * Claim and spawn one run.
 *
 * A failed gate is not an error: a task that is already running, waiting on a
 * dependency or out of budget is simply skipped, and the reason is in the
 * journal written by the service.
 */
async function startTask(deps: TaskRunnerDeps, task: Task, reason: string): Promise<boolean> {
  // Two triggers can fire for the same task in one pass; the lock is claimed
  // before spawning, so the second attempt sees it and stops.
  const claim = deps.tasks.startRun(task.id, `pending:${reason}`);
  if (!claim.ok) {
    log.info(`[task-scheduler] ${task.id} not started: ${claim.reason}`);
    return false;
  }

  try {
    const spawned = await deps.spawnRun(claim.task, reason);
    if (!spawned) {
      // Nothing was created: release the lock so the next tick can retry.
      deps.tasks.endRun(task.id, { ok: false, error: 'spawn failed' });
      return false;
    }
    deps.tasks.attachSession(task.id, spawned.sessionId);
    deps.tasks.startRun(task.id, spawned.sessionId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[task-scheduler] failed to spawn ${task.id}`, { error: message });
    deps.tasks.endRun(task.id, { ok: false, error: message });
    return false;
  }
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
    // A slow tick must not double-fire the same minute.
    if (minute === lastMinute) return;
    lastMinute = minute;
    void runCronPass(deps, now).catch((error) => {
      log.warn('[task-scheduler] cron pass failed', { error });
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
