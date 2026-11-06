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
  shouldTripFuse,
  type Task,
} from '@craft-agent/shared/tasks';

const log = createLogger('watchdog');

export type WatchdogFinding =
  | { kind: 'stalled'; task: Task }
  | { kind: 'failing'; task: Task }
  | { kind: 'overdue'; task: Task }
  | { kind: 'orphaned'; task: Task }
  | { kind: 'decision_timeout'; task: Task }
  | { kind: 'looping'; task: Task };

export interface WatchdogDeps {
  /** Tasks to inspect (already filtered to the workspace). */
  listTasks: () => Task[];
  /** True while the task's current session exists. */
  sessionExists: (sessionId: string) => boolean;
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

/** Strip whitespace so a reformatted repeat still counts as a repeat. */
function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, '').trim();
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
  const timer = setInterval(() => {
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
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
