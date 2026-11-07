/**
 * Task service — the only place that mutates a task.
 *
 * The supervisor's tools, the worker's `report_result`, the RPC layer and the
 * scheduler all funnel through here so the state machine, the budget check, the
 * dependency gate, the run lock and the failure fuse are applied consistently.
 * Pure rules live in `@craft-agent/shared/tasks`.
 */

import { existsSync, statSync } from 'fs';
import { createLogger } from '@craft-agent/shared/utils';

const log = createLogger('tasks');
import {
  acceptanceItems,
  applyTransition,
  attachSession,
  checkBudget,
  checkDependencies,
  checkHandoffRules,
  createTask,
  deleteTask,
  isHeartbeatMissing,
  isNewRevision,
  isRunLocked,
  loadTask,
  nextTaskId,
  normalizeHandoff,
  recordRunResult,
  saveTask,
  shouldTripFuse,
  appendJournal,
  listTasks,
  activeTasks,
  assessDecisionRequest,
  applyPlanPatch,
  DECISION_TIMEOUT_MS,
  TERMINAL_STATUSES,
  type PlanStepStatus,
  type ArtifactProbe,
  type Handoff,
  type Task,
  type TaskAcceptanceVerdict,
  type TaskSpec,
  type TaskStatus,
  type TaskTrigger,
} from '@craft-agent/shared/tasks';

export interface TaskServiceDeps {
  workspaceRoot: string;
  /** Session ids that currently exist (for process-lost detection). */
  sessionExists: (sessionId: string) => boolean;
  /** Wake the owning supervisor with a one-line nudge. */
  wakeSupervisor: (sessionId: string, text: string) => void;
  /** Run one acceptance command; resolves to exit code + output tail. */
  runAcceptanceCommand?: (command: string, cwd?: string) => Promise<{ exitCode: number | null; output?: string }>;
  /**
   * Second acceptance layer: a read-only model call that judges the handoff
   * against `verify.requirement`. Only consulted when the deterministic rules
   * already passed, so a cheap failure never costs a model call.
   */
  judgeHandoff?: (task: Task, handoff: Handoff) => Promise<{ pass: boolean; reasons: string[] }>;
  now?: () => number;
  /** Id generator (tests inject a stable one). */
  newId?: () => string;
}

/** A task that keeps handing off in one session gets a fresh one. */
export const MAX_HANDOFFS_PER_SESSION = 4;

/** Context use above which the next run starts cold. */
export const ROTATE_CONTEXT_THRESHOLD = 0.7;

export interface CreateTaskRequest {
  name: string;
  instruction: string;
  supervisorSessionId: string;
  toolCallId: string;
  assigneeAgentId?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  priority?: Task['priority'];
  spec?: TaskSpec;
  trigger?: TaskTrigger;
  deadline?: number | null;
}

