/**
 * Task service — the only place that mutates a task.
 *
 * The supervisor's tools, the worker's `report_result`, and the RPC layer all
 * funnel through here so the state machine, the budget check and the failure
 * fuse are applied consistently. Pure rules live in `@craft-agent/shared/tasks`.
 */

import { existsSync } from 'fs';
import { createLogger } from '@craft-agent/shared/utils';

const log = createLogger('tasks');
import {
  applyTransition,
  attachSession,
  checkBudget,
  checkHandoffRules,
  createTask,
  isHeartbeatStalled,
  loadTask,
  nextTaskId,
  normalizeHandoff,
  recordRunResult,
  saveTask,
  shouldTripFuse,
  appendJournal,
  listTasks,
  activeTasks,
  type Handoff,
  type Task,
  type TaskStatus,
} from '@craft-agent/shared/tasks';

export interface TaskServiceDeps {
  workspaceRoot: string;
  /** Session ids that currently exist (for process-lost detection). */
  sessionExists: (sessionId: string) => boolean;
  /** Wake the owning supervisor with a one-line nudge. */
  wakeSupervisor: (sessionId: string, text: string) => void;
  now?: () => number;
}

export interface CreateTaskRequest {
  name: string;
  instruction: string;
  supervisorSessionId: string;
  toolCallId: string;
  assigneeAgentId?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  priority?: Task['priority'];
}

export class TaskService {
  private readonly now: () => number;

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private get root(): string {
    return this.deps.workspaceRoot;
  }

  create(request: CreateTaskRequest): Task {
    // Dedupe on the originating tool call: a retried tool invocation must not
    // create a second task for the same request.
    const existing = listTasks(this.root).find(
      (task) =>
        task.origin.toolCallId === request.toolCallId &&
        task.origin.supervisorSessionId === request.supervisorSessionId,
    );
    if (existing) return existing;

    const task = createTask({
      ...request,
      id: nextTaskId(this.root),
      now: this.now(),
    });
    saveTask(this.root, task);
    appendJournal(this.root, task.id, { type: 'created', at: task.createdAt, data: { name: task.name } });
    log.info(`[tasks] created ${task.id} (${task.name})`);
    return task;
  }

  get(id: string): Task | null {
    return loadTask(this.root, id);
  }

  list(status?: TaskStatus): Task[] {
    return status ? listTasks(this.root).filter((t) => t.status === status) : listTasks(this.root);
  }

  /** Active tasks only — what the supervisor keeps in context. */
  active(): Task[] {
    return activeTasks(this.root);
  }

  /**
   * Move a task, applying the fuse and budget before a `running` transition so a
   * task can never be started into a state it has already exhausted.
   */
  setStatus(id: string, status: TaskStatus, options?: { pauseReason?: Task['pauseReason']; error?: string }): Task {
    const task = this.require(id);
    const now = this.now();

    if (status === 'running') {
      const verdict = checkBudget(task.budget, {
        sessions: task.sessionIds.length,
        runs: task.verifyRounds ?? 0,
        activeMinutes: task.budget.activeMinutes,
      }, now);
      if (verdict.exceeded) {
        const paused = applyTransition(task, 'paused', { now, pauseReason: 'budget', error: verdict.reason }).task;
        saveTask(this.root, paused);
        appendJournal(this.root, id, { type: 'paused', at: now, data: { reason: verdict.reason } });
        return paused;
      }
      if (shouldTripFuse(task.lifecycle)) {
        const paused = applyTransition(task, 'paused', { now, pauseReason: 'failures' }).task;
        saveTask(this.root, paused);
        return paused;
      }
    }

    const result = applyTransition(task, status, {
      now,
      pauseReason: options?.pauseReason,
      error: options?.error,
    });
    if (!result.changed) return result.task;

    saveTask(this.root, result.task);
    appendJournal(this.root, id, {
      type: 'status',
      at: now,
      data: { from: task.status, to: status, reason: options?.pauseReason },
    });
    return result.task;
  }

