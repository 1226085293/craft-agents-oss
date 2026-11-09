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
  openSteps,
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
  restructurePlan,
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
  answeredWithoutProgress,
  unownedSubSteps,
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
  /**
   * Tell the owning supervisor something, optionally naming the subject.
   *
   * `key` is what the notice is ABOUT — `T-1:handoff-fail` — supplied by the caller because it knows
   * the fact. Coalescing on the sentence instead would mean two retry notices about one task read as
   * two different subjects, and inferring the subject from the wording is exactly the kind of
   * guesswork this codebase keeps having to remove.
   */
  wakeSupervisor: (sessionId: string, text: string, key: string) => void;
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

    /**
     * A plan may not arrive with unowned sub-steps.
     *
     * `applyPlanPatch` already refuses one, because a sub-step is the unit of assignment and an
     * unowned one was assigned to nobody. `task_create` writes `spec.plan` in one piece and so
     * bypassed that rule; the record then looked complete while nobody had decided who does what.
     * Refused here rather than filled in with the assignee: the assignee is who the task went to,
     * not a judgement about which profile fits this section, and a stamped guess would stop anyone
     * from ever asking.
     */
    const unowned = unownedSubSteps(request.spec?.plan);
    if (unowned.length > 0) {
      throw new Error(
        `小节必须写明谁做（agent），这几条没有：${unowned.map((step) => step.id).join('、')}。` +
          '先读这份简报里的「可用分工」，再按每个小节的活把 agent 写上；大纲不用写。',
      );
    }

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

    const classified = this.classifyPauseReason(result.task);
    this.save(classified);
    appendJournal(this.root, id, {
      type: 'status',
      at: now,
      data: { from: task.status, to: status, reason: options?.pauseReason },
    });
    // The classified task, not the raw one: returning `result.task` told the caller the pause was
    // `needs_decision` while the record said `asking` — the same two-answers-from-one-write problem
    // this classification exists to remove.
    return classified;
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

  /**
   * Close a decision that is no longer true, without pretending a person answered it.
   *
   * This is the path for "the question evaporated" — the boundary was widened, so the thing it
   * was asking about no longer exists. It is NOT the path for an answer: that is
   * `recordDecisionAnswer`, which stores the person's words.
   *
   * The distinction matters because `resolvedAt` alone is read as "a human settled this" by the
   * card and by the watchdog. A record that claimed that while holding `answer: null` left the
   * task paused with `pauseReason: needs_decision`, no question to display, and nothing left to
   * wake it — observed stuck indefinitely on T-1.
   *
   * `resolution: 'obsolete'` says what actually happened, so later readers do not have to
   * infer it from an empty answer field.
   */
  resolveDecision(id: string, resolution: 'approved' | 'rejected' | 'obsolete', note?: string): Task {
    const task = this.require(id);
    const now = this.now();
    if (!task.decision) return task;
    const next: Task = {
      ...task,
      decision: {
        ...task.decision,
        resolvedAt: now,
        resolution,
        ...(note?.trim() ? { reason: note.trim() } : {}),
      },
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'decision_resolved', at: now, data: { resolution, note } });
    /**
     * The pause the decision created ends with the decision.
     *
     * Leaving it behind produced a task that claimed to be waiting for something that had already
     * been settled: `paused / asking`, no question, no answer, and — because every guard looks at
     * either an open decision or a running task — nothing that would ever look at it again.
     */
    return this.releaseDecisionPause(next);
  }

  /**
   * Drop a decision pause once no decision is open any more.
   *
   * Only the two decision reasons are touched: `budget`, `failures` and `process_lost` describe the
   * task itself and survive a decision closing.
   */
  private releaseDecisionPause(task: Task): Task {
    if (task.status !== 'paused' || !task.decision?.resolvedAt) return task;
    if (task.pauseReason !== 'needs_decision' && task.pauseReason !== 'asking') return task;
    return this.clearPauseReason(task.id);
  }

  /**
   * Drop a pause reason that no longer describes the task.
   *
   * `setStatus(id, 'paused')` cannot do this: `applyTransition` short-circuits when the status
   * is unchanged, so the write is a no-op and the reason survives. That is correct for a real
   * transition and wrong here — the status is staying `paused`, and only the *reason* has
   * stopped being true.
   *
   * The case this exists for: a task paused on `needs_decision` whose decision has just been
   * closed as obsolete. Leaving the reason in place makes the page render 「等我拍板」 above a
   * card with no question, and every guard that keys off `pauseReason` keeps treating the task
   * as if a person still owed it an answer.
   */
  clearPauseReason(id: string): Task {
    const task = this.require(id);
    if (!task.pauseReason) return task;
    const next: Task = { ...task, pauseReason: null, updatedAt: this.now() };
    this.save(next);
    appendJournal(this.root, id, { type: 'pause_reason_cleared', at: this.now(), data: {} });
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
    const result = applyPlanPatch(task.spec?.plan, patch, now);
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
      if (leg?.kind === 'step' && leg.agent && leg.agent !== next.assigneeAgentId && this.deps.startNextLeg) {
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
    if (!task) return null;
    const decision = task.decision;
    /**
     * A question can exist before there is a decision record, and this used to drop it.
     *
     * `task.decision` is written by a worker's `needs_decision` hand-off. The supervisor asks in
     * its own words through `report_to_user`, which reaches here to put the real question and the
     * real buttons onto the record the task page reads. When the task had no decision — because it
     * was paused by a plain `task_update({status:'paused', pauseReason:'needs_decision'})`, which
     * nothing stops — this returned null and wrote nothing.
     *
     * The result was three views of one question that did not agree: the task page said 「等待督导把
     * 问题转达给你，稍后会上来这里」 and, since nothing ever created the record it was waiting for,
     * kept saying it; the conversation showed a card with buttons; and pressing a button answered
     * 「no pending decision on this task」. Reported live on T-1.
     *
     * Creating the record here is what makes 「one question, one answer」 true: the supervisor's
     * question becomes the task's question, so both cards read the same thing and either one can
     * close it.
     */
    if (!decision) {
      const now = this.now();
      const options = (wording.options ?? [])
        .map((option) => option.trim())
        .filter((option) => option.length > 0)
        .slice(0, 4);
      const created: Task = {
        ...task,
        decision: {
          category: 'direction',
          label: wording.label?.trim() || '需要你决定',
          reason: '',
          askedAt: now,
          deadlineAt: now + DECISION_TIMEOUT_MS,
          ...(wording.question?.trim() ? { question: wording.question.trim() } : {}),
          ...(options.length ? { options } : {}),
        },
        updatedAt: now,
      };
      /**
       * The question exists now, so the pause means what it says.
       *
       * 「等问句」 and 「等你决定」 are one state apart by exactly this fact: whether there is
       * something on screen to answer. Writing the question is the moment that becomes true, so
       * the kind of pause is corrected here instead of being left for a reader to interpret.
       */
      /**
       * The pause reason is not set here any more.
       *
       * It used to be nudged from `asking` to `needs_decision` in this one case, which is exactly
       * the shape that leaves a gap: the parked-as-`awaiting_release` task kept its reason while
       * this record made a card appear. `save` derives it from the record now, for every writer.
       */
      const asking = task.status === 'paused' && task.pauseReason === 'asking';
      const created2: Task = this.save(created);
      appendJournal(this.root, id, {
        type: 'decision_asked',
        at: now,
        data: { source: 'supervisor', question: wording.question, fromAsking: asking },
      });
      return created2;
    }
    /**
     * A question asked after the last one was answered is a NEW question.
     *
     * The old record kept `resolvedAt` and `answer`, so the task page rendered 「已选择」 with
     * the previous reply while the conversation showed a fresh, unanswered card. Same task,
     * two questions, one answered-state: the state was per task, so the new question inherited
     * an answer it never received. Keeping the old answer in the journal and starting a clean
     * decision is what makes the two cards agree again.
     */
    /**
     * A question asked before the last answer was acted on is the same question again.
     *
     * `resolvedAt` alone used to be enough to reopen, which treated every follow-up card as a new
     * question and — because the fresh record starts empty — discarded the answer the person had
     * just given. Observed live on T-1: 「暂不执行 2，保持暂停」 at 06:08:59, 「是否继续？」 at
     * 06:09:01, and the task ended with an open question and no record of the reply.
     *
     * Refusing here rather than at the call site is deliberate: this is the only door to a reopen,
     * so no entry point can route around it. Callers that want to say something without asking
     * anything can still send a plain report.
     */
    if (decision.resolvedAt && answeredWithoutProgress(task)) {
      return task;
    }
    if (decision.resolvedAt) {
      const fresh: Task = {
        ...task,
        decision: {
          category: decision.category,
          label: decision.label,
          /**
           * The reason is the OLD question's diagnosis, and carrying it into the new one is how
           * a reopened decision ended up quoting a condition that had already been satisfied —
           * 「还剩 1 步没有授权：2」 kept being rendered next to a card asking something else.
           * It is re-derived by the caller that re-asks (`setDecisionWording` receives only
           * wording); when no new reason arrives, the field stays empty rather than stale.
           */
          reason: '',
          askedAt: this.now(),
          deadlineAt: this.now() + DECISION_TIMEOUT_MS,
        },
        updatedAt: this.now(),
      }
      this.save(fresh)
      appendJournal(this.root, id, { type: 'decision_reopened', at: this.now(), data: {} })
      return this.setDecisionWording(id, wording)
    }

    const options = (wording.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .slice(0, 4);

    const next: Task = {
      ...task,
      // A question landing on a task paused as 「等问句」 turns it into 「等你决定」.
      ...(task.status === 'paused' && task.pauseReason === 'asking'
        ? { pauseReason: 'needs_decision' as const }
        : {}),
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
     * Record the words. Do not interpret them.
     *
     * This used to run the reply through keyword tables to derive a boundary
     * (「完成 1.2 后暂停」 → ceiling 1.2, 「放行步骤 2」 → steps up to 2). That is not a thing
     * text matching can do: 「其余之后再定」 and 「其余都做」 share a word and mean opposite
     * things, 「停止剩下的任务」 was not in any table, and every miss was silent — the task
     * resumed with the wrong authority and nobody could tell why.
     *
     * Interpreting a sentence is a model's job. The supervisor reads the answer in its own turn
     * and writes what it understood through `task_update` (`authorizedUpTo` / `authorizedSteps`),
     * which stamps `authorizedAt`. `resumeDecisionFor` compares that timestamp with the answer's
     * and refuses to start the task until somebody has actually acted on the words.
     *
     * `resolution: 'approved'` here means only "this question is closed" — it is not a claim
     * about what was authorised, which is why no boundary is inferred from it.
     */
    const next: Task = {
      ...task,
      decision: { ...decision, answer: { text: trimmed, at: now }, resolvedAt: now, resolution: 'approved' },
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'decision_answered', at: now, data: { text: trimmed } });
    /**
     * The answer ends the wait, so it ends the reason for waiting.
     *
     * 「等你拍板」 with an answer already stored is the state this codebase kept hitting: the card
     * disappeared because it had been answered, the task still said a person owed it a reply, and
     * every guard treated it as untouchable. The words still have to be turned into a `directive`
     * before anything runs — `resumeDecisionFor` enforces that — but the pause itself is over.
     */
    return this.releaseDecisionPause(next);
  }

    /**
   * Record that a lost executor has been retried.
   *
   * On the task, not in the watchdog: the watchdog is recreated with the app, and a counter that
   * reset on every boot would retry the same loss forever — which is the opposite of "retry once,
   * then ask a person".
   */
  /**
   * Count a nudge about a decision whose question was never worded.
   *
   * Same shape as `recordLostRetry`, same reason: the counter has to outlive the process that
   * increments it, or a task stuck on an unwritten question is nudged on every boot forever.
   */
  recordUnwordedRetry(id: string, count: number): Task {
    const task = this.require(id);
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const next: Task = {
      ...task,
      stats: { ...stats, unwordedRetries: count },
      updatedAt: this.now(),
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'unworded_nudge', at: this.now(), data: { count } });
    return next;
  }

  recordLostRetry(id: string, count: number): Task {
    const task = this.require(id);
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const next: Task = {
      ...task,
      stats: { ...stats, lostRetries: count },
      updatedAt: this.now(),
    };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'lost_retry',
      at: this.now(),
      data: { count },
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
  /**
   * 「等你决定」 is only true when there is something to answer.
   *
   * A pause can be asked for before the question is worded — the supervisor stops, then spends a
   * turn composing what to ask. Recording `needs_decision` at that moment puts a card on screen
   * whose buttons have nothing behind them, and pressing one answered 「no pending decision on this
   * task」 (reported live on T-1).
   *
   * Applied where a pause is finalised rather than inside `applyTransition`: a `needs_decision`
   * hand-off crosses that function *before* its decision is attached, so deciding there classified
   * every ordinary hand-off as 「等问句」 — caught by the existing hand-off test.
   *
   * A timer was the alternative, and it is worse: it changes the label under a person who is
   * mid-sentence in the card, and misfires whenever the model is slow, which on this project is
   * ordinary rather than exceptional.
   */
  private classifyPauseReason(task: Task): Task {
    if (task.status !== 'paused') return task;

    /**
     * The pause reason is derived from the decision record, not stored beside it.
     *
     * These were two records of one state and they drifted, visibly:
     *
     *   pauseReason `awaiting_release` — 「已按你的指示停在这里」
     *   decision    open, with a question — the card headed 「需要你决定」
     *
     * A live run showed both at once. The supervisor had parked the task as 「按指示停了」 and then
     * asked a question; writing the question updated the decision but not the reason, so the board
     * said one thing and the conversation card another. Nobody could tell which was true, and there
     * was no way to fix it by writing a better sentence anywhere — one of the two had to go.
     *
     * The decision record wins because it is the one a person acts on: if a question is open, the
     * task is paused for that question, whatever else parked it. Deriving here means the two
     * cannot disagree again, in either direction, in either order of writes.
     *
     *   open decision, question written  → needs_decision  (「等你决定」, answerable)
     *   open decision, no words yet      → asking          (「等问句」, not yet answerable)
     *   no open decision                 → nothing is owed (never a decision pause)
     *
     * `awaiting_release` and the other reasons are left untouched: they are not pauses for an
     * answer, and a closed decision does not invalidate them.
     */
    const openDecision = Boolean(task.decision && !task.decision.resolvedAt);
    /**
     * Only the reasons that are *about* a decision are derived.
     *
     * `budget` and `failures` say why the run stopped; an old unanswered question can coexist with
     * them, and rewriting that to 「等你决定」 would hide the thing that actually went wrong. A
     * question being open does not make those pauses decision pauses.
     *
     * `awaiting_release` is included on purpose: the supervisor parks a delivered slice there and
     * then asks something, and the question is what the person must act on now.
     */
    const isDecisionish =
      task.pauseReason === 'needs_decision' ||
      task.pauseReason === 'asking' ||
      task.pauseReason === 'awaiting_release' ||
      task.pauseReason == null;
    if (!isDecisionish) return task;

    if (openDecision) {
      return { ...task, pauseReason: task.decision!.question?.trim() ? 'needs_decision' : 'asking' };
    }

    const isDecisionPause = task.pauseReason === 'needs_decision' || task.pauseReason === 'asking';
    if (!isDecisionPause) return task;

    /**
     * No open decision, and two different reasons why that can be.
     *
     * `resolvedAt` set — the question closed (answered, timed out, made obsolete). Nothing is owed,
     * so no decision pause belongs here; leaving the label on made a task claim somebody owed it a
     * reply while the card was already gone.
     *
     * No record at all — the supervisor paused to ask something and has not written a word yet.
     * That is 「等问句」, not 「nothing is happening」: the distinction is the whole reason `asking`
     * exists, and clearing it to null would hide a pending question behind 「已暂停」.
     */
    if (task.decision?.resolvedAt) return { ...task, pauseReason: null };
    return { ...task, pauseReason: 'asking' };
  }

  /**
   * Record what the person's last reply means, in the supervisor's words.
   *
   * Kept on the task so every entry point — manual run, supervisor resume, event route,
   * scheduler — reads the same instruction instead of each deciding for itself what an answer
   * authorised. The text is never parsed: what it means is the model's judgement, and the only
   * thing code needs is `at`, used by `resumeDecisionFor` to tell "acted on" from "merely
   * answered".
   */
  setDirective(id: string, text: string | undefined): Task {
    const task = this.require(id);
    const trimmed = text?.trim();
    const now = this.now();
    const next: Task = {
      ...task,
      spec: {
        ...task.spec,
        directive: trimmed ? { text: trimmed.slice(0, 800), at: now } : undefined,
      } as Task['spec'],
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'spec_updated',
      at: now,
      data: { directive: trimmed ?? null },
    });
    return next;
  }

    setScope(id: string, scope: string | undefined): Task {
    const task = this.require(id)
    const trimmed = scope?.trim()
    if (!trimmed) return task
    if (task.spec?.scope === trimmed) return task
    return this.updateSpec(id, { ...task.spec, scope: trimmed })
  }

  /**
   * Replace the outlines that have not started yet.
   *
   * The journal keeps the titles it replaced, because a plan that changes silently is
   * indistinguishable from a plan that was never followed.
   */
  restructurePlan(
    id: string,
    request: { fromId: string; outlines: Array<{ id?: string; title: string }> },
  ): { ok: boolean; error?: string; plan?: NonNullable<Task['spec']>['plan'] } {
    const task = this.require(id);
    const before = (task.spec?.plan ?? [])
      .filter((step) => step.id === request.fromId || Number(step.id) >= Number(request.fromId))
      .filter((step) => /^\d+$/.test(step.id))
      .map((step) => `${step.id} ${step.title}`);
    const result = restructurePlan(task.spec?.plan, request, this.now());
    if (result.error) return { ok: false, error: result.error };
    if (!result.changed) return { ok: true, plan: result.plan };
    const next: Task = {
      ...task,
      spec: { ...task.spec, plan: result.plan } as Task['spec'],
      updatedAt: this.now(),
    };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'plan_restructured',
      at: this.now(),
      data: {
        fromId: request.fromId,
        before,
        after: result.plan.filter((step) => /^\d+$/.test(step.id)).map((step) => `${step.id} ${step.title}`),
      },
    });
    return { ok: true, plan: result.plan };
  }

  /**
   * Replace the acceptance list.
   *
   * Acceptance items describe the RESULT, so a wrong one has to be fixable: a real task carried
   * 「本轮未执行 1.2」, the user then released 1.2, and from that moment every hand-off contradicted
   * the item. Three rejections tripped the failure fuse and the task could never close — the
   * supervisor's only escape was to abandon it, because nothing could edit the list.
   *
   * Refused once the task is finished: acceptance is what `completed` was granted against, and
   * rewriting it afterwards would rewrite the reason for a decision that has already been taken.
   */
  setAcceptance(
    id: string,
    items: Array<{ id?: string; check: string; command?: string }>,
  ): Task {
    const task = this.require(id);
    if (TERMINAL_STATUSES.includes(task.status)) {
      throw new Error(`${task.status} 的任务不能再改验收项：它已经按当时的验收结论结束了`);
    }
    const acceptance = items.map((item, index) => ({
      // Keep a given id so an edit replaces that item instead of adding a second copy.
      id: item.id?.trim() || `a${index + 1}`,
      check: item.check.trim(),
      ...(item.command?.trim() ? { command: item.command.trim() } : {}),
    }));
    if (acceptance.some((item) => !item.check)) {
      throw new Error('验收项必须写一句判断：什么算做到了');
    }

    const spec: TaskSpec = { ...(task.spec ?? {}), acceptance };
    const next: Task = {
      ...task,
      spec,
      // The judge reads `requirement`; leaving it stale would keep grading against the old wording.
      verify: {
        ...task.verify,
        enabled: true,
        requirement: acceptance.map((item) => item.check).join('\n'),
        lastVerdict: undefined,
      },
      updatedAt: this.now(),
    };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'acceptance_updated',
      at: this.now(),
      data: { acceptance },
    });
    return next;
  }

  updateSpec(id: string, spec: TaskSpec): Task {
    const task = this.require(id);
    // Same rule as `create`: a plan written in one piece may not skip the owner of a sub-step.
    const unowned = unownedSubSteps(spec.plan);
    if (unowned.length > 0) {
      throw new Error(
        `小节必须写明谁做（agent），这几条没有：${unowned.map((step) => step.id).join('、')}。` +
          '按每个小节的活把 agent 写上；大纲不用写。',
      );
    }
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
    } else if (accepted && handoff.outcome === 'handoff' && this.sliceDeliveredButPlanOpen(next)) {
      /**
       * Ask once, not once per hand-off.
       *
       * The branch fires on every accepted hand-off, so a task that was already parked
       * on an unanswered decision produced another identical decision the next time the
       * worker reported — and the supervisor relayed each one. A real run asked the
       * same A/B question three times. An outstanding decision is the whole point: it
       * is already waiting, so there is nothing new to say.
       *
       * Still checked here, and now it guards something narrower: a question that is genuinely
       * open stays where it is. Overwriting that pause with 「stopped on instruction」 would leave
       * an open decision behind a pause reason that draws no card — the question would be
       * unanswerable from the screen that was asking it.
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
       * will not move again is not "running"; it is waiting for a person to release it.
       *
       * Not treated as failure: nothing went wrong. Not treated as completion: the plan is
       * not finished. Paused, with the reason saying exactly that.
       *
       * This used to pause on `needs_decision` and write a decision record with the label
       * 「这一段做完了，等你决定」 but no question — because the question was left for the
       * supervisor to word. That made one value mean two things, and the contradiction was
       * visible on a live run: the supervisor reported 「本轮授权范围完成、任务已停」, the board
       * said 「等你决定」, and the watchdog chased the supervisor for the question it had not
       * written. The supervisor obeyed and asked 「第 2 步收尾怎么走」 — a question the person had
       * already answered with 「做完 1.2 就暂停」.
       *
       * The instruction covered what to do next, so there is no question. Pausing on
       * `awaiting_release` and writing no decision is what makes the three surfaces agree:
       * the supervisor reports a stop, the board shows a stop, and the watchdog stays quiet
       * because nobody is owed an answer.
       */
      next = applyTransition(next, 'paused', { now, pauseReason: 'awaiting_release' }).task;
      const remaining = openSteps(next.spec?.plan);
      appendJournal(this.root, id, {
        type: 'slice_delivered',
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
    const nextLegRead = nextLeg(next.spec?.plan)
    // Only a step has an owner: an unexpanded section is not assigned to anyone yet.
    const nextLegOwner = nextLegRead?.kind === 'step' ? nextLegRead.agent : undefined
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

    /**
     * Classified here, after the decision has been attached.
     *
     * The hand-off sets `paused/needs_decision` first and hangs the decision on it a few lines
     * later, so the pause reason and the question arrive in that order. This is the first moment
     * both are known, which is exactly the fact 「等你决定」 claims.
     */
    next = this.classifyPauseReason(next)
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
      const startedStep = leg?.kind === 'step' ? leg : undefined;
      const current = next.assigneeAgentId;
      const nextAgent = startedStep?.agent ?? current;
      const belongsElsewhere = Boolean(startedStep?.agent && startedStep.agent !== current);
      if (startedStep && belongsElsewhere) {
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
            data: { step: startedStep.step.id, agent: nextAgent },
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
        // One subject per task and outcome: a second failure notice about the same task is the same
        // fact restated, and a queue that stacks them makes the supervisor act twice.
        `${id}:${pending ? 'decision' : accepted ? 'handoff-pass' : 'handoff-fail'}`,
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
  /**
   * The worker handed its slice back, and the plan still has work in it.
   *
   * This used to read `spec.scope` — the prose written at task creation — and that stopped being
   * the right question when the id lists were removed. `scope` no longer decides anything (it is
   * what the brief prints as 「检查范围」 and what the section chooser reads as 「分工范围」), so a task
   * whose boundary was recorded the new way, as `spec.directive`, never paused here at all: the
   * worker finished a slice, handed off, and the task either continued on its own or sat in
   * `running` with nobody owning the next step.
   *
   * `openSteps` rather than a flat `status !== 'done'` scan, for the reason that function exists:
   * an outline's stored status lags its sub-steps, so the flat scan counted a finished section as
   * outstanding and asked the person about work that was already done.
   */
  private sliceDeliveredButPlanOpen(task: Task): boolean {
    if (!task.spec?.directive?.text) return false;
    return openSteps(task.spec.plan).length > 0;
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
  /**
   * Every write passes through the derivation.
   *
   * `classifyPauseReason` used to be called from two places, and a writer that did not call it —
   * `setDecisionWording` was one — could leave the pause reason disagreeing with the decision it
   * had just written. That is how a live task ended up as `awaiting_release` (「已按你的指示停在这
   * 里」) with an open question on the board at the same time.
   *
   * Applying it here makes the pair impossible to desynchronise: the reason is a function of the
   * record, and the record is what gets stored. Callers still see the derived value because they
   * are handed the same object they saved — see the `save` result threading below.
   */
  private save(task: Task): Task {
    const derived = this.classifyPauseReason(task);
    saveTask(this.root, derived);
    this.notifyChanged();
    return derived;
  }

  private require(id: string): Task {
    const task = loadTask(this.root, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
