/**
 * Task service — the only place that mutates a task.
 *
 * The supervisor's tools, the worker's `report_result`, the RPC layer and the
 * scheduler all funnel through here so the state machine, the budget check, the
 * dependency gate, the run lock and the failure fuse are applied consistently.
 * Pure rules live in `@craft-agent/shared/tasks`.
 */

import { existsSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { createLogger } from '@craft-agent/shared/utils';

const log = createLogger('tasks');
import {
  acceptanceItems,
  applyTransition,
  authorizedStepsFromAnswer,
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
  nextLeg,
  currentStep,
  recordRunResult,
  saveTask,
  shouldTripFuse,
  appendJournal,
  listTasks,
  activeTasks,
  assessDecisionRequest,
  applyPlanPatch,
  planProgress,
  childrenOf,
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
  /**
   * Start the next section's owner on a task, without going through the
   * supervisor's conversation.
   *
   * Why not just wake the supervisor and let it dispatch: that queue is the same
   * one the user talks to. With several tasks handing off, every hand-off would
   * put a message in front of the user's next sentence, and the delay would grow
   * with the number of tasks — the busier the work, the slower the human. The
   * decision itself is a lookup in the plan, so it does not need a model either.
   */
  startNextLeg?: (task: Task, agent: string | undefined) => Promise<boolean>;
  /**
   * Stop the session that is working on a task.
   *
   * Pausing a task used to change a field and nothing else. Observed on the first
   * real run: T-9 was paused for failures at handoff #3 and kept reporting —
   * handoffs #4 through #7 arrived after the pause, one of them finished a plan
   * step, and the failure counter climbed to 7 against a limit of 3. A task that
   * says paused while a worker is still editing its plan is two different answers
   * to "is this running".
   */
  stopSession?: (sessionId: string) => void;
  /** Run one acceptance command; resolves to exit code + output tail. */
  runAcceptanceCommand?: (command: string, cwd?: string) => Promise<{ exitCode: number | null; output?: string }>;
  /**
   * Second acceptance layer: a read-only model call that judges the handoff
   * against `verify.requirement`. Only consulted when the deterministic rules
   * already passed, so a cheap failure never costs a model call.
   */
  judgeHandoff?: (task: Task, handoff: Handoff) => Promise<{ pass: boolean; reasons: string[] }>;
  /**
   * Called after any write that a reader could be looking at.
   *
   * The board used to refresh only when an RPC handler broadcast, which meant every write
   * made through a TOOL was invisible until something else happened. Observed: sitting on
   * the task page, a decision card never appeared — the worker had paused the task through
   * `report_result`, `TaskService` saved it, and no one told the renderer. Same for plan
   * steps: `task_plan` moved them and the page kept showing the old status.
   *
   * Fired from the service rather than from each RPC because the service is the only place
   * every write passes through.
   */
  onChanged?: () => void;
  now?: () => number;
  /** Id generator (tests inject a stable one). */
  newId?: () => string;
}

/** A task that keeps handing off in one session gets a fresh one. */
export const MAX_HANDOFFS_PER_SESSION = 4;

/**
 * How many consecutive hand-offs with no plan movement count as "spinning".
 *
 * Three, not two: one unproductive round is ordinary (a command failed, a path was
 * wrong). Three in a row with nothing marked done is a pattern.
 */
export const SPIN_LIMIT = 3;

/**
 * Is the task going nowhere despite reporting?
 *
 * Measured on the plan, not on the text of the reports: "still working" is what a
 * worker says whether it is making progress or not. A step that never reaches `done`
 * across several hand-offs is observable, and it is the thing a person can act on.
 */
export function isSpinningInPlace(task: Task): boolean {
  const plan = task.spec?.plan;
  if (!plan?.length) return false;
  const recent = task.handoffs.slice(-SPIN_LIMIT);
  if (recent.length < SPIN_LIMIT) return false;
  // Every one of them was "someone else must continue", never "done here".
  if (recent.some((handoff) => handoff.outcome !== 'handoff')) return false;
  // And in that stretch the plan did not advance: no step finished after the first
  // of these hand-offs.
  const firstOfRun = recent[0]!.at;
  return !plan.some((step) => step.status === 'done' && (step.updatedAt ?? 0) >= firstOfRun);
}

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
    this.save(task);
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
        this.save(paused);
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

    this.save(result.task);
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

    // `pending:<reason>` and `pending:next-leg:<step>` are placeholders: they hold
    // the run lock while the session is being created, before there is an id. They
    // are not sessions, and treating them as one made the board report "2 / 8" for
    // a task that had started a single worker — the placeholder sat in `sessionIds`
    // (and in `currentSessionId`) for good, because the real id is attached afterwards.
    const isPlaceholder = sessionId.startsWith('pending:');

    let next: Task = {
      ...task,
      status: 'running',
      pauseReason: null,
      ...(isPlaceholder ? {} : { currentSessionId: sessionId }),
      sessionIds: isPlaceholder || task.sessionIds.includes(sessionId)
        ? task.sessionIds
        : [...task.sessionIds, sessionId],
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
    this.save(next);
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
    this.save(next);
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
    this.save(next);
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
  ): {
    ok: boolean;
    error?: string;
    plan?: Task['spec'] extends undefined ? never : NonNullable<Task['spec']>['plan'];
    /**
     * The agent a new session was started for because the plan crossed an
     * ownership boundary. The caller tells the reporting worker to stop.
     */
    handedOffTo?: string;
  } {
    const task = this.require(id);
    const now = this.now();
    const result = applyPlanPatch(task.spec?.plan, patch, now, {
      authorizedSteps: task.spec?.authorizedSteps,
    });
    if (result.error) return { ok: false, error: result.error };
    if (!result.changed) return { ok: true, plan: result.plan };

    let next: Task = {
      ...task,
      spec: { ...(task.spec ?? {}), plan: result.plan },
      updatedAt: now,
    };

    /**
     * Ownership is a boundary, not a label.
     *
     * The plan says which profile owns each step, and until now nothing acted on
     * it: one worker finished section 3.1, turned to 3.2 (owned by another
     * agent), and did it in the same session. The agent column was decoration and
     * "click 3.1, click 3.2" landed in one conversation.
     *
     * Closing a step is the only moment the boundary can be crossed cheaply, so
     * the check happens here: a lookup in the plan, no model call. The next owner
     * gets its own session and the current one is told to stop, which is the
     * difference between a plan that assigns work and a plan that pretends to.
     */
    let handedOffTo: string | undefined;
    if (patch.status === 'done') {
      const leg = nextLeg(result.plan);
      if (leg?.agent && leg.agent !== next.assigneeAgentId && this.deps.startNextLeg) {
        handedOffTo = leg.agent;
        // Record the hand-off on the task before starting it: the new session's
        // own write path reads `assigneeAgentId` to decide whether it is the
        // owner, and leaving it stale would make the next boundary fire on the
        // wrong comparison.
        next = { ...next, assigneeAgentId: handedOffTo };
      }
    }

    this.save(next);
    appendJournal(this.root, id, {
      type: 'plan_updated',
      at: now,
      data: { step: patch.id, status: patch.status, agent: patch.agent, removed: patch.remove === true },
    });

    if (handedOffTo) {
      const agent = handedOffTo;
      appendJournal(this.root, id, {
        type: 'next_leg_started',
        at: now,
        data: { step: patch.id, agent },
      });
      void this.deps
        .startNextLeg!(next, agent)
        .then((started) => {
          if (!started) log.warn(`[tasks] ownership boundary of ${id} not started for ${agent}`);
        })
        .catch((error) => {
          log.warn(`[tasks] could not start ${agent} at the ${id} boundary`, { error: String(error) });
        });
    }

    return { ok: true, plan: result.plan, ...(handedOffTo ? { handedOffTo } : {}) };
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
   * Release the run lock after a pause or cancel, without counting a failure.
   *
   * `endRun` records an outcome, and a pause is not a failure — counting it
   * would let three pauses trip the fuse and strand the task in a state nobody
   * asked for. What a pause does have to do is give the lock back: `isRunLocked`
   * holds it while `lockSessionId` points at a live session, so a paused task
   * would refuse to resume until that session died.
   */
  suspendRun(id: string): Task {
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
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'run_ended',
      at: now,
      data: { ok: true, suspended: true, activeMs: elapsed },
    });
    return next;
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
    this.save(next);
    appendJournal(this.root, id, {
      type: 'run_ended',
      at: now,
      data: { ok: outcome.ok, activeMs: elapsed, error: outcome.error },
    });
    return next;
  }

  /**
   * Let the session that is relaying the question say it in its own words.
   *
   * A task decision is produced by rules — a closed list of six categories — so its
   * text is generic by construction: 「范围内的工作已完成」「未识别为日常操作，交人确认」.
   * The supervisor, reading the same state, writes the actual question (「仅放行 1.2，
   * 其余之后再定？」) and, with `options`, the actual answers.
   *
   * Those were two records of one question, rendered on two surfaces: the chat card had
   * the supervisor's three answers, the task card had none and fell back to 同意/取消 —
   * neither of which was one of the three. Copying the words onto the record the task
   * card reads is what makes them the same question.
   *
   * Deliberately does not touch `status`, `pauseReason`, `askedAt` or `deadlineAt`: this
   * is wording, not a state change. Answering still goes through the same guard.
   */
  setDecisionWording(
    id: string,
    wording: { question?: string; label?: string; options?: string[] },
  ): Task | null {
    const task = this.get(id);
    const decision = task?.decision;
    if (!task || !decision || decision.resolvedAt) return null;

    const options = (wording.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .slice(0, 4);

    const next: Task = {
      ...task,
      decision: {
        ...decision,
        ...(wording.label?.trim() ? { label: wording.label.trim() } : {}),
        // Written to its own field, not over `reason`: the diagnostic sentence is what
        // explains why a person is being asked, and it cannot be reconstructed later.
        ...(wording.question?.trim() ? { question: wording.question.trim() } : {}),
        ...(options.length ? { options } : {}),
      },
      updatedAt: this.now(),
    };
    this.save(next);
    return next;
  }

  /**
   * Record what the person replied to a pending question.
   *
   * Not a resolution: the words still have to be read by the supervisor, which is the
   * only party that can tell 「放行」 from 「到此为止」. Storing them here does two things
   * the chat log cannot — it says WHICH task the words answer, and it lets the card show
   * 「已答复」 after a reload instead of offering the same buttons again.
   *
   * Returns null when there is nothing to answer, so the caller can report "nothing was
   * waiting" rather than silently accepting words no one will read.
   */
  recordDecisionAnswer(id: string, text: string): Task | null {
    const task = this.get(id);
    const decision = task?.decision;
    if (!task || !decision || decision.resolvedAt) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    /**
     * One question, one answer.
     *
     * The card guards this in the renderer with a `sent` flag, and that guard is not
     * enough: two surfaces show the same decision, and a second click can arrive from
     * either — or from a window that never saw the first one's state. Observed on a real
     * run: the supervisor received the same reply twice, 1.6s apart, and read it as two
     * separate instructions. The task is the only party that can decide this, because it
     * is the only one holding the record.
     */
    if (decision.answer) return null;

    const now = this.now();
    /**
     * An answer is the end of the pause, not a note attached to it.
     *
     * The record used to keep `answer` and leave `resolvedAt` empty, on the theory that the
     * supervisor would resolve it after reading. Observed on a real run: the task sat on
     * 「等你拍板」 with the answer already stored, the card was gone because it had been
     * answered, and nothing was left on screen to click. The supervisor that was supposed to
     * close the loop had been rate-limited mid-turn, so the state waited for a turn that
     * never happened.
     *
     * The person has spoken; that IS the resolution. What the words mean is still the
     * supervisor's to interpret when it runs — but the pause ends here.
     */
    /**
     * If the reply states a boundary, record the boundary — not just the words.
     *
     * 「完成 1.2 后暂停」 was answered on a real run, the pause lifted, and the supervisor
     * resumed the task without narrowing anything: the worker ran 1.2, 2 and 2.1 and
     * delivered work the person had asked to stop. Relying on the supervisor to translate
     * the sentence means the boundary exists only if a model turn succeeds, and that turn
     * had already been rate-limited once.
     */
    const derived = authorizedStepsFromAnswer(trimmed, task.spec?.plan)
    const next: Task = {
      ...task,
      ...(derived?.length ? { spec: { ...task.spec, authorizedSteps: derived } as Task['spec'] } : {}),
      decision: { ...decision, answer: { text: trimmed, at: now }, resolvedAt: now, resolution: 'approved' },
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'decision_answered', at: now, data: { text: trimmed } });
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
    this.save(next);
    return next;
  }

  /**
   * Record that the watchdog tried to wake this task's idle session.
   *
   * Kept on the task rather than in the watchdog's memory because the watchdog is
   * restarted with the app, and a counter that resets on every restart would keep
   * waking a permanently stuck worker forever.
   */
  noteWake(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const next: Task = {
      ...task,
      stats: {
        ...stats,
        wakeAttempts: (stats.wakeAttempts ?? 0) + 1,
        lastWakeAt: now,
      },
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'idle_wake', at: now, data: {} });
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
    this.save(task);
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
    this.save(next);
    appendJournal(this.root, id, { type: 'spec_updated', at: this.now(), data: { spec } });
    return next;
  }

  updateTrigger(id: string, trigger: TaskTrigger): Task {
    const task = this.require(id);
    const next: Task = { ...task, trigger, updatedAt: this.now() };
    this.save(next);
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
    /** True when the task no longer exists (deleted from the board). */
    taskGone?: boolean;
  }> {
    // A session outlives its task on purpose — deleting a board entry must not
    // delete the conversation that explains it. So a worker can still report into a
    // task that has since been removed, and throwing there would turn an ordinary
    // end-of-turn into an error the user has to interpret. The report is accepted
    // and simply goes nowhere.
    const existing = this.get(id);
    if (!existing) {
      log.info(`[tasks] handoff for deleted task ${id} from ${fromSessionId} dropped`);
      return {
        task: { id } as Task,
        handoff: normalizeHandoff(raw, fromSessionId, this.now()),
        passed: false,
        reasons: ['任务已删除，这次交接只留在会话记录里'],
        compactionPending: false,
        taskGone: true,
      };
    }

    const task = existing;
    const now = this.now();
    const handoff = normalizeHandoff(raw, fromSessionId, now);

    const acceptance = await this.runAcceptance(task);
    const verdict = checkHandoffRules(handoff, (path) => this.probe(this.resolveArtifactPath(task, path)), {
      requiredDeliverables: this.requiredDeliverables(task.spec),
      ...(acceptance ? { acceptance } : {}),
    });

    // A `delivered` handoff still has to pass the gate: "it says it is done" is
    // not evidence. `needs_decision` bypasses the gate and pauses instead.
    let accepted = handoff.outcome === 'needs_decision' ? false : verdict.passed;
    const reasons = [...verdict.reasons];

    /**
     * "Done" cannot mean "done with the parts I felt like doing".
     *
     * Observed: a worker delivered while `1.2` and `3` were still `todo`, the gate was
     * happy because the artifact existed and the acceptance command passed, and the task
     * closed with a step skipped. The plan then reads as both 2/5 and 已完成, which is not
     * a display glitch — the two facts disagree.
     *
     * The exits matter as much as the rule, and the original pair was wrong. It offered
     * "mark it done with evidence" (a lie, when the step was assigned to someone else) or
     * "remove it". A worker told not to touch `1.2`/`2` did exactly as instructed, hit this
     * gate, and removed both — then wrote in the note that the user had "明确划出本次范围",
     * which nobody had said. Two steps the user explicitly wanted kept were gone, the task
     * closed as completed, and nothing ever ran them.
     *
     * The correct exit already existed in the outcome field and was never named here:
     * `delivered` means the whole task is finished, `handoff` means this leg is finished
     * and the task continues. Naming it costs one sentence; not naming it cost the plan.
     */
    if (handoff.outcome === 'delivered' && accepted) {
      const progress = planProgress(task.spec?.plan);
      if (progress.total > 0 && !progress.complete) {
        const remaining = (task.spec?.plan ?? []).filter(
          (step) => step.status !== 'done' && childrenOf(task.spec?.plan, step.id).length === 0,
        );
        accepted = false;
        reasons.push(
          `计划里还有 ${remaining.length} 步没完成，不能作为“整个任务已完成”交付（delivered）：${remaining.map((step) => `${step.id} ${step.title}`).join('；')}。` +
            '如果你的分配范围只是计划的一部分，用 outcome: "handoff" 交接——任务不会关闭，剩下的步骤留给后绡的会话；' +
            '如果这一步确实做完了，就标 done 并在 note 里写证据；' +
            '只有当计划本身写错了（这一步根本不该存在）才移除它。',
        );
      }
    }

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
            // The worker's own candidates, so the card offers the answers that were
            // actually considered instead of a yes/no that may match none of them.
            ...(handoff.options?.length ? { options: [...handoff.options] } : {}),
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
      this.stopWorker(next);
    } else if (handoff.outcome === 'handoff' && isSpinningInPlace(next)) {
      //
      // "Still working on it" repeated without the plan moving is not progress.
      //
      // A worker that hits a wall does the reasonable thing at every step — try
      // another way, report a hand-off — and the loop never surfaces, because each
      // individual turn ends cleanly and lands in the timeline as a report. Observed
      // in a real run: a worker alternated "cannot write here" hand-offs ten times
      // while the plan stayed empty, and the task sat in `running` looking busy.
      //
      // The failure fuse counts rejections; this counts motion. Three hand-offs with
      // no plan change, or a step stuck `doing` between all of them, is the point at
      // which a person should decide, and the decision is recorded as such instead of
      // being buried in the trail.
      //
      next = applyTransition(next, 'paused', { now, pauseReason: 'needs_decision' }).task;
      next = {
        ...next,
        decision: {
          category: 'direction',
          label: '原地打转',
          reason:
            `连续 ${SPIN_LIMIT} 次交接但计划没有推进（当前步骤：${currentStep(next.spec?.plan)?.id ?? '未规划'}）。` +
            '这通常意味着环境不允许或方向不对，需要人拍板。',
          askedAt: now,
          deadlineAt: now + DECISION_TIMEOUT_MS,
        },
      };
    } else if (accepted && handoff.outcome === 'handoff' && this.scopeDeliveredButPlanOpen(next)) {
      /**
       * Ask once, not once per hand-off.
       *
       * The branch fires on every accepted hand-off, so a task that was already parked
       * on an unanswered decision produced another identical decision the next time the
       * worker reported — and the supervisor relayed each one. A real run asked the
       * same A/B question three times. An outstanding decision is the whole point: it
       * is already waiting, so there is nothing new to say.
       */
      const outstanding = next.decision && !next.decision.resolvedAt
      if (outstanding) {
        // Nothing to add: the task stays paused on the question it already asked.
      } else {
      /**
       * The authorised slice is delivered and the rest is nobody's call.
       *
       * Observed on a real run: the user said 「只做 1.1，完成就停下，不要碰 1.2 和 2」,
       * the worker did exactly that, its hand-off passed — and the task then sat on
       * 进行中 forever. Nothing was wrong with the supervisor: it stopped as instructed
       * and correctly declined to report, because none of the three reasons to interrupt
       * applied. The gap was that this state existed at all and had no name. A task that
       * will not move again is not "running"; it is waiting for a person to widen the
       * boundary, and that is precisely a decision.
       *
       * Not treated as failure: nothing went wrong. Not treated as completion: the plan is
       * not finished. A pause with a decision is the honest description, and it routes to
       * the user through the same door as every other 拍板 request.
       */
      next = applyTransition(next, 'paused', { now, pauseReason: 'needs_decision' }).task;
      const remaining = (next.spec?.plan ?? []).filter((step) => step.status !== 'done');
      next = {
        ...next,
        decision: {
          category: 'direction',
          label: '范围内的工作已完成',
          reason:
            `任务范围只覆盖已完成的部分（「${next.spec?.scope ?? ''}」），` +
            `还剩 ${remaining.length} 步没有授权：${remaining.map((step) => step.id).join('、')}。` +
            '要继续就回复放行，我会接着派；不需要就把任务结束掉。',
          askedAt: now,
          deadlineAt: now + DECISION_TIMEOUT_MS,
        },
      };
      appendJournal(this.root, id, {
        type: 'scope_delivered',
        at: now,
        data: { remaining: remaining.map((step) => step.id) },
      });
      }
    }

    /**
     * Decide whether this hand-off belongs on the timeline.
     *
     * Recorded before the next-leg attempt below, because the question is what this
     * hand-off implies, not whether the spawn succeeded: "the plan now belongs to
     * another agent" is a fact about the plan, and a failed spawn does not make the
     * boundary disappear. Attempts that changed nothing stay in `handoffs` — the
     * spinning detector reads every one of them — but the timeline stops showing
     * them, which is the difference between a log of attempts and a history.
     */
    const nextLegOwner = nextLeg(next.spec?.plan)?.agent
    const milestone =
      handoff.outcome === 'needs_decision' ||
      next.status !== task.status ||
      compactionPending ||
      Boolean(nextLegOwner && nextLegOwner !== next.assigneeAgentId)
    const lastIndex = next.handoffs.length - 1
    if (lastIndex >= 0) {
      next = {
        ...next,
        handoffs: next.handoffs.map((entry, index) =>
          index === lastIndex ? { ...entry, milestone } : entry,
        ),
      }
    }
    handoff.milestone = milestone

    this.save(next);
    appendJournal(this.root, id, {
      type: 'handoff',
      at: now,
      data: {
        outcome: handoff.outcome,
        passed: accepted,
        milestone,
        reasons,
        acceptance: acceptance?.results,
        ...(compactionPending ? { compactionPending: true } : {}),
      },
    });

    // The next section may belong to someone else. When it does, start them here
    // — the plan already says who, so asking the supervisor would be paying a
    // model call and a queue slot to read a field.
    //
    // Only for an accepted `handoff`: `delivered` means the task is finished, and
    // `needs_decision` means it is waiting on a person. Starting work in either
    // case would be acting on a decision nobody made.
    let startedNextLeg = false;
    if (accepted && handoff.outcome === 'handoff' && this.deps.startNextLeg) {
      const leg = nextLeg(next.spec?.plan);
      const current = next.assigneeAgentId;
      const nextAgent = leg?.agent ?? current;
      const belongsElsewhere = Boolean(leg && leg.agent && leg.agent !== current);
      if (leg && belongsElsewhere) {
        try {
          startedNextLeg = await this.deps.startNextLeg(next, nextAgent);
        } catch (error) {
          startedNextLeg = false;
          log.warn(`[tasks] could not start the next leg of ${id}`, { error: String(error) });
        }
        if (startedNextLeg) {
          appendJournal(this.root, id, {
            type: 'next_leg_started',
            at: now,
            data: { step: leg.step.id, agent: nextAgent },
          });
        }
      }
    }

    // Only the supervisor decides what the user sees; the worker never does.
    // Skip the nudge when the next leg already started: the supervisor has
    // nothing to route, and waking it would queue a message in front of the
    // user's next sentence for no decision.
    if (!startedNextLeg) {
      /**
       * A pending decision must be named in the nudge.
       *
       * "交接通过" alone tells the supervisor the step landed; it does not tell it that a
       * question is now waiting for a person. Observed: the supervisor read the pass,
       * wrote a summary in its own lane, and correctly declined to interrupt the user —
       * because nothing anywhere said there was something to ask. The task then sat on
       * 进行中 with a decision nobody had surfaced.
       */
      const pending = next.decision && !next.decision.resolvedAt ? next.decision : undefined
      this.deps.wakeSupervisor(
        next.supervisorSessionId,
        pending
          ? `${id} 现在需要用户拍板（${pending.label}）：${pending.reason} 请用 report_to_user 带 kind=decision 告知用户。`
          : accepted
            ? `${id} 交接通过：${handoff.summary}`
            : `${id} 交接未通过（${reasons.join('；') || handoff.outcome}）：${handoff.summary}`,
      );
    }

    return { task: next, handoff, passed: accepted, reasons, compactionPending };
  }

  /**
   * Where a relative artifact path actually lives.
   *
   * `probe` used to call `existsSync(path)` on whatever the worker wrote, which
   * resolved against the *host process's* working directory — not the workspace.
   * The acceptance commands resolved against the workspace root, so the same
   * handoff could pass `test -s docs/a.md` and still be rejected with "missing
   * deliverable: docs/a.md". The worker was telling the truth and the gate was
   * looking in the wrong place, forever: seven handoffs, seven rejections, a task
   * paused for failures that never existed.
   *
   * One base for both layers now: the task's `cwd` when it has one, else the
   * workspace root — the same fallback `runAcceptanceCommand` uses.
   */
  private resolveArtifactPath(task: Task, path: string): string {
    const raw = path.trim().replace(/^\.\//, '');
    if (isAbsolute(raw)) return raw;
    const cwd = task.spec?.cwd;
    const base = cwd
      ? (isAbsolute(cwd) ? cwd : join(this.deps.workspaceRoot, cwd))
      : this.deps.workspaceRoot;
    return join(base, raw);
  }

  /** Scope delivered, but the plan still has steps nobody authorised. */
  private scopeDeliveredButPlanOpen(task: Task): boolean {
    if (!task.spec?.scope) return false;
    const plan = task.spec.plan ?? [];
    if (!plan.length) return false;
    return plan.some((step) => step.status !== 'done');
  }

  /** Silence the session that was working, after the task stops expecting it. */
  private stopWorker(task: Task): void {
    const sessionId = task.currentSessionId;
    if (!sessionId || !this.deps.stopSession) return;
    try {
      this.deps.stopSession(sessionId);
    } catch (error) {
      log.warn(`[tasks] could not stop the worker of ${task.id}`, { error: String(error) });
    }
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

    /**
     * A failed check has to explain itself.
     *
     * This used to say `acceptance failed: a1 (exit 1)` — an id and a code, which is
     * everything the worker cannot interpret. A real run responded exactly as you would
     * expect: it stopped working and went reading the task to find out what `a1` was.
     * The information was already here — the id, the human sentence, the command, and the
     * command's own output — and none of it reached the model.
     *
     * Written for a reader who has the task in hand: what was supposed to be true, what was
     * run, and what came back.
     */
    const describe = (item: NonNullable<ReturnType<typeof acceptanceItems>[number]>, detail: string): string =>
      `验收项 ${item.id} 未通过：「${item.check}」\n  执行的命令：${item.command}\n  ${detail}`;

    for (const item of withCommands) {
      try {
        const result = await this.deps.runAcceptanceCommand(item.command!, cwd);
        const passed = result.exitCode === 0;
        const output = result.output?.trim();
        const detail = result.exitCode === null
          ? '命令没有返回退出码（可能被中断）'
          : `退出码 ${result.exitCode}${output ? `，输出：${output.slice(0, 400)}` : '（没有输出）'}`;
        results.push({
          id: item.id,
          passed,
          note: passed ? undefined : detail,
        });
        if (!passed) failures.push(describe(item, detail));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ id: item.id, passed: false, note: message });
        failures.push(describe(item, `命令无法执行：${message}`));
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
    this.save(paused);
    appendJournal(this.root, task.id, {
      type: 'paused',
      at: now,
      data: { reason, sessionId: lockId },
    });
    return paused;
  }

  /** Tell whoever is reading that a task changed. Never throws into the write path. */
  private notifyChanged(): void {
    try {
      this.deps.onChanged?.();
    } catch {
      // A broken listener must not fail a write that already succeeded.
    }
  }

  /**
   * The one write path.
   *
   * Every mutation in this class saved and then told nobody, so a change made by a tool
   * was invisible to a reader until an unrelated RPC happened to publish. Wrapping the
   * save keeps "written" and "announced" from drifting apart again.
   */
  private save(task: Task): void {
    saveTask(this.root, task);
    this.notifyChanged();
  }

  private require(id: string): Task {
    const task = loadTask(this.root, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