  attachSession(id: string, sessionId: string): Task {
    const task = attachSession(this.require(id), sessionId, this.now());
    saveTask(this.root, task);
    appendJournal(this.root, id, { type: 'assigned', at: this.now(), data: { sessionId } });
    return task;
  }

  /**
   * Record a worker's handoff and decide whether the task can complete.
   *
   * The rule gate is mandatory; the acceptance requirement (if any) is the
   * second layer and is evaluated elsewhere. A handoff that fails the gate
   * leaves the task running and wakes the supervisor with the reasons.
   */
  reportHandoff(id: string, raw: unknown, fromSessionId: string): {
    task: Task;
    handoff: Handoff;
    passed: boolean;
    reasons: string[];
  } {
    const task = this.require(id);
    const now = this.now();
    const handoff = normalizeHandoff(raw, fromSessionId, now);

    const verify = handoff.verify;
    const verdict = checkHandoffRules(handoff, (path) => existsSync(path));

    // A `delivered` handoff still has to pass the gate: "it says it is done" is
    // not evidence. `needs_decision` bypasses the gate and pauses instead.
    const accepted = handoff.outcome === 'needs_decision' ? false : verdict.passed;

    let next: Task = {
      ...task,
      handoffs: [...task.handoffs, handoff],
      lastHeartbeatAt: now,
      updatedAt: now,
      lifecycle: recordRunResult(task.lifecycle, accepted, now, accepted ? undefined : verdict.reasons.join('; ')),
      verify: { ...task.verify, lastVerdict: accepted ? 'pass' : 'fail' },
    };

    if (handoff.outcome === 'needs_decision') {
      next = applyTransition(next, 'paused', { now, pauseReason: 'needs_decision' }).task;
    } else if (accepted && handoff.outcome === 'delivered') {
      next = applyTransition(next, 'completed', { now }).task;
    } else if (!accepted && shouldTripFuse(next.lifecycle)) {
      next = applyTransition(next, 'paused', { now, pauseReason: 'failures' }).task;
    }

    saveTask(this.root, next);
    appendJournal(this.root, id, {
      type: 'handoff',
      at: now,
      data: { outcome: handoff.outcome, passed: accepted, reasons: verdict.reasons },
    });

    // Only the supervisor decides what the user sees; the worker never does.
    this.deps.wakeSupervisor(
      next.supervisorSessionId,
      accepted
        ? `${id} 交接通过：${handoff.summary}`
        : `${id} 交接未通过（${verdict.reasons.join('；') || handoff.outcome}）：${handoff.summary}`,
    );

    return { task: next, handoff, passed: accepted, reasons: verdict.reasons };
  }

  /** Heartbeat: proves the task is alive, independent of any single turn. */
  heartbeat(id: string): Task {
    const task = this.require(id);
    const next = { ...task, lastHeartbeatAt: this.now(), updatedAt: this.now() };
    saveTask(this.root, next);
    return next;
  }

  /**
   * Startup sweep: a task left `running` whose session is gone did not fail —
   * the process disappeared under it. Mark it resumable instead of dead.
   */
  recoverAfterRestart(): Task[] {
    const now = this.now();
    const recovered: Task[] = [];
    for (const task of listTasks(this.root)) {
      if (task.status !== 'running') continue;
      const alive = task.currentSessionId ? this.deps.sessionExists(task.currentSessionId) : false;
      if (alive) {
        if (isHeartbeatStalled(task, now)) {
          const paused = applyTransition(task, 'paused', { now, pauseReason: 'process_lost' }).task;
          saveTask(this.root, paused);
          appendJournal(this.root, task.id, { type: 'paused', at: now, data: { reason: 'heartbeat_stalled' } });
          recovered.push(paused);
        }
        continue;
      }
      const paused = applyTransition(task, 'paused', { now, pauseReason: 'process_lost' }).task;
      saveTask(this.root, paused);
      appendJournal(this.root, task.id, { type: 'paused', at: now, data: { reason: 'process_lost' } });
      recovered.push(paused);
    }
    return recovered;
  }

  private require(id: string): Task {
    const task = loadTask(this.root, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