export type StartRunResult =
  | { ok: true; task: Task }
  | { ok: false; reason: string };

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

  /**
   * Delete a finished task for good.
   *
   * Refused while the task is still live: a running task has a session writing
   * to its journal, and removing the file underneath a worker turns a working
   * task into a stream of "task not found" the user cannot explain. Cancel it
   * first — cancellation is the operation that stops the work; deletion only
   * clears the record afterwards.
   */
  remove(id: string): { ok: boolean; reason?: string } {
    const task = this.get(id);
    if (!task) return { ok: true };
    if (!TERMINAL_STATUSES.includes(task.status)) {
      return {
        ok: false,
        reason: `${task.status} 的任务不能直接删除，先取消它（还有会话正在写这条任务的记录）`,
      };
    }
    deleteTask(this.root, id);
    log.info(`[tasks] deleted ${id}`);
    return { ok: true };
  }

  list(status?: TaskStatus): Task[] {
    return status ? listTasks(this.root).filter((t) => t.status === status) : listTasks(this.root);
  }

  /** Active tasks only — what the supervisor keeps in context. */
  active(): Task[] {
    return activeTasks(this.root);
  }

  /** Find a task by name (used by triggers that reference a task by label). */
  findByName(name: string): Task | null {
    return listTasks(this.root).find((t) => t.name === name) ?? null;
  }

  /**
   * Move a task, applying the fuse, budget and dependency gate before a
   * `running` transition so a task can never be started into a state it has
   * already exhausted or does not yet own.
   */
  setStatus(id: string, status: TaskStatus, options?: { pauseReason?: Task['pauseReason']; error?: string }): Task {
    const task = this.require(id);
    const now = this.now();

    if (status === 'running') {
      const blocked = this.startGate(task, now);
      if (blocked) {
        const paused = applyTransition(task, 'paused', {
          now,
          pauseReason: blocked.pauseReason,
          error: blocked.reason,
        }).task;
        saveTask(this.root, paused);
        appendJournal(this.root, id, { type: 'paused', at: now, data: { reason: blocked.reason } });
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

  /**
   * Everything that must hold before a run starts.
   *
   * Returns null when the task may run, or the reason it may not. Budget and
   * dependencies are checked here — not in the prompt — because a supervisor
   * that forgets is indistinguishable from a supervisor that was never told.
   */
  private startGate(task: Task, now: number): { pauseReason: Task['pauseReason']; reason: string } | null {
    if (isRunLocked(task, this.deps.sessionExists)) {
      return { pauseReason: 'waiting', reason: `run already owned by ${task.stats?.lockSessionId}` };
    }

    const deps = checkDependencies(task, (id) => this.get(id));
    if (!deps.ok) {
      return { pauseReason: 'waiting', reason: deps.reasons.join('; ') };
    }

    const verdict = checkBudget(
      task.budget,
      {
        sessions: task.sessionIds.length,
        runs: task.stats?.runs ?? 0,
        activeMinutes: Math.floor((task.stats?.activeMs ?? 0) / 60_000),
      },
      now,
    );
    if (verdict.exceeded) return { pauseReason: 'budget', reason: verdict.reason };

    if (shouldTripFuse(task.lifecycle)) {
      return { pauseReason: 'failures', reason: 'consecutive failures' };
    }
    return null;
  }

  /**
   * Claim the run lock.
   *
   * The scheduler and the supervisor can both decide to start the same task at
   * the same moment; the lock is what stops two workers from doing it twice.
   */
  startRun(id: string, sessionId: string): StartRunResult {
    const task = this.require(id);
    const now = this.now();
    const blocked = this.startGate(task, now);
    if (blocked) return { ok: false, reason: blocked.reason };

    let next: Task = {
      ...task,
      status: 'running',
      pauseReason: null,
      currentSessionId: sessionId,
      sessionIds: task.sessionIds.includes(sessionId) ? task.sessionIds : [...task.sessionIds, sessionId],
      stats: {
        runs: (task.stats?.runs ?? 0) + 1,
        activeMs: task.stats?.activeMs ?? 0,
        lastHeartbeatAt: now,
        lockSessionId: sessionId,
        runStartedAt: now,
        lastTriggeredAt: now,
      },
      updatedAt: now,
    };
    if (task.status === 'paused') {
      next = { ...next, lifecycle: { ...task.lifecycle, lastRecoveredAt: now } };
    }
    saveTask(this.root, next);
    appendJournal(this.root, id, { type: 'run_started', at: now, data: { sessionId } });
    return { ok: true, task: next };
  }

  /**
   * Resolve an unanswered decision request with the safe answer.
   *
   * The task stays paused (it must not resume on silence); what this records is
   * *why* it will not resume, so the inbox does not show a request forever.
   */
  denyDecision(id: string, note: string): Task {
    const task = this.require(id);
    const now = this.now();
    const decision = task.decision;
    if (!decision) return task;
    const next: Task = {
      ...task,
      decision: {
        ...decision,
        resolvedAt: now,
        resolution: 'timeout',
        reason: note,
      },
      lifecycle: { ...task.lifecycle, lastError: note },
      updatedAt: now,
    };
    saveTask(this.root, next);
    appendJournal(this.root, id, { type: 'decision_timeout', at: now, data: { note } });
    return next;
  }

  /** Record the user's answer to a decision request. */
  resolveDecision(id: string, resolution: 'approved' | 'rejected'): Task {
    const task = this.require(id);
    const now = this.now();
    if (!task.decision) return task;
    const next: Task = {
      ...task,
      decision: { ...task.decision, resolvedAt: now, resolution },
      updatedAt: now,
    };
    saveTask(this.root, next);
    appendJournal(this.root, id, { type: 'decision_resolved', at: now, data: { resolution } });
    return next;
  }

  /**
   * Apply one step-level change to the task's plan.
   *
   * Returns the reason when nothing changed, so a worker that mistyped a step id
   * finds out immediately instead of assuming progress was recorded.
   */
  updatePlan(
    id: string,
    patch: { id: string; status?: PlanStepStatus; title?: string; note?: string; agent?: string; remove?: boolean },
  ): { ok: boolean; error?: string; plan?: Task['spec'] extends undefined ? never : NonNullable<Task['spec']>['plan'] } {
    const task = this.require(id);
    const now = this.now();
    const result = applyPlanPatch(task.spec?.plan, patch, now);
    if (result.error) return { ok: false, error: result.error };
    if (!result.changed) return { ok: true, plan: result.plan };

    const next: Task = {
      ...task,
      spec: { ...(task.spec ?? {}), plan: result.plan },
      updatedAt: now,
    };
    saveTask(this.root, next);
    appendJournal(this.root, id, {
      type: 'plan_updated',
      at: now,
      data: { step: patch.id, status: patch.status, agent: patch.agent, removed: patch.remove === true },
    });
    return { ok: true, plan: result.plan };
  }

  /**
   * Record that one or more cron minutes elapsed while the app was closed.
   *
   * Journal only: the task itself is untouched, because the policy is skip —
   * losing the evidence would be the only real mistake.
   */
  recordCronGap(
    id: string,
    gap: {
      missed: number;
      firstMissedAt?: number;
      lastMissedAt?: number;
      expr: string;
      at: number;
    },
  ): void {
    appendJournal(this.root, id, {
      type: 'cron_missed',
      at: gap.at,
      data: {
        missed: gap.missed,
        firstMissedAt: gap.firstMissedAt,
        lastMissedAt: gap.lastMissedAt,
        expr: gap.expr,
        policy: 'skip',
      },
    });
  }

  /**
   * Release the lock and bank the active time.
   *
   * Called when a run ends for any reason — handoff, failure, or the session
   * disappearing. Without this the lock leaks and the task can never restart.
   */
  endRun(id: string, outcome: { ok: boolean; error?: string; sessionId?: string }): Task {
    const task = this.require(id);
    const now = this.now();
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const elapsed = stats.runStartedAt ? Math.max(0, now - stats.runStartedAt) : 0;

    const next: Task = {
      ...task,
      stats: {
        ...stats,
        activeMs: stats.activeMs + elapsed,
        lockSessionId: undefined,
        runStartedAt: undefined,
        lastHeartbeatAt: now,
      },
      lastHeartbeatAt: now,
      lifecycle: recordRunResult(task.lifecycle, outcome.ok, now, outcome.error),
      updatedAt: now,
    };
    saveTask(this.root, next);
    appendJournal(this.root, id, {
      type: 'run_ended',
      at: now,
      data: { ok: outcome.ok, activeMs: elapsed, error: outcome.error },
    });
    return next;
  }

  /** Prove the task is alive. Called on every tool result and turn boundary. */
  heartbeat(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const next: Task = {
      ...task,
      lastHeartbeatAt: now,
      stats: { ...stats, lastHeartbeatAt: now },
      updatedAt: now,
    };
    saveTask(this.root, next);
    return next;
  }

  /** Heartbeat by session — the worker knows its session id, not its task id. */
  heartbeatForSession(sessionId: string): Task | null {
    const task = listTasks(this.root).find(
      (t) => t.status === 'running' && (t.stats?.lockSessionId === sessionId || t.currentSessionId === sessionId),
    );
    if (!task) return null;
    return this.heartbeat(task.id);
  }

  attachSession(id: string, sessionId: string): Task {
    const task = attachSession(this.require(id), sessionId, this.now());
    saveTask(this.root, task);
    appendJournal(this.root, id, { type: 'assigned', at: this.now(), data: { sessionId } });
    return task;
  }

  /**
   * Record what this task is responsible for, without disturbing the rest of the
   * spec.
   *
   * `updateSpec` replaces the whole contract, so calling it to set one sentence
   * would silently drop cwd, tools and acceptance. Scope arrives separately from
   * the other spec fields (a dispatch supplies it), so it needs its own door.
   */
  setScope(id: string, scope: string | undefined): Task {
    const task = this.require(id)
    const trimmed = scope?.trim()
    if (!trimmed) return task
    if (task.spec?.scope === trimmed) return task
    return this.updateSpec(id, { ...task.spec, scope: trimmed })
  }

  updateSpec(id: string, spec: TaskSpec): Task {
    const task = this.require(id);
    const next: Task = { ...task, spec, updatedAt: this.now() };
    saveTask(this.root, next);
    appendJournal(this.root, id, { type: 'spec_updated', at: this.now(), data: { spec } });
    return next;
  }

  updateTrigger(id: string, trigger: TaskTrigger): Task {
    const task = this.require(id);
    const next: Task = { ...task, trigger, updatedAt: this.now() };
    saveTask(this.root, next);
    appendJournal(this.root, id, { type: 'trigger_updated', at: this.now(), data: { trigger } });
    return next;
  }

  /** Does this task's declared deliverables require at least one artifact? */
  private requiredDeliverables(spec: TaskSpec | undefined) {
    return (spec?.deliverables ?? []).filter((d) => d.required !== false);
  }

  /**
   * Record a worker's handoff and decide whether the task can complete.
   *
   * Two layers, in order: deterministic rules (artifacts readable, verification
   * ran, acceptance commands pass), then the task is allowed to complete. The
   * worker's own `verify.passed` is necessary but never sufficient — acceptance
   * commands are executed here, by us.
   */
  async reportHandoff(id: string, raw: unknown, fromSessionId: string, options?: {
    /** Worker context use (0..1), when the caller knows it. */
    contextUtilization?: number;
  }): Promise<{
    task: Task;
    handoff: Handoff;
    passed: boolean;
    reasons: string[];
    /** True when the session should be compacted before the next turn. */
    compactionPending: boolean;
  }> {
    const task = this.require(id);
    const now = this.now();
    const handoff = normalizeHandoff(raw, fromSessionId, now);

    const acceptance = await this.runAcceptance(task);
    const verdict = checkHandoffRules(handoff, (path) => this.probe(path), {
      requiredDeliverables: this.requiredDeliverables(task.spec),
      ...(acceptance ? { acceptance } : {}),
    });

    // A `delivered` handoff still has to pass the gate: "it says it is done" is
    // not evidence. `needs_decision` bypasses the gate and pauses instead.
    let accepted = handoff.outcome === 'needs_decision' ? false : verdict.passed;
    const reasons = [...verdict.reasons];

    // Second layer: a requirement the commands cannot express is judged by a
    // model that only reads — never by the worker that wrote the handoff, and
    // only after the cheap rules passed.
    if (accepted && task.verify.requirement && this.deps.judgeHandoff) {
      try {
        const judged = await this.deps.judgeHandoff(task, handoff);
        if (!judged.pass) {
          accepted = false;
          reasons.push(...(judged.reasons.length ? judged.reasons : ['acceptance requirement not met']));
        }
      } catch (error) {
        // A judge that cannot run must not silently pass the task.
        accepted = false;
        reasons.push(`judge unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Context pressure is answered with compaction, not with a new session.
    //
    // The session is the thread: rotating throws away everything the summary
    // could not express (which file, which line, what was tried and failed) and
    // then pays to re-inject the brief into a fresh window. Auto-compaction is
    // already on for every session and its summary prompt explicitly preserves
    // exact paths, function names and error messages, so compacting keeps the
    // work *and* the room. Rotation survives only for the case where compaction
    // itself cannot run, which the caller detects.
    const contextUtilization = options?.contextUtilization ?? 0;
    const compactionPending =
      accepted &&
      handoff.outcome === 'handoff' &&
      contextUtilization >= ROTATE_CONTEXT_THRESHOLD;

    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const elapsed = stats.runStartedAt ? Math.max(0, now - stats.runStartedAt) : 0;

    let next: Task = {
      ...task,
      handoffs: [...task.handoffs, handoff],
      lastHeartbeatAt: now,
      updatedAt: now,
      stats: {
        ...stats,
        activeMs: stats.activeMs + elapsed,
        lockSessionId: undefined,
        runStartedAt: undefined,
        lastHeartbeatAt: now,
      },
      lifecycle: recordRunResult(task.lifecycle, accepted, now, accepted ? undefined : reasons.join('; ')),
      verify: {
        ...task.verify,
        lastVerdict: accepted ? 'pass' : 'fail',
        ...(handoff.revision ? { lastVerifiedRevision: handoff.revision } : {}),
      },
      // Every handoff round counts, so `maxIterations` is no longer decorative —
      // except across a revision boundary, where the previous rounds were spent
      // judging a different object.
      verifyRounds: isNewRevision(task.verify, handoff.revision)
        ? 1
        : (task.verifyRounds ?? 0) + 1,
    };

    if (handoff.outcome === 'needs_decision') {
      // Not every request deserves the user's attention. The gate is a closed
      // list of six irreversible categories; anything routine continues on its
      // own, because a noisy inbox gets ignored and then it is not a gate at all.
      const assessment = assessDecisionRequest(handoff.summary, {
        commands: handoff.verify?.ran,
        paths: handoff.artifacts?.map((artifact) => artifact.path),
      });
      if (assessment.needsUser) {
        next = applyTransition(next, 'paused', { now, pauseReason: 'needs_decision' }).task;
        next = {
          ...next,
          decision: {
            category: assessment.category ?? 'unspecified',
            label: assessment.label ?? '需要拍板',
            reason: assessment.reason,
            askedAt: now,
            // Default-deny deadline: silence must not read as consent.
            deadlineAt: now + DECISION_TIMEOUT_MS,
          },
        };
      } else {
        appendJournal(this.root, id, {
          type: 'decision_routine',
          at: now,
          data: { summary: handoff.summary, reason: assessment.reason },
        });
      }
    } else if (accepted && handoff.outcome === 'delivered') {
      next = applyTransition(next, 'completed', { now }).task;
    } else if (!accepted && shouldTripFuse(next.lifecycle)) {
      next = applyTransition(next, 'paused', { now, pauseReason: 'failures' }).task;
    }

    saveTask(this.root, next);
    appendJournal(this.root, id, {
      type: 'handoff',
      at: now,
      data: {
        outcome: handoff.outcome,
        passed: accepted,
        reasons,
        acceptance: acceptance?.results,
        ...(compactionPending ? { compactionPending: true } : {}),
      },
    });

    // Only the supervisor decides what the user sees; the worker never does.
    this.deps.wakeSupervisor(
      next.supervisorSessionId,
      accepted
        ? `${id} 交接通过：${handoff.summary}`
        : `${id} 交接未通过（${reasons.join('；') || handoff.outcome}）：${handoff.summary}`,
    );

    return { task: next, handoff, passed: accepted, reasons, compactionPending };
  }

  /** Existence + readability + non-emptiness, in one probe. */
  private probe(path: string): ArtifactProbe {
    try {
      if (!existsSync(path)) return { exists: false, nonEmpty: false };
      const stat = statSync(path);
      if (stat.isDirectory()) return { exists: true, nonEmpty: true, isDirectory: true };
      return { exists: true, nonEmpty: stat.size > 0 };
    } catch {
      return { exists: false, nonEmpty: false };
    }
  }

  /**
   * Execute the task's acceptance commands.
   *
   * Returns null when the task declares no commands (pure rule gate), so the
   * caller can tell "nothing to check" from "everything passed".
   */
  private async runAcceptance(task: Task): Promise<TaskAcceptanceVerdict | null> {
    const items = acceptanceItems(task.spec);
    const withCommands = items.filter((item) => item.command?.trim());
    if (!withCommands.length) return null;
    if (!this.deps.runAcceptanceCommand) {
      return {
        checked: withCommands.length,
        failures: ['acceptance runner is unavailable'],
        results: withCommands.map((item) => ({ id: item.id, passed: false, note: 'runner unavailable' })),
      };
    }

    const cwd = task.spec?.cwd;
    const failures: string[] = [];
    const results: TaskAcceptanceVerdict['results'] = [];

    for (const item of withCommands) {
      try {
        const result = await this.deps.runAcceptanceCommand(item.command!, cwd);
        const passed = result.exitCode === 0;
        results.push({
          id: item.id,
          passed,
          note: passed ? undefined : `exit ${result.exitCode ?? 'null'}${result.output ? `: ${result.output.slice(0, 200)}` : ''}`,
        });
        if (!passed) {
          failures.push(`acceptance failed: ${item.id}${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ id: item.id, passed: false, note: message });
        failures.push(`acceptance failed: ${item.id} (${message})`);
      }
    }

    return { checked: withCommands.length, failures, results };
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
      const lockId = task.stats?.lockSessionId ?? task.currentSessionId;
      const alive = lockId ? this.deps.sessionExists(lockId) : false;
      if (alive) {
        if (isHeartbeatMissing(task, now)) {
          const paused = this.pauseAfterLoss(task, now, 'heartbeat_stalled', lockId);
          recovered.push(paused);
        }
        continue;
      }
      recovered.push(this.pauseAfterLoss(task, now, 'process_lost', lockId));
    }
    return recovered;
  }

  private pauseAfterLoss(task: Task, now: number, reason: string, lockId?: string): Task {
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const elapsed = stats.runStartedAt ? Math.max(0, now - stats.runStartedAt) : 0;
    const base: Task = {
      ...task,
      stats: {
        ...stats,
        activeMs: stats.activeMs + elapsed,
        lockSessionId: undefined,
        runStartedAt: undefined,
      },
    };
    const paused = applyTransition(base, 'paused', { now, pauseReason: 'process_lost' }).task;
    saveTask(this.root, paused);
    appendJournal(this.root, task.id, {
      type: 'paused',
      at: now,
      data: { reason, sessionId: lockId },
    });
    return paused;
  }

  private require(id: string): Task {
    const task = loadTask(this.root, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
