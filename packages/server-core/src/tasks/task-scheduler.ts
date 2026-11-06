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
import { matchesCron } from '@craft-agent/shared/automations/cron-matcher';
import { eventTriggerMatches, type Task } from '@craft-agent/shared/tasks';
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

/** One cron pass. `at` is the minute boundary being evaluated. */
export async function runCronPass(deps: TaskRunnerDeps, at: Date): Promise<number> {
  let started = 0;
  for (const task of deps.listTasks()) {
    const trigger = task.trigger;
    if (!trigger || trigger.kind !== 'cron' || !trigger.enabled) continue;
    if (task.status === 'completed' || task.status === 'canceled') continue;
    if (!matchesCron(trigger.expr, trigger.timezone, at)) continue;

    if (await startTask(deps, task, `cron:${trigger.expr}`)) started += 1;
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
    if (!eventTriggerMatches(task.trigger, event)) continue;

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

/**
 * Start the cron loop. Returns a disposer.
 *
 * `unref` so a pending timer never keeps the host process alive on shutdown.
 */
export function startTaskScheduler(deps: TaskRunnerDeps, intervalMs = TASK_SCHEDULER_INTERVAL_MS): () => void {
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
