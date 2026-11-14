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

/** A newline, named once: this file is edited from scripts that mangle '\n' escapes. */
const NEWLINE = String.fromCharCode(10);
import {
  acceptanceItems,
  applyTransition,
  openSteps,
  attachSession,
  checkHandoffRules,
  createTask,
  deleteTask,
  isHeartbeatMissing,
  isNewRevision,
  loadTask,
  nextTaskId,
  normalizeHandoff,
  nextLeg,
  restructurePlan,
  currentStep,
  isRecurring,
  recordRunResult,
  resumeRefusal,
  saveTask,
  shouldTripFuse,
  appendJournal,
  listTasks,
  activeTasks,
  assessDecisionRequest,
  applyPlanPatch,
  planProgress,
  sameAgent,
  childrenOf,
  DECISION_TIMEOUT_MS,
  TERMINAL_STATUSES,
  allDecisions,
  answeredWithoutProgress,
  decisionMirror,
  openDecisions,
  primaryTrigger,
  unownedSubSteps,
  type PlanStepStatus,
  type ArtifactProbe,
  type Handoff,
  type PendingTrigger,
  type Task,
  type TaskAcceptanceVerdict,
  type TaskDecision,
  type TaskSpec,
  type TaskStatus,
  type TaskTrigger,
} from '@craft-agent/shared/tasks';
import { resetRoundState } from '@craft-agent/shared/tasks/round-reset';

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
  /**
   * Ask the watchdog for a pass now instead of at its next deadline.
   *
   * The loop's sleep is derived from state, so it is due at the moment a deadline
   * passes — not at the moment a fact changes. A decision answered, a plan step
   * moved, a hand-off filed: each is a fact the rules read, and each used to wait
   * for the derived deadline (up to half a minute, and a deadline later than that
   * for the slow rules). Poking is the event, the loop stays the fallback.
   *
   * Safe to call on every write: the loop replaces a pending timer rather than
   * queueing a second pass, so a burst of writes costs one pass.
   */
  pokeWatchdog?: () => void;
  /**
   * Run a scheduler pass now instead of at its next tick.
   *
   * The scheduler looks once a minute, which is right for 「is this cron due」 and wrong for 「a round
   * just ended, the trigger that piled up behind it can start now」. Measured on a live per-minute
   * task: the average wait between a round closing and the next claim was **66 seconds** — a full
   * tick of pure idle per round, which is why the observed interval drifted to two minutes instead of
   * the one that was asked for.
   */
  pokeScheduler?: () => void;
  /**
   * The task reached a terminal state (completed / canceled / failed).
   *
   * Lives here rather than in the renderer because the worker session belongs to the runtime, not to
   * the record: a task that is over leaves behind sessions nobody will reuse, and the record cannot
   * archive them. Called once per transition into a terminal state, not on every write.
   */
  onTaskTerminal?: (task: Task) => void;
  /**
   * A round is over; the session that ran it is done with.
   *
   * Rounds used to share one worker session, which meant each round's context carried every earlier
   * round — the same conversation getting slower every minute, and a model reading last round's
   * numbers as if they were this round's. A round is a unit of work with its own result (kept in
   * `stats.lastRound`), so it gets its own session: the host archives the one that just finished and
   * the next dispatch opens a fresh one with only the round result to continue from.
   */
  onRoundEnd?: (taskId: string, sessionId: string) => void;
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

/**
 * How long a fired trigger holds the round before it expires.
 *
 * Longer than a supervisor turn by design (those run on a ~90 second budget), so a normal turn never
 * races its own lock. Short enough that a turn which died after claiming does not block the task
 * until somebody notices.
 */
export const TRIGGER_CLAIM_MS = 3 * 60 * 1000;

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

/**
 * A live run's runtime resources, held outside the task record.
 *
 * The record persists across restarts (and `recoverAfterRestart` depends on its
 * `lockSessionId`), but sessions, timers and shells do not. This handle is what
 * a run owns while it is alive; `disposeRun` releases it all when the run ends.
 */
export interface RunHandle {
  sessionId?: string;
  disposers: Array<(mode: 'suspended' | 'ended') => void>;
}

/**
 * Keep the legacy `decision` slot pointing at the newest open question.
 *
 * Every reader that asks 「is a question open?」 — the card, the pause label, the resume gate, the
 * watchdog — was written against a single slot. The queue is the record now, and this mirror is
 * how those readers keep their meaning without being rewritten: with anything open, `decision` IS
 * an open question; with nothing open, it is the last one, which is what the page shows as 「已选择」.
 */
function syncDecisionMirror(task: Task): Task {
  if (!task.decisions?.length) return task
  const mirror = decisionMirror(task)
  if (!mirror) return task
  if (task.decision === mirror) return task
  return { ...task, decision: mirror }
}

/**
 * Identity for one question./**
 * Identity for one question.
 *
 * Timestamp plus position: unique within a task without a uuid, and readable in the journal
 * (「d-1794262539099-1」) when tracing which question an answer closed.
 */
function newDecisionId(now: number, size: number): string {
  return `d-${now}-${size}`
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
        /**
         * A task without `origin` is not a candidate — and must not crash the read.
         *
         * Older records (and hand-written ones) can lack it; reading its fields unguarded threw
         * inside `listTasks`, so creating any task failed once one such file existed.
         */
        task.origin?.toolCallId === request.toolCallId &&
        task.origin?.supervisorSessionId === request.supervisorSessionId,
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
        appendJournal(this.root, id, { type: 'paused', at: now, data: { reason: blocked.reason } });
        // The saved record, not the pre-derivation object: the reason is derived in `save`, and
        // returning the earlier copy would tell the caller something the record does not say.
        return this.save(paused);
      }
    }

    const result = applyTransition(task, status, {
      now,
      pauseReason: options?.pauseReason,
      error: options?.error,
    });
    if (!result.changed) return result.task;

    /**
     * Every transition away from `running` ends the run it came from.
     *
     * `applyTransition` only moves the status: the lock stays where it was, so a task
     * paused (or canceled) out of a run kept `lockSessionId` pointed at a live session
     * and `isRunLocked` refused to resume it until that session died — the task was
     * stranded in `paused` forever. This is the one place a write can end a run, so it
     * must release it here; the gate-blocked branch above is exempt on purpose: its
     * pause means "another run already owns this task" and releasing there would steal
     * that run's lock.
     */
    let next = result.task;
    const wasLocked = Boolean(task.stats?.lockSessionId);
    if (status !== 'running' && wasLocked) {
      next = this.releaseRunRecord(next, now);
    }

    const classified = this.classifyPauseReason(next);
    this.save(classified);
    if (status !== 'running' && wasLocked) {
      // The run this write ended owns a live session; it must stop producing work.
      this.disposeRun(id, 'suspended');
    }
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
    /**
     * A finished task has no work left to start, whoever asks.
     *
     * `applyTransition` refuses `completed → running`, but `startRun` builds its record
     * directly and never asked it — and `updateTask({status:'running'})` goes straight to
     * `runTask`. Observed live: the supervisor set T-1 to `completed` at 11:52:21 and to
     * `running` at 11:52:29, which resumed the worker into a task that had already been
     * reported to the user as finished; it then filed three `delivered` hand-offs and the
     * person got three copies of 「任务已全部完成」.
     */
    if (TERMINAL_STATUSES.includes(task.status)) {
      return {
        pauseReason: null,
        reason: `${task.id} 已经${task.status === 'completed' ? '完成' : '取消'}了，不能再启动。要接着做就新建一条任务。`,
      }
    }

    /**
     * A question for a person is not a step the executor may skip.
     *
     * `applyTransition` already refuses `→ running` while a question is open; `startRun` builds its
     * record directly and so walked straight past that guard. The result was a task paused on its
     * own question, holding a run lock, with a worker spawned to work on it — the exact state the
     * guard exists to prevent, reached by the other door.
     */
    const open = openDecisions(task)
    if (open.length) {
      const worded = open.some((entry) => entry.question?.trim())
      return {
        pauseReason: worded ? 'needs_decision' : 'asking',
        reason: worded
          ? `等待你的决定：${open.find((e) => e.question?.trim())?.question}`
          : '等待督导把问题写清楚',
      }
    }

    /**
     * One implementation, because the board reads the same answer.
     *
     * `resumeRefusal` is also what `classifyPauseReason` labels a pause with, so a card can never
     * offer 「继续」 on a task this gate will refuse: the label IS the refusal.
     */
    return resumeRefusal(task, {
      sessionExists: this.deps.sessionExists,
      getTask: (id) => this.get(id),
      now,
    });
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

    /**
     * Claim → bind is two calls of one run, not two runs.
     *
     * Scheduler and spawn both claim with `pending:…` and bind the real session id
     * once it exists. Counting both calls made `runs` grow by 2 per spawn and the
     * budget (`runs > maxRuns`) exhaust at half the runs it promised. The bind call
     * hands the placeholder lock over to the real session; the run was already
     * counted when it was claimed.
     */
    const heldLock = task.stats?.lockSessionId;
    /**
     * Handing the round over is not starting a new one.
     *
     * Three writes describe one round: the trigger claims (`pending:cron:…`), the dispatch takes
     * that claim over (`pending:dispatch`), and the spawn binds the real session id. Counting any
     * of those as a new run made `runs` climb by two per round, and `runs` is the budget's clock
     * (`runs > maxRuns`) — so a task that promised twelve rounds stopped at six.
     *
     * So the only write that counts a run is one that starts from no placeholder at all.
     */
    const continuesRun = Boolean(heldLock?.startsWith('pending:'));
    /**
     * A round in progress has already been counted.
     *
     * `runStartedAt` is set by the write that starts a round and cleared when that round closes —
     * `resetRoundState` and `releaseRunRecord` both drop it. So while it is present, this record is
     * inside a round that has a run on the clock, and any further claim belongs to that same run.
     *
     * This is the answer the lock cannot give: `reportHandoff` releases the lock before the verdict
     * closes the round, so a claim in that window saw 「no lock」 and counted a second run for the
     * same round. Live: `runs: 3` against `rounds.ok: 1`.
     */
    const sameRound = typeof task.stats?.runStartedAt === 'number';
    const countedRuns = (task.stats?.runs ?? 0) + (continuesRun || sameRound ? 0 : 1);

    let next: Task = {
      ...task,
      status: 'running',
      pauseReason: null,
      ...(isPlaceholder ? {} : { currentSessionId: sessionId }),
      // Lifetime history: never pruned, because deleting the task uses it to take the conversations
      // with it. Placeholders are not sessions, so they never enter either list.
      sessionIds: isPlaceholder || task.sessionIds.includes(sessionId)
        ? task.sessionIds
        : [...task.sessionIds, sessionId],
      /**
       * The round's own list — the sessions to archive when this round closes.
       *
       * Separate from `sessionIds` on purpose: a round can dispatch several agents in turn, and the
       * round is over for all of them at once. Kept deduped so a retried bind does not double-count.
       */
      roundSessionIds: isPlaceholder
        ? task.roundSessionIds
        : task.roundSessionIds?.includes(sessionId)
          ? task.roundSessionIds
          : [...(task.roundSessionIds ?? []), sessionId],
      stats: {
        // Spread first: this literal is rebuilt on every start, so any field it did not name was
        // silently erased — `rounds` was reset to nothing on the second round of a recurring task,
        // which made every round look like the first one.
        ...task.stats,
        /**
         * One round is one run, whatever the lock has been through.
         *
         * `continuesRun` answers it while the placeholder is alive, but a placeholder does not
         * always survive: `reportHandoff` releases the lock before the verdict closes the round, and
         * a firing in that window claimed a second round for the same one (live: `runs: 8` against
         * `rounds.ok: 6`). The stamp is what survives — the run it belongs to is recorded on the
         * round, so a second claim of the same round cannot count twice.
         */
        runs: countedRuns,
        runsCountedFor: countedRuns,
        activeMs: task.stats?.activeMs ?? 0,
        lastHeartbeatAt: now,
        lockSessionId: sessionId,
        runStartedAt: now,
        lastTriggeredAt: now,
        /**
         * The 3-minute deadline guards a *placeholder*; only the bind ends one.
         *
         * Clearing it unconditionally erased the deadline `claimTrigger` had just set, so the
         * expiry pass could never reclaim a lost claim: the lock stayed for good and every later
         * dispatch was refused. A placeholder now keeps its deadline; the bind clears it, because
         * from then on liveness is the heartbeat's job.
         */
        lockDeadlineAt: isPlaceholder ? (task.stats?.lockDeadlineAt ?? now + TRIGGER_CLAIM_MS) : undefined,
      },
      updatedAt: now,
    };
    if (task.status === 'paused') {
      next = { ...next, lifecycle: task.lifecycle };
    }
    this.save(next);
    this.registerRun(id, sessionId);
    appendJournal(this.root, id, {
      type: continuesRun && !isPlaceholder ? 'run_bound' : 'run_started',
      at: now,
      data: { sessionId },
    });
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
  resolveDecision(
    id: string,
    resolution: 'approved' | 'rejected' | 'obsolete',
    note?: string,
    decisionId?: string,
  ): Task {
    const task = this.require(id);
    const now = this.now();
    const all = allDecisions(task);
    const targets = decisionId
      ? all.filter((entry) => entry.id === decisionId)
      : all.filter((entry) => !entry.resolvedAt);
    if (!targets.length) return task;
    const queue = all.map((entry) =>
      targets.includes(entry)
        ? {
            ...entry,
            resolvedAt: now,
            resolution,
            ...(note?.trim() ? { reason: note.trim() } : {}),
          }
        : entry,
    );
    const next: Task = { ...task, decisions: queue, updatedAt: now };
    // `save` returns the derived record, and the mirror is part of that: without it the caller
    // reads a task whose `decision` still shows the open state it just closed.
    const saved = this.save(next);
    appendJournal(this.root, id, { type: 'decision_resolved', at: now, data: { resolution, note } });
    /**
     * The pause the decision created ends with the decision.
     *
     * Leaving it behind produced a task that claimed to be waiting for something that had already
     * been settled: `paused / asking`, no question, no answer, and — because every guard looks at
     * either an open decision or a running task — nothing that would ever look at it again.
     */
    return this.releaseDecisionPause(saved);
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
     * No auto-start at the ownership boundary.
     *
     * The plan says which profile owns each step, and this write used to start the next owner's
     * session the moment a step closed. That call always fired while this run still held the
     * task's lock — `startRun` refuses a second lock — so it was refused, logged, and swallowed
     * while the record said a session existed. The next leg is the supervisor's call now: the
     * hand-off wakes it with the next open step attached, and it decides whom to dispatch.
     */

    this.save(next);
    appendJournal(this.root, id, {
      type: 'plan_updated',
      at: now,
      data: { step: patch.id, status: patch.status, agent: patch.agent, removed: patch.remove === true },
    });

    return {
      ok: true,
      plan: result.plan,
    };
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
   * Close one round of a recurring task and leave it ready for the next trigger.
   *
   * Three things have to happen together, and each one was a bug on its own before:
   *
   *  1. The plan is snapshotted to the journal, then reset to `todo`. Without the reset the second
   *     round cannot be dispatched at all — `dispatch` refuses a step already recorded as done
   *     (`supervisor-runtime.ts:484`) and refuses a task whose plan is fully done (`:587`), so a
   *     round that ended with 1.1 done made minute two unreachable in both directions.
   *  2. The snapshot keeps the round readable. A reset that only erased the status would answer
   *     「so what did that round do」 with nothing, and the board would show an untouched plan on a
   *     task that just worked.
   *  3. The record goes back to `backlog`, which is 「registered, not running」. `completed` is
   *     where triggers stop; `running` would claim a lock nobody holds.
   *
   * The supervisor decides whether the task is still wanted — that decision is a `task_update`,
   * not a side effect of a round succeeding.
   */
  private closeRound(
    task: Task,
    options: {
      now: number;
      summary: string;
      result?: { artifacts?: string[]; verify?: { ran: string[]; passed: boolean }; data?: unknown };
    },
  ): Task {
    const { now, summary, result } = options;
    const plan = task.spec?.plan ?? [];
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const round = (stats.rounds?.ok ?? 0) + (stats.rounds?.failed ?? 0) + 1;

    const snapshot = plan.map((step) => ({ id: step.id, title: step.title, status: step.status }));
    appendJournal(this.root, task.id, {
      type: 'round_reset',
      at: now,
      data: { round, outcome: 'delivered', summary, plan: snapshot },
    });

    /**
     * One reset, in one place.
     *
     * Everything that described this round — its plan, its hand-off timeline, its sessions, its
     * acceptance counter — is cleared; what the next round continues from (`runs`, `rounds`,
     * `lastRound`) is kept. `resetRoundState` owns that decision so it can be tested directly;
     * this method only decides *when* a round is over.
     */
    const { task: reset, archivedSessionIds } = resetRoundState(
      task,
      // A recurring round does not inherit the plan it just finished: keeping the steps (even as
      // `todo`) let each round append its own section onto the last one until the plan described
      // history. The finished outline is in the journal entry above.
      { now, clearPlan: isRecurring(task) },
    );

    const closed: Task = {
      ...reset,
      stats: {
        ...(reset.stats ?? { runs: 0, activeMs: 0 }),
        rounds: { ok: (stats.rounds?.ok ?? 0) + 1, failed: stats.rounds?.failed ?? 0 },
        lastRound: { round, finishedAt: now, outcome: 'delivered', summary, ...(result ? { result } : {}) },
      },
    };

    const closedTask = applyTransition(closed, 'backlog', { now }).task;
    /**
     * Every session the round used goes with it, not just the last one.
     *
     * A round can dispatch several agents in turn — one per section — and each may open its own
     * conversation. The round is over for all of them at once, so archiving only `currentSessionId`
     * left the earlier ones alive and unreachable: nobody reuses them, nobody cleans them up.
     */
    for (const sessionId of archivedSessionIds) {
      if (sessionId.startsWith('pending:')) continue;
      this.deps.onRoundEnd?.(task.id, sessionId);
    }
    // The round is over and the trigger backlog is not: let it start now rather than at the next tick.
    this.deps.pokeScheduler?.();
    return closedTask;
  }

  /**
   * The one shape of "the run is over": release the lock, bank the active time.
   *
   * Pure on the record — the side effects (stopping the session, disposing the
   * run's resources) are applied by the callers through `disposeRun`, because a
   * handoff ends a run without stopping the worker that just reported it. Every
   * exit goes through here: the four scattered inline `lockSessionId: undefined`
   * sites were how a path forgot, and the lock leaked until the session died.
   */
  private releaseRunRecord(task: Task, now: number): Task {
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const elapsed = stats.runStartedAt ? Math.max(0, now - stats.runStartedAt) : 0;
    return {
      ...task,
      stats: {
        ...stats,
        activeMs: stats.activeMs + elapsed,
        lockSessionId: undefined,
        runStartedAt: undefined,
        lastHeartbeatAt: now,
        /**
         * The deadline belongs to the lock, so it goes with it.
         *
         * Live: a record ended up with `lockSessionId: undefined` and a stale `lockDeadlineAt`. The
         * expiry pass skips a task without a `pending:` lock — deliberately, that is how a real run is
         * left alone — so the orphaned deadline made the claim invisible: nothing could expire it, and
         * the task sat `running` with two triggers behind it. One field cannot outlive the other.
         */
        lockDeadlineAt: undefined,
      },
      lastHeartbeatAt: now,
      updatedAt: now,
    };
  }

  /**
   * Release the lock, bank the active time, and record the run's outcome.
   *
   * Called when a run ends for any reason that is not a pause — handoff verdicts
   * go through `reportHandoff`, which composes this with the hand-off bookkeeping;
   * a failed spawn or a lost leg ends here.
   */
  /**
   * Record a fired trigger and, if nothing is running, claim the round for the supervisor.
   *
   * Returns the task when the claim succeeded (the caller then wakes the supervisor), or null when
   * the trigger was only accumulated. Accumulation is not an error: a task that is running, waiting
   * for a person, or out of budget must not be restarted underneath itself — and the trigger still
   * happened, so dropping it would lose the fact that minute 17 fired at all.
   */
  claimTrigger(id: string, trigger: PendingTrigger): Task | null {
    const task = this.require(id);
    const now = this.now();
    const accumulated = [...(task.stats?.pendingTriggers ?? []), trigger];

    if (task.status === 'completed' || task.status === 'canceled') return null;

    /**
     * A paused task accumulates and nothing else.
     *
     * The pause that matters is 「有人在回答一个问题」, and waking the supervisor there would ask it
     * to dispatch around a decision the person has not given yet — the directive gate would refuse
     * the dispatch, so all it buys is a wasted turn and a supervisor reading 「继续吗」 about a
     * question it already asked. Whatever the trigger wanted is still owed, so it is recorded.
     *
     * Deliberately not derived from the lock: a pause written by the service releases the run lock
     * (the run is over), so 「lock still held」 cannot be the test for 「waiting for a person」.
     */
    if (task.status === 'paused' && !this.canRunWhilePaused(task, now)) {
      const next: Task = {
        ...task,
        stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), pendingTriggers: accumulated },
      };
      this.save(next);
      appendJournal(this.root, id, { type: 'trigger_accumulated', at: now, data: trigger });
      return null;
    }

    /**
     * A live run keeps the round.
     */
    /**
     * A round that is still open takes the firing as backlog, whatever the lock says.
     *
     * The lock is released by `reportHandoff` before the verdict decides what happens next, so
     * between a worker's delivery and the round's close there is a window with `status: running`,
     * no lock, and no session — and a firing that landed there claimed a *second* round. Live, one
     * round produced `pending:dispatch` at 08:18:38 and `pending:cron` at 08:20:26 for the same
     * 08:19:24 close: `runs` ran ahead of `rounds.ok` by exactly one per round, and `runs` is the
     * budget's clock.
     *
     * 「No lock」 means 「nobody is running this」 only when the round is over. While it is open, the
     * firing waits like any other.
     */
    const held = task.stats?.lockSessionId;
    const roundOpen = task.status === 'running';
    if (held || roundOpen) {
      const next: Task = { ...task, stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), pendingTriggers: accumulated } };
      this.save(next);
      appendJournal(this.root, id, { type: 'trigger_accumulated', at: now, data: trigger });
      return null;
    }

    const claim = this.startRun(id, `pending:${trigger.detail ?? trigger.kind}`);
    if (!claim.ok) {
      const next: Task = { ...task, stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), pendingTriggers: accumulated } };
      this.save(next);
      appendJournal(this.root, id, { type: 'trigger_accumulated', at: now, data: { ...trigger, refused: claim.reason } });
      return null;
    }

    /**
     * Each round generates its own steps.
     *
     * That is the intended shape: the supervisor decides what this round of work is, writes it as
     * steps, and the round is delivered when those steps are done. A plan carried over from the
     * previous round would pre-answer the question 「what is this round」, so nothing here freezes or
     * restores it.
     *
     * The stale steps are cleared where they would otherwise block the round: `closeRound` resets the
     * plan once a round is delivered, and a delivered report with anything still open is refused as
     * premature. What a round must not do is leave a half-finished plan behind, which is why the
     * reset is the system's job rather than the model's memory.
     *
     * Verification is still judged per round: this counter used to live for the life of the task, so
     * a per-minute task hit 「验收已跑满 3 轮」 on its fourth healthy round.
     */
    const claimed: Task = {
      ...claim.task,
      verifyRounds: 0,
      stats: {
        ...(claim.task.stats ?? { runs: 0, activeMs: 0 }),
        pendingTriggers: accumulated,
        lockDeadlineAt: now + TRIGGER_CLAIM_MS,
      },
    };
    this.save(claimed);
    appendJournal(this.root, id, { type: 'trigger_claimed', at: now, data: trigger });
    return claimed;
  }

  /**
   * Whether a paused task may be restarted by a trigger.
   *
   * 「Paused means waiting for a person」 was too broad. A pause is also what the record derives when
   * a run ends with work left and nobody running it (`awaiting_dispatch`) — and live, that pause
   * deadlocked a per-minute task: the plan was finished, the worker had filed `handoff`, the derived
   * pause stopped every later trigger at 「accumulate only」, and the person received one greeting
   * while three triggers piled up behind a pause nobody owed an answer to.
   *
   * The distinction is the gate, not the label: a pause that is really waiting for a decision is
   * refused by `startGate` (open decision, budget, fuse, dependency), and that refusal is the thing
   * worth respecting. A pause with nothing refusing it is just a task nobody picked up.
   */
  private canRunWhilePaused(task: Task, now: number): boolean {
    if (openDecisions(task).length > 0) return false;
    return this.startGate(task, now) === null;
  }

  /**
   * Record a fired trigger without claiming the round.
   *
   * For the case the scheduler can see but the task cannot: the supervisor is mid-turn, so a claim
   * would sit unused until it expired while the trigger that caused it was never answered. Recording
   * keeps the fact (the person's minute did fire) and leaves the round to the supervisor's next turn.
   */
  recordTrigger(id: string, trigger: PendingTrigger): void {
    const task = this.require(id);
    if (task.status === 'completed' || task.status === 'canceled') return;
    const now = this.now();
    this.save(
      {
        ...task,
        stats: {
          ...(task.stats ?? { runs: 0, activeMs: 0 }),
          pendingTriggers: [...(task.stats?.pendingTriggers ?? []), trigger],
        },
      },
      { silentTerminal: true },
    );
    appendJournal(this.root, id, { type: 'trigger_accumulated', at: now, data: trigger });
  }

  /** Push a pending claim's deadline out, for a supervisor turn that is still working. */
  extendTriggerClaim(id: string, deadline: number): void {
    const task = this.require(id);
    this.save({ ...task, stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), lockDeadlineAt: deadline } });
  }

  /** Give the claim back without a verdict; the backlog stays so the trigger is not lost. */
  releaseTriggerClaim(id: string, reason: string): void {
    const task = this.require(id);
    const now = this.now();
    this.save(this.endTriggerClaim(task, now), { silentTerminal: true });
    this.disposeRun(id, 'ended');
    appendJournal(this.root, id, { type: 'trigger_claim_released', at: now, data: { reason } });
  }

  /**
   * The claim is over and nothing ran.
   *
   * Only a `pending:` claim is owned by this path. A real run lock belongs to the worker: releasing
   * it here would free a round that is still executing, which is the exact concurrency the lock
   * exists to prevent — and the caller that clears a backlog runs right after a supervisor turn that
   * may have just dispatched.
   */
  private endTriggerClaim(task: Task, now: number): Task {
    const held = task.stats?.lockSessionId;
    if (held && !held.startsWith('pending:')) return task;

    const released = this.releaseRunRecord(task, now);
    /**
     * Giving the claim back does not end the round.
     *
     * This path is 「nobody picked this up」 — the supervisor was mid-turn, the wake failed. The
     * firing stays owed and the round stays where it was, so the marker that says 「a round is on the
     * clock」 has to survive: without it the next claim (the dispatch that finally comes) looks like
     * the start of a new round and counts a second run for the same one. Live: a per-minute task
     * reached `runs: 3` against `rounds.ok: 1`.
     */
    const cleared: Task = {
      ...released,
      stats: {
        ...(released.stats ?? { runs: 0, activeMs: 0 }),
        lockDeadlineAt: undefined,
        ...(task.stats?.runStartedAt ? { runStartedAt: task.stats.runStartedAt } : {}),
      },
    };
    return released.status === 'running' ? applyTransition(cleared, 'backlog', { now }).task : cleared;
  }

  expireTriggerClaim(id: string, now: number): void {
    const task = this.require(id);
    const released = this.endTriggerClaim(task, now);
    const failures = (task.stats?.wakeFailures ?? 0) + 1;
    this.save({ ...released, stats: { ...(released.stats ?? { runs: 0, activeMs: 0 }), wakeFailures: failures } }, { silentTerminal: true });
    this.disposeRun(id, 'ended');
    appendJournal(this.root, id, { type: 'wake_failed', at: now, data: { wakeFailures: failures } });
  }

  /** The trigger backlog, as the one paragraph the supervisor reads. */
  /**
   * What the supervisor is owed, grouped by kind.
   *
   * `excludeLast` is for the wake that a trigger itself caused: `claimTrigger` appends the firing
   * trigger to the backlog before anyone reads it, so the message 「本轮被触发」 was immediately
   * followed by 「累计待处理：定时 1 次」 describing that same trigger — the round explaining the
   * reason it exists. The record keeps the entry (it is proof the minute fired); only this rendering
   * leaves it out, because 「待处理」 has to mean 「还没被这次唤醒处理掉的」.
   */
  triggerSummary(id: string, options: { excludeLast?: boolean } = {}): string {
    const recorded = this.require(id).stats?.pendingTriggers ?? [];
    const pending = options.excludeLast ? recorded.slice(0, -1) : recorded;
    if (pending.length === 0) return '';
    const group = (kind: PendingTrigger['kind']) => pending.filter((entry) => entry.kind === kind);
    const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
    const lines: string[] = [];
    for (const [kind, label] of [['cron', '定时'], ['event', '事件'], ['manual', '手动']] as const) {
      const items = group(kind);
      if (items.length === 0) continue;
      const first = clock(items[0]!.at);
      const last = clock(items[items.length - 1]!.at);
      // 「10:19–10:19」 reads like a range a parser broke; one minute is one time.
      const span = first === last ? first : `${first}–${last}`;
      lines.push(`- ${label}：${items.length} 次（${span}）`);
    }
    if (lines.length === 0) return '';
    lines.push(`共 ${pending.length} 次待处理。`);
    return lines.join(NEWLINE);
  }

  /**
   * The supervisor read the backlog. Clear it — and give the claim back.
   *
   * Clearing the list alone left the pending claim behind with its deadline erased, so nothing could
   * expire it either: a supervisor that answered 「这一轮不派」 held the task's round forever and no
   * later trigger could start one. The reply is an answer, so the claim it answered ends here.
   */
  /**
   * The backlog went out in a message the supervisor will read.
   *
   * Called by both delivery paths — the trigger wake and the end-of-round report — so settling later
   * can tell 「this turn was shown these」 from 「these were only recorded」.
   */
  markTriggersDelivered(id: string, now = this.now()): void {
    const task = this.require(id);
    if (!task.stats?.pendingTriggers?.length) return;
    this.save(
      { ...task, stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), triggersDeliveredAt: now } },
      { silentTerminal: true },
    );
  }

  /**
   * Settle the backlog this turn was shown — not everything that happens to be in it.
   *
   * The list used to be emptied whole. A per-minute task adds a trigger every minute while a
   * supervisor turn is still running, so the entries that arrived *after* the message was composed
   * were cleared unseen: live at 11:5x, the message reported 「定时：2 次（11:52–11:53）」 and 11:54 and
   * 11:55 vanished with it. Nobody was ever asked about them.
   *
   * `triggersDeliveredAt` is the watermark of what the message contained, so everything up to it is
   * settled and everything after it stays owed. When something stays, the watermark is cleared with
   * it: those entries have not been shown yet, and the next turn must not settle them either.
   */
  clearTriggers(id: string, now = this.now()): void {
    const task = this.require(id);
    const pending = task.stats?.pendingTriggers ?? [];
    if (pending.length === 0) return;
    const deliveredAt = task.stats?.triggersDeliveredAt ?? now;
    const remaining = pending.filter((entry) => entry.at > deliveredAt);
    const cleared = this.endTriggerClaim(task, now);
    this.save(
      {
        ...cleared,
        stats: {
          ...(cleared.stats ?? { runs: 0, activeMs: 0 }),
          pendingTriggers: remaining,
          // Only reset when nothing is owed: a wake that was answered by someone else must not
          // silence 「the supervisor was woken and never replied」 for the entries still waiting.
          ...(remaining.length ? {} : { wakeFailures: 0 }),
          // Reset with the list it describes: a stale mark made the NEXT round's backlog look
          // already-delivered, so a turn that never saw it could settle it.
          triggersDeliveredAt: undefined,
        },
      },
      { silentTerminal: true },
    );
    appendJournal(this.root, id, {
      type: 'trigger_delivered',
      at: now,
      data: { cleared: pending.length - remaining.length, kept: remaining.length },
    });
  }
  /** A turn with no final reply leaves the backlog owed; three in a row is a fault. */
  noteWakeWithoutReply(id: string, now = this.now()): number {
    const task = this.require(id);
    const failures = (task.stats?.wakeFailures ?? 0) + 1;
    this.save({ ...task, stats: { ...(task.stats ?? { runs: 0, activeMs: 0 }), wakeFailures: failures } });
    appendJournal(this.root, id, { type: 'wake_without_reply', at: now, data: { wakeFailures: failures } });
    return failures;
  }

  endRun(id: string, outcome: { ok: boolean; error?: string; sessionId?: string }): Task {
    const task = this.require(id);
    const now = this.now();
    const stats = task.stats ?? { runs: 0, activeMs: 0 };
    const elapsed = stats.runStartedAt ? Math.max(0, now - stats.runStartedAt) : 0;
    const released = this.releaseRunRecord(task, now);
    const next: Task = {
      ...released,
      lifecycle: recordRunResult(task.lifecycle, outcome.ok, now, outcome.error),
      /**
       * A round that failed is a fact the person can use.
       *
       * `rounds.ok` is written when a round closes, so without this half the counter only ever said
       * 「worked twice」 on a task that also died twice — and the failure counter stayed zero on every
       * task that had only ever failed.
       */
      stats: {
        ...(released.stats ?? { runs: 0, activeMs: 0 }),
        ...(outcome.ok
          ? {}
          : { rounds: { ok: stats.rounds?.ok ?? 0, failed: (stats.rounds?.failed ?? 0) + 1 } }),
      },
    };
    /**
     * A released lock must not leave the task claiming to run.
     *
     * `releaseRunRecord` drops the lock but not the status, so a run that ended without a hand-off
     * sat at `running` with nobody running it — and the triggers that had banked behind that lock
     * (the design's 「触发积压」) had nothing to release them: the scheduler skips a task whose lock
     * is still held, and the next tick found no lock and no reason to start. Live: `pending` grew to
     * three and the task stayed `running` for good.
     *
     * Returning to `backlog` is 「registered, not running」, which is exactly the state the next
     * firing needs. The poke is what turns the banked triggers into a round now rather than at the
     * next minute boundary.
     */
    const parked = next.stats?.lockSessionId
      ? next
      : applyTransition(next, 'backlog', { now }).task;
    this.save(parked, { silentTerminal: true });
    this.disposeRun(id, 'ended');
    appendJournal(this.root, id, {
      type: 'run_ended',
      at: now,
      data: { ok: outcome.ok, activeMs: elapsed, error: outcome.error },
    });
    if (!next.stats?.lockSessionId) this.deps.pokeScheduler?.();
    return parked;
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
   * Deliberately does not touch `pauseReason`, `askedAt` or `deadlineAt`: this is wording,
   * not a state change. Answering still goes through the same guard.
   *
   * It does end the run, though — see the park below. A question for a person means nobody
   * works until the answer arrives, and the record alone cannot say that: `classifyPauseReason`
   * moves the status to `paused` on the next write, but the run's lock, its session and its
   * disposers belong to the runtime, not to the record.
   */
  setDecisionWording(
    id: string,
    wording: { question?: string; label?: string; options?: string[] },
  ): Task | null {
    const task = this.get(id);
    if (!task) return null;

    const now = this.now();
    const options = (wording.options ?? [])
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .slice(0, 4);

    /**
     * A question asked before the last answer was acted on is the same question again.
     *
     * Nothing in the wording separates 「是否继续？」 from a genuine follow-up, so the test is the
     * record: when the reply is the newest thing on the task and steps remain, nothing has happened
     * that a new question could be about. Reported live: answered at 06:08:59, asked again at
     * 06:09:01, and the reopen discarded the reply.
     */
    if (!task.decision || task.decision.resolvedAt) {
      if (answeredWithoutProgress(task)) return task
    }

    const all = allDecisions(task);
    const open = all.filter((entry) => !entry.resolvedAt);

    /**
     * A question arriving while another is open joins it, and a question arriving with none open
     * starts a new one in the same list.
     *
     * The list is append-only: answering one question must not overwrite the others, and a closed
     * question keeps its answer so the page can still show what was chosen. The old single slot was
     * replaced wholesale on every new question, which is how a second card took the first one's
     * reply with it.
     */
    const previous = open.at(-1) ?? all.at(-1)
    const entry: TaskDecision = {
      // A new question always gets its own identity: two open questions must be distinguishable,
      // or an answer cannot say which one it closes.
      id: newDecisionId(now, all.length),
      // A new question re-derives its own diagnosis; carrying the old one over is how a reopened
      // decision ended up quoting a condition that had already been satisfied.
      category: previous?.category ?? 'direction',
      label: wording.label?.trim() || previous?.label || '需要你决定',
      reason: previous && !previous.resolvedAt ? previous.reason : '',
      askedAt: now,
      deadlineAt: now + DECISION_TIMEOUT_MS,
      ...(wording.question?.trim() ? { question: wording.question.trim() } : {}),
      ...(options.length ? { options } : {}),
    }
    // One open entry per question: an open entry is updated in place, a closed one is followed by
    // a new entry.
    /**
     * A different question joins the queue; the same one is only re-worded.
     *
     * These are two different events and used to share one branch: re-wording keeps the entry's
     * identity and clock (restarting `askedAt` moved the deadline under a person who was mid-answer,
     * and gave an already-visible card a new identity), while a genuinely new question is appended
     * so the existing ones keep their answers.
     *
     * The queue is what makes 「几件事一起问」 possible: a worker hands back two failing checks, or a
     * boundary opens in two directions, and the person answers both before anybody acts on the first.
     */
    /**
     * The entry this wording belongs to — an unworded one, and nothing else.
     *
     * A worker's `needs_decision` hand-off creates a record with no words in it (the rule knows that
     * something must be asked, not what) and the supervisor then says it; those are one question and
     * belong on the existing entry.
     *
     * Beyond that, no wording is compared. Comparing it by text was tried and could not work: the
     * supervisor re-reads the task, rewrites the question with better options, and the two sentences
     * share no literal form — one real turn produced two cards for one unresolved situation, with
     * different buttons. Judging whether two phrasings are one question is interpretation, and the
     * place to answer it is a list the asker can see (`list_questions`), not a string comparison
     * that silently guesses.
     */
    const sameQuestion = open.length === 1 && !open[0]!.question?.trim() ? open[0] : undefined
    const queue = sameQuestion
      ? all.map((existing) =>
          existing === sameQuestion
            ? {
                ...existing,
                /**
                 * Identity must survive the wording, not just the journal.
                 *
                 * Records raised before ids existed at birth (and hand-written ones) reach
                 * this branch with none, and the journal alone does not make the entry
                 * answerable by id: `openDecisionIdFor` reads the record, so a worded entry
                 * without an id breaks the 「question was shown」 mark and the record-side
                 * flush draws the same card twice. `entry.id` is the id this wording would
                 * have been born with; adopting it here repairs the record without changing
                 * anything an id-bearing entry would have done.
                 */
                ...(existing.id ? {} : { id: entry.id }),
                ...(wording.label?.trim() ? { label: wording.label.trim() } : {}),
                ...(wording.question?.trim() ? { question: wording.question.trim() } : {}),
                ...(options.length ? { options } : {}),
              }
            : existing,
        )
      : [...all, entry]

    /**
     * A question asked while the run is going ends the run.
     *
     * The supervisor asks mid-slice as well as after a hand-off, and the two paths differ in
     * exactly one thing: whether a run is still alive. After a hand-off there is none — `reportHandoff`
     * ended it. Mid-slice there is, and parking the record without ending the run left a task that
     * was `paused` while a live session held its lock. Observed on a real run: the answer arrived,
     * `resumeRefusal` read the live lock, and the task could not resume until that session died —
     * 「运行已经由 sess_worker 持有」, on a task nobody was working on.
     *
     * `suspended` is the honest mode: the worker must stop producing work behind a question that
     * asks whether to continue. The record is released first so the same write cannot derive a
     * pause reason from a lock it is about to drop.
     */
    const parksRun = task.status === 'running' && queue.some((candidate) => !candidate.resolvedAt)
    const next = parksRun
      ? this.releaseRunRecord({ ...task, decisions: queue, updatedAt: now }, now)
      : { ...task, decisions: queue, updatedAt: now }
    const saved = this.save(next);
    if (parksRun) this.disposeRun(id, 'suspended');
    appendJournal(this.root, id, {
      type: 'decision_asked',
      at: now,
      /**
       * The id the record actually carries, not the one the journal would invent.
       *
       * In the update-in-place branch the stored identity is the existing entry's —
       * the id it was born with — so the journal must say that one, or the trail
       * and the record disagree about which question was asked.
       */
      data: {
        source: 'supervisor',
        question: wording.question,
        decisionId: sameQuestion ? (sameQuestion.id ?? entry.id) : entry.id,
        open: open.length,
      },
    });
    return saved;
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
  recordDecisionAnswer(id: string, text: string, decisionId?: string): Task | null {
    const task = this.get(id);
    if (!task) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    /**
     * Answer one question, by name.
     *
     * A task can be holding several open questions at once, and the reply closes exactly one of
     * them. Without `decisionId` the target is the newest open question, which is what a card
     * carries when it was raised before ids existed.
     *
     * The single slot this used to write meant a second question replaced the first — so answering
     * the first silently closed a question nobody had answered.
     */
    const all = allDecisions(task);
    const open = all.filter((entry) => !entry.resolvedAt);
    if (!open.length) return null;
    const target = decisionId ? open.find((entry) => entry.id === decisionId) : open.at(-1);
    if (!target) return null;
    /**
     * One question, one answer.
     *
     * The card guards this in the renderer with a `sent` flag, and that guard is not enough: two
     * surfaces show the same decision, and a second click can arrive from either — or from a window
     * that never saw the first one's state. Observed on a real run: the supervisor received the
     * same reply twice, 1.6s apart, and read it as two separate instructions.
     */
    if (target.answer) return null;

    const now = this.now();
    /**
     * Record the words. Do not interpret them.
     *
     * This used to run the reply through keyword tables to derive a boundary
     * (「完成 1.2 后暂停」 → ceiling 1.2, 「放行步骤 2」 → steps up to 2). That is not a thing text
     * matching can do: 「其余之后再定」 and 「其余都做」 share a word and mean opposite things,
     * 「停止剩下的任务」 was not in any table, and every miss was silent.
     *
     * `resolution: 'approved'` here means only "this question is closed" — it is not a claim about
     * what was authorised.
     */
    const queue = all.map((entry) =>
      entry === target
        ? { ...entry, answer: { text: trimmed, at: now }, resolvedAt: now, resolution: 'approved' as const }
        : entry,
    );
    /**
     * A person's words reached this task: stamp the contact.
     *
     * This is the one fact `resumeDecisionFor` cannot derive from the decision queue — an answer
     * is obviously human, but the timestamp is what lets a *later* question be compared against
     * 「did the person speak after it was asked?」. A scope write that closes a question without
     * this stamp unlocks nothing.
     */
    const next: Task = { ...task, decisions: queue, updatedAt: now, humanAuthAt: now };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'decision_answered',
      at: now,
      data: { text: trimmed, decisionId: target.id, stillOpen: queue.filter((e) => !e.resolvedAt).length },
    });
    /**
     * The pause ends only when nothing is left to answer.
     *
     * With another question still open the person is still being waited on, so the task stays
     * paused for a decision — releasing it there would have said 「nothing is owed」 while a card was
     * on screen. `save` derives the reason from the queue, so this needs no explicit reset.
     */
    return this.get(id)
  }

  /**
   * Stamp that a person's words reached this task — the machine's bookkeeping, not a model's claim.
   *
   * Called from the two relay entrances in `createTaskFromUser` (new task, follow-up). A model can
   * never call this; `task_update` has no path to it. That is the entire point: `humanAuthAt` is
   * the timestamp `resumeDecisionFor` and the dispatch gate compare against `askedAt`, and a
   * timestamp a model can write is a timestamp that proves nothing.
   */
  markHumanContact(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const next: Task = { ...task, humanAuthAt: now, updatedAt: now };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'human_contact',
      at: now,
      data: {},
    });
    return next;
  }

  /**
   * Mark answers as handed to the supervisor.
   *
   * Separate from recording them because the two are separated in time: answers accumulate while
   * questions are open, and are delivered in one message once nothing is left. Keeping the mark on
   * the record is what makes 「answered but not yet sent」 survive a restart — otherwise a crash
   * between the reply and the delivery would silently drop what the person said.
   */
  /**
   * Record that the person was told this task paused.
   *
   * Written before the wake is attempted, because the wake is the part that can die: a failed turn
   * must not turn into a stream of them. The wake is retried once through the supervisor's own
   * session; if that session is gone the notice is dropped, since the board still shows the pause.
   */
  markPauseAnnounced(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const next: Task = {
      ...task,
      stats: { ...task.stats, runs: task.stats?.runs ?? 0, activeMs: task.stats?.activeMs ?? 0, announcedPauseAt: now },
      updatedAt: now,
    };
    this.save(next);
    appendJournal(this.root, id, { type: 'pause_announced', at: now, data: {} });
    return next;
  }

  /**
   * Mark questions as shown to the person.
   *
   * The mirror of `markAnswersDelivered`, and it exists for the same two reasons. Questions are
   * collected while the turn runs and delivered once when it ends — so 「shown」 must survive a
   * restart (a crash between turn end and delivery must not lose the question) and must not be
   * repeated (a restart must not draw the same card twice).
   *
   * Clearing an in-memory list would satisfy the second and fail the first. The mark lives on the
   * record instead, and the pending set is what is left over: nothing to clear, because 「sent」 is
   * a fact about the entry.
   */
  markQuestionsDelivered(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const queue = allDecisions(task).map((entry) =>
      !entry.resolvedAt && entry.question?.trim() && !entry.questionDeliveredAt
        ? { ...entry, questionDeliveredAt: now }
        : entry,
    );
    const next: Task = { ...task, decisions: queue, updatedAt: now };
    this.save(next);
    appendJournal(this.root, id, {
      type: 'questions_delivered',
      at: now,
      data: { count: queue.filter((e) => e.questionDeliveredAt === now).length },
    });
    return next;
  }

  markAnswersDelivered(id: string): Task {
    const task = this.require(id);
    const now = this.now();
    const queue = allDecisions(task).map((entry) =>
      entry.answer && !entry.deliveredAt ? { ...entry, deliveredAt: now } : entry,
    );
    const next: Task = { ...task, decisions: queue, updatedAt: now };
    this.save(next);
    appendJournal(this.root, id, { type: 'answers_delivered', at: now, data: { count: queue.filter((e) => e.deliveredAt === now).length } });
    return next;
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
    // A heartbeat only makes the task look more alive: no rule can start matching
    // because of it, so it does not ask for a pass.
    this.save(next, { poke: false });
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
    /**
     * The run's session is the lock holder — `currentSessionId` is history, and a
     * task that is `running` while locked by nobody is exactly the anomaly the
     * watchdog exists to catch, so a heartbeat from an unlocked session must not
     * make it look alive.
     */
    const task = listTasks(this.root).find(
      (t) => t.status === 'running' && t.stats?.lockSessionId === sessionId,
    );
    if (!task) return null;
    return this.heartbeat(task.id);
  }

  /**
   * Record a session against the task.
   *
   * `options.round` also puts it in the round's list, which is what the budget counts and what a
   * close archives. Default false: an ad-hoc attachment (a manual dispatch, a test seeding history)
   * is history, not 「this round's executor」.
   */
  attachSession(id: string, sessionId: string, options?: { round?: boolean }): Task {
    const attached = attachSession(this.require(id), sessionId, this.now());
    const task = options?.round
      ? {
          ...attached,
          roundSessionIds: attached.roundSessionIds?.includes(sessionId)
            ? attached.roundSessionIds
            : [...(attached.roundSessionIds ?? []), sessionId],
        }
      : attached;
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
    /**
     * A running task with an open question is not running.
     *
     * The board said 「进行中」 and the watchdog agreed: it saw a task that claimed to be working
     * with nobody working, and woke the executor with 「继续任务 …」 — six minutes after a question
     * was asked and while the person was still deciding. The work then moved on and invented a
     * step, so the question stopped meaning anything.
     *
     * `paused` is the truthful state here: the run cannot continue until the answer arrives, and
     * the whole point of a pause is that nothing happens by itself. Deriving it (rather than asking
     * every caller to remember) is the same rule as the reason below: state is a function of the
     * record.
     */
    if (task.status === 'running' && openDecisions(task).length > 0) {
      const worded = openDecisions(task).some((entry) => entry.question?.trim())
      return { ...task, status: 'paused', pauseReason: worded ? 'needs_decision' : 'asking' }
    }

    /**
     * Nobody is running it, and the work is not finished.
     *
     * A worker can hand back its slice, pass the gate, and leave the plan with steps nobody
     * started — the next leg belongs to another agent, or the run simply ended. The record then
     * said `running` with no lock, no session, and no wake owed, which the board drew as 进行中.
     * Observed live: hand-off at 09:01:53, 「进行中」 until 09:09:04, nothing running in between.
     *
     * A state that cannot move by itself is a pause with a name, not a run in progress.
     */
    if (task.status === 'running' && this.awaitingDispatch(task)) {
      return { ...task, status: 'paused', pauseReason: 'awaiting_dispatch' }
    }

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
    const open = openDecisions(task);
    const openDecision = open.length > 0;
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
    if (!isDecisionish) return this.deriveGateReason(task);

    if (openDecision) {
      // 「等你决定」 needs at least one question with words on it; otherwise the words are still
      // being written and the honest label is 「等问句」.
      const worded = open.some((entry) => entry.question?.trim());
      return { ...task, pauseReason: worded ? 'needs_decision' : 'asking' };
    }

    const isDecisionPause = task.pauseReason === 'needs_decision' || task.pauseReason === 'asking';
    /**
     * Not a decision pause after all — a manual pause has no reason, and a reason may be a claim
     * about the budget, the fuse or a dependency. Those are derived, so this is where a pause with
     * nothing to say gets its label from the record.
     */
    if (!isDecisionPause) return this.deriveGateReason(task);

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
    if (allDecisions(task).length) return this.deriveGateReason({ ...task, pauseReason: null });
    return { ...task, pauseReason: 'asking' };
  }

  /**
   * Work is owed, and no run owns it.
   *
   * Two facts, both on the record: the plan has unfinished steps, and the last thing the task heard
   * was a work report rather than a question or a delivery. The lock is checked live because a
   * run that still owns the task is not waiting for anybody — that is what the lock means.
   */
  private awaitingDispatch(task: Task): boolean {
    const plan = task.spec?.plan;
    if (!plan?.length || planProgress(plan).complete) return false;
    const lock = task.stats?.lockSessionId;
    if (lock && this.deps.sessionExists(lock)) return false;
    /**
     * Only an accepted report parks the task here.
     *
     * A refused hand-off means the slice was not delivered — the worker still owes it and
     * retries within the same turn. Treating that attempt as 「the run is over」 parked the
     * task as `awaiting_dispatch` six seconds before the retry landed, which is a state
     * change the supervisor had to be told about for no reason.
     */
    const last = task.handoffs.at(-1);
    return Boolean(
      last &&
        last.passed !== false &&
        last.outcome !== 'needs_decision' &&
        last.outcome !== 'delivered',
    );
  }

  /**
   * Why a pause would refuse to resume — read from the record, not from the writer.
   *
   * The reasons a writer passed were true when it wrote them and stayed written after they stopped
   * being true: a task paused on `budget` kept saying 「预算用尽」 after the budget was raised, and a
   * task paused on `waiting` said so long after its dependency finished. Both are computable from
   * the record, so neither should be stored as a claim — the same argument the decision reasons
   * already won.
   *
   * `process_lost` is exempt: it says 「the process that was running this is gone」, which is an
   * event, not a condition, and the record no longer carries the evidence once the lock is released.
   * `awaiting_release` is exempt for the same reason — a person declared it, the record cannot.
   * Nothing in this service writes it any more: it used to be written by every accepted hand-off
   * (`sliceDeliveredButPlanOpen`), which made the exemption protect a stop no person declared.
   * It stays here so tasks recorded before that fix keep their label instead of silently turning
   * into `awaiting_dispatch` on the next write.
   *
   * The label comes from `resumeRefusal`, which is also what the start gate asks, so what the card
   * shows and what a refusal says can no longer be two different answers.
   */
  private deriveGateReason(task: Task): Task {
    if (task.pauseReason === 'process_lost') return task;
    // The acceptance cap is on the record (`verifyRounds` vs `maxIterations`), but no gate
    // re-derives it — keeping the label is what stops the pause from reading 「已暂停」 with no
    // reason after the first post-pause write.
    if (task.pauseReason === 'verify_exhausted') return task;
    // A person declared this one; the record cannot prove or disprove it.
    if (task.pauseReason === 'awaiting_release') return task;
    const refusal = resumeRefusal(task, {
      sessionExists: this.deps.sessionExists,
      getTask: (id) => this.get(id),
      now: this.now(),
    });
    /**
     * No refusal, but nothing is running either: the pause is 「waiting for someone to take it」.
     *
     * Derived the same way as the gate reasons so the label cannot be wiped by the next write —
     * the condition is read off the record, not remembered from the moment it was written.
     */
    const derived = refusal?.pauseReason ?? (this.awaitingDispatch(task) ? 'awaiting_dispatch' : null);
    if ((task.pauseReason ?? null) === derived) return task;
    return { ...task, pauseReason: derived };
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
   * Rename a task.
   *
   * A relayed task is created from the person's words, so the only name available at creation
   * is a truncation of the request — `T-1` was literally 「建一个任务，名字叫「状态图标验证」。
   * 执行计划写两条大纲：…」. The lane that reads those words can see what the task IS; it needs
   * a way to write that down. Nothing else may edit the name: it is the board's label and the
   * one field a worker reports against.
   */
  setName(id: string, name: string | undefined): Task {
    const task = this.require(id)
    const trimmed = name?.trim()
    if (!trimmed) return task
    const next: Task = {
      ...task,
      name: trimmed.slice(0, 120),
      updatedAt: this.now(),
    }
    if (next.name === task.name) return task
    this.save(next)
    appendJournal(this.root, id, {
      type: 'spec_updated',
      at: next.updatedAt,
      data: { name: next.name, previousName: task.name },
    })
    return next
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
      // New wording is a new object being judged: rounds spent against the old
      // list must not count towards the cap on the new one.
      verifyRounds: 0,
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
    return this.updateTriggers(id, trigger.kind === 'manual' ? [] : [trigger]);
  }

  /**
   * Replace the task's triggers.
   *
   * The write is a whole-list replacement, because that is what the caller knows: the person said
   * 「每晚九点」 and then 「再盯着 github」 — the second sentence adds a rule, and 「停了」 removes
   * them. Patching one entry at a time would need names these rules do not have.
   *
   * `trigger` (the single mirror every existing reader uses) is written from the list by
   * `normalizeTask`, so it cannot drift.
   */
  updateTriggers(id: string, triggers: TaskTrigger[]): Task {
    const task = this.require(id);
    const next: Task = { ...task, triggers, trigger: primaryTrigger(triggers), updatedAt: this.now() };
    this.save(next);
    appendJournal(this.root, id, { type: 'trigger_updated', at: this.now(), data: { triggers } });
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

    /**
     * A finished task does not take another report.
     *
     * `completed` and `canceled` are terminal everywhere else — `setAcceptance` refuses to edit
     * one, `remove` refuses to delete a live one — but this path accepted anything: a completed
     * task took a second and third `delivered`, appended them to `handoffs`, and woke the
     * supervisor each time. A live run showed three 「交接通过」 for one completion, and the user
     * lane read three copies of 「T-1 已全部完成」.
     *
     * The report is still answered (a worker mid-turn must not get an exception for reporting
     * correctly), but it changes nothing and tells nobody: the task ended when it ended.
     */
    if (TERMINAL_STATUSES.includes(task.status)) {
      log.info(`[tasks] handoff for ${task.status} task ${id} from ${fromSessionId} ignored`)
      return {
        task,
        handoff,
        passed: false,
        reasons: [`${id} 已经${task.status === 'completed' ? '完成' : '取消'}了，这次交接不再处理`],
        compactionPending: false,
      }
    }

    /**
     * The same report, again — answered without doing anything.
     *
     * `report_result` is a write with side effects: it appends a hand-off, banks the run, wakes the
     * supervisor. It is not idempotent, and the caller cannot tell 「did it land?」 from a timeout,
     * because a timeout means exactly that: the answer was lost, not that the work was not done.
     * The only sane thing a worker can do is retry — and the retry used to write a second hand-off
     * and wake the supervisor again.
     *
     * A retry is identifiable without guessing: same session, same outcome, and the plan has not
     * moved since the report it repeats. Nothing about the task changed, so the retry says nothing
     * new. Answering it with the previous verdict skips the acceptance gate too, which is the
     * expensive part — the very reason the first call timed out.
     *
     * A retry that carries real work is untouched: doing work moves a step, and any plan update
     * after the last hand-off means this is not the same report.
     */
    const lastAccepted = [...task.handoffs]
      .reverse()
      .find((entry) => entry.passed !== false && entry.fromSessionId === fromSessionId);
    if (lastAccepted && lastAccepted.outcome === handoff.outcome) {
      const planMovedSince = (task.spec?.plan ?? []).some(
        (step) => (step.updatedAt ?? 0) > lastAccepted.at,
      );
      if (!planMovedSince) {
        log.info(`[tasks] duplicate report for ${id} from ${fromSessionId} answered from the record`);
        return {
          task,
          handoff,
          passed: true,
          reasons: [],
          compactionPending: false,
        };
      }
    }

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
    // Terminal acceptance only: the model judge and the verify record are reserved
    // for the state where the plan is finished. `total > 0` keeps plan-less tasks
    // on the old path — with no plan there are no intermediate states, so every
    // hand-off is already the final one.
    const progress = planProgress(task.spec?.plan);
    const planOpen = progress.total > 0 && !progress.complete;

    if (handoff.outcome === 'delivered' && accepted && planOpen) {
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

    // Second layer: a requirement the commands cannot express is judged by a
    // model that only reads — never by the worker that wrote the handoff, and
    // only after the cheap rules passed.
    //
    // Terminal state only: an intermediate hand-off used to spawn a hidden
    // 「T-x 验收」 session per slice, judging work that was not finished yet.
    // `maxIterations` caps how many times the finished plan can be re-verified;
    // beyond that the decision belongs to a person, not another judge round.
    let verifyLimitReached = false;
    if (accepted && task.verify.requirement && this.deps.judgeHandoff && !planOpen) {
      const maxIterations = task.verify.maxIterations ?? 3;
      if ((task.verifyRounds ?? 0) + 1 > maxIterations) {
        verifyLimitReached = true;
        accepted = false;
        reasons.push(`验收已跑满 ${maxIterations} 轮，需要人工介入`);
        appendJournal(this.root, id, {
          type: 'verify_limit_reached',
          at: now,
          data: { rounds: (task.verifyRounds ?? 0) + 1, maxIterations },
        });
      } else {
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

    /**
     * The timeline belongs to the round in progress.
     *
     * A per-minute task appended one report per attempt per round and never dropped any, so after
     * twelve rounds the timeline was twelve rounds of attempts — for a repeating task that is the
     * history of the schedule, not of this round. The first report of a new round replaces the last
     * round's entries: `lastRound` is what the next round continues from, and every attempt is still
     * in the journal.
     */
    const roundInProgress = (task.stats?.rounds?.ok ?? 0) + 1;
    const keptHandoffs =
      task.stats?.handoffsRound === roundInProgress ? task.handoffs : [];

    let next: Task = {
      ...task,
      // The gate's verdict travels with the attempt: `handoffs` is the log, `passed` is
      // what makes 「filed a report」 different from 「tried and was refused」.
      handoffs: [...keptHandoffs, { ...handoff, passed: accepted, round: roundInProgress }],
      stats: { ...(task.stats ?? { runs: 1, activeMs: 0 }), handoffsRound: roundInProgress },
      updatedAt: now,
      lifecycle: recordRunResult(task.lifecycle, accepted, now, accepted ? undefined : reasons.join('; ')),
      // Intermediate hand-offs do not touch the verdict: 「验收：通过」 may not
      // appear before the plan is done, and the rounds cap below counts only
      // terminal acceptance.
      verify: planOpen
        ? task.verify
        : {
            ...task.verify,
            lastVerdict: accepted ? 'pass' : 'fail',
            ...(handoff.revision ? { lastVerifiedRevision: handoff.revision } : {}),
          },
      // `maxIterations` is the cap on terminal acceptance rounds — except across
      // a revision boundary, where the previous rounds were spent judging a
      // different object.
      verifyRounds: planOpen
        ? (task.verifyRounds ?? 0)
        : isNewRevision(task.verify, handoff.revision)
          ? 1
          : (task.verifyRounds ?? 0) + 1,
    };
    /**
     * A handoff ends the worker's run, but it does not end the round.
     *
     * The lock is released and the active time banked here, through the one release shape, before
     * any branch below re-parks the task — that ordering is deliberate, a hand-off must end the
     * worker's run whatever the verdict decides next.
     *
     * What must not end here is `runStartedAt`: this round is still open until the branches below
     * close or park it. Keeping it is what lets a claim that lands in this window recognise the
     * round it belongs to, instead of counting a second run for it. Live: a per-minute task reached
     * `runs: 8` against `rounds.ok: 6`, and `runs` is the budget's clock.
     */
    next = this.releaseRunRecord(next, now);
    /**
     * Keep the round open only when the branches below will close it.
     *
     * `delivered` is the one outcome that reaches `closeRound` in this call; every other outcome
     * parks the task (a question, another executor, a failure) and that park ends the round — so the
     * marker goes with it, or the next legitimate run would not be counted at all.
     */
    if (handoff.outcome === 'delivered') {
      next = { ...next, stats: { ...(next.stats ?? { runs: 0, activeMs: 0 }), runStartedAt: task.stats?.runStartedAt } }
    }
    this.disposeRun(task.id, 'ended');

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
            /**
             * Born with an identity.
             *
             * These machine-raised entries are wordless by design — the supervisor says the
             * words later, in `setDecisionWording`. That later write only updates the existing
             * entry in place, so an id missing at birth stays missing forever — and the card
             * identity lookup (`openDecisionIdFor`) then fails, which skips the
             * 「this question was shown」 mark and lets the record-side flush draw the same
             * card a second time. One question, two cards, no identity — the identity has to
             * exist before the wording does.
             */
            id: newDecisionId(now, allDecisions(next).length),
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
      /**
       * A recurring task finished a *round*, not the task.
       *
       * 「每分钟发一次你好」 ran once and closed: `delivered` wrote `completed`, and `completed` is
       * where every trigger stops (the scheduler skips completed/canceled), so minute two never
       * happened. The person asked for a loop and received one item.
       *
       * So the record is reset and returned to `backlog` — 「registered, not running」 — and the
       * supervisor, which already receives this report, decides whether the task is still wanted.
       * Closing it is a decision, not an automatic consequence of one round succeeding.
       */
      /**
       * `delivered` ends the round, never the task.
       *
       * It used to mean two things depending on `isRecurring()`: 「this round is over」 for a scheduled
       * task and 「the task is over」 for a one-off. The worker could not say which it meant — the record
       * decided by looking at whether a trigger happened to be configured — and the same sentence
       * produced a different outcome after someone edited the schedule. End-of-task is now a decision
       * the supervisor makes (`task_update(status: 'completed')`), so a round is a round for every task
       * and the only difference between the two kinds is what happens after the reset.
       */
      next = this.closeRound(next, {
        now,
        summary: handoff.summary,
        result: {
          ...(handoff.artifacts?.length ? { artifacts: handoff.artifacts.map((a) => a.path) } : {}),
          ...(handoff.verify ? { verify: handoff.verify } : {}),
          // The payload the next round compares against — this is the whole point of keeping
          // the round's delivery on the record rather than only in the journal.
          ...(handoff.roundResult !== undefined ? { data: handoff.roundResult } : {}),
        },
      });
    } else if (
      /**
       * A finished plan ends the round, whichever word the worker used.
       *
       * For a recurring task the plan *is* the round: when every step is done, this round is over.
       * Requiring the extra word `delivered` split the two facts apart, and live it deadlocked a
       * task — the worker finished 1.1 and 1.2 and filed `handoff` (correctly: its brief says a
       * partial part is a hand-off), the supervisor then had nothing to dispatch, nobody closed the
       * round, `rounds` stayed empty, and the task sat `paused` while triggers piled up. The person
       * received one greeting and nothing more.
       *
       * `handoff` still means 「someone else continues」 for a task that is not repeating — that path
       * keeps its own branches below.
       */
      accepted &&
      isRecurring(next) &&
      handoff.outcome === 'handoff' &&
      !planOpen
    ) {
      next = this.closeRound(next, {
        now,
        summary: handoff.summary,
        result: {
          ...(handoff.artifacts?.length ? { artifacts: handoff.artifacts.map((a) => a.path) } : {}),
          ...(handoff.verify ? { verify: handoff.verify } : {}),
          ...(handoff.roundResult !== undefined ? { data: handoff.roundResult } : {}),
        },
      });
    } else if (verifyLimitReached) {
      // The acceptance cap is a decision for a person, not another judge round.
      next = applyTransition(next, 'paused', { now, pauseReason: 'verify_exhausted' }).task;
      this.stopWorker(next);
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
          // Identity at birth — same reason as the needs_decision hand-off above.
          id: newDecisionId(now, allDecisions(next).length),
          category: 'direction',
          label: '原地打转',
          reason:
            `连续 ${SPIN_LIMIT} 次交接但计划没有推进（当前步骤：${currentStep(next.spec?.plan)?.id ?? '未规划'}）。` +
            '这通常意味着环境不允许或方向不对，需要人拍板。',
          askedAt: now,
          deadlineAt: now + DECISION_TIMEOUT_MS,
        },
      };
    } else if (accepted && handoff.outcome === 'handoff' && openSteps(next.spec?.plan ?? []).length > 0) {
      /**
       * A delivered slice with the plan still open is not a stop by the person.
       *
       * This branch used to park the task as `paused / awaiting_release`, on the reading that
       * 「the authorised slice is delivered and the rest is nobody's call」. It cannot know that:
       * the only test was `openSteps(plan).length > 0`, so *every* hand-off of a multi-step plan
       * parked the task, and every such pause claimed 「按你的话停了」 about an instruction that
       * said the opposite (「每节完成交接后继续下一节，全部完成即结束」).
       *
       * Live cost, twice in one day: T-1 handed off 1.1, the supervisor dispatched 2.1, and the
       * dispatch was refused — 「T-1 现在是暂停状态，而且没有覆盖这次继续的授权」 — because the
       * pause it had just written looked like the person's decision. The supervisor then did the
       * only thing left and asked the user whether to continue, on a task that was never stuck.
       * The person's own words were already 「继续下一节」.
       *
       * `deriveGateReason` keeps `awaiting_release` untouched for the documented reason — 「a person
       * declared it, the record cannot disprove it」 — which only holds if a person is the one who
       * declares it. A system that writes it on its own makes that exemption a lie, and every
       * ordinary hand-off inherits it.
       *
       * What the record actually says here is 「the slice landed, the plan is open, nobody took the
       * next leg」 — which is a state this codebase already has a name for, derived rather than
       * stored: `awaiting_dispatch`. Leaving the transition out is enough; `classifyPauseReason`
       * derives it on the next save, and the watchdog already skips that state because the next
       * move there belongs to the supervisor, not to a person.
       */
      appendJournal(this.root, id, {
        type: 'slice_delivered',
        at: now,
        data: { remaining: openSteps(next.spec?.plan ?? []).map((step) => step.id) },
      });
    }

    /**
     * Decide whether this hand-off belongs on the timeline.
     *
     * The question is what this hand-off implies: "the plan now belongs to
     * another agent" is a fact about the plan, not about any spawn. Attempts that
     * changed nothing stay in `handoffs` — the spinning detector reads every one
     * of them — but the timeline stops showing them, which is the difference
     * between a log of attempts and a history.
     */
    const nextLegRead = nextLeg(next.spec?.plan)
    // Only a step has an owner: an unexpanded section is not assigned to anyone yet.
    const nextLegOwner = nextLegRead?.kind === 'step' ? nextLegRead.agent : undefined
    const milestone =
      handoff.outcome === 'needs_decision' ||
      next.status !== task.status ||
      compactionPending ||
      /**
       * A named owner that differs from the current one — `sameAgent`, and only when the task
       * has an assignee to compare with.
       *
       * `nextLegOwner !== undefined` was always true for a task the scheduler dispatched
       * without a named agent, so every hand-off looked like 「someone else took over」 and
       * every refusal became a milestone the supervisor had to be woken for.
       */
      Boolean(
        nextLegOwner &&
          next.assigneeAgentId &&
          !sameAgent(nextLegOwner, next.assigneeAgentId),
      )
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

    // No auto-start after a hand-off.
    //
    // The system used to start the next owner's session right here (and, before that, from
    // inside the worker's own plan write) — the plan said who, so asking the supervisor looked
    // like paying a model call to read a field. But the field is not the decision: it cannot
    // see 「用户说只做 1.1，做完就停」, and both auto-starts kept ignoring exactly that.
    //
    // The supervisor decides what comes next: the nudge below carries the next open step and
    // its owner, and the model chooses whether to dispatch it, ask the user, or end the task.
    /**
     * A round that just closed has nothing to dispatch.
     *
     * `next` is read after the round-level writes, so `status: 'backlog'` here means this hand-off
     * ended a round — the plan is already reset for the next trigger. Offering 「还剩 N 步，派下一节」
     * in that case is what made a live supervisor try to dispatch a step that had just been
     * completed, get refused, and conclude the trigger message was stale.
     */
    const roundClosed = next.status === 'backlog';
    const leg =
      accepted && handoff.outcome === 'handoff' && !roundClosed ? nextLeg(next.spec?.plan) : undefined;
    const suggestedStep = leg?.kind === 'step' ? leg : undefined;

    /**
     * Only the supervisor decides what the user sees; the worker never does.
     *
     * The nudge follows `milestone` — the record's own answer to 「did this hand-off change
     * anything a person needs to see」. It is not "every call to report_result":
     *
     *   accepted                  → the step landed            → tell
     *   refused, task still running → the worker will retry     → do not tell
     *   refused, but it paused the task / tripped the fuse / spun in place → tell
     *
     * Observed live: 1.2 was refused at 11:10:38 for a missing `artifacts` list, retried
     * and accepted at 11:10:44. The supervisor was woken twice for one step and had to
     * re-read the task to find out that nothing was wrong. The refusal is feedback to the
     * worker — it arrives in the same turn, with the reason — not news for the supervisor.
     *
     * A worker that gives up after a refusal is still covered: its rejected attempt no
     * longer counts as 「filed this run」 (`Handoff.passed`), so the watchdog's
     * 「stopped and never filed」 rule wakes the supervisor the moment the turn ends.
     *
     * The nudge always carries the next open step so the supervisor can decide: the system no
     * longer auto-starts the next leg (see the block above), which is why the model's decision
     * — dispatch it, ask the user, or end the task — is the only thing that starts work again.
     */
    /**
     * Tell the supervisor when the task's state changed, or when the slice landed.
     *
     * Three answers, one predicate:
     *   accepted                    → the step landed             → tell
     *   refused, state unchanged    → the worker will retry        → do not tell
     *   refused, state changed      → paused / fuse / spinning     → tell
     *
     * `milestone` alone is not enough: it answers 「does this belong on the timeline」, and a
     * plain accepted hand-off that keeps the task running with the same owner is not a
     * milestone — but it is exactly the news the supervisor is waiting for.
     */
    if (accepted || milestone) {
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
      const openSteps = (next.spec?.plan ?? []).filter((step) => step.status !== 'done')
      /**
       * The next move is a dispatch, unless the person's own words say otherwise.
       *
       * This used to read 「请决定：dispatch 派发该步 / 询问用户 / 结束任务」, which offers
       * 「ask the person」 as a peer of the obvious next action. Combined with the pause that
       * used to be written beside it (`awaiting_release`, 「按你的话停了」), the supervisor read the
       * two together as 「the run stopped and the person must release it」 and asked — on tasks
       * whose instruction already said 「每节完成交接后继续下一节」. Two live runs, same question.
       *
       * Phrased as the default instead: continue, and interrupt only for the two reasons that are
       * actually the person's — his own stated boundary, or a decision only he can make.
       */
      const nextHint = suggestedStep
        ? `。计划还剩 ${openSteps.length} 步，下一步 ${suggestedStep.step.id}（${suggestedStep.agent ?? '未指定 owner'}）——除非用户的话把边界在这里，否则直接 dispatch 派发它；只有用户的边界已到、或必须他拍板时才问他。`
        : roundClosed
          ? `。本轮到此结束，计划已复位，下一次触发会自动开下一轮——现在不用派活。`
          : ''
      /**
       * Triggers that fired during the round ride along with the report.
       *
       * The point of accumulating them is that this turn is where the supervisor can act on them:
       * the round is over, the lock is free, and the answer 「not this one, but keep going」 belongs
       * here. Deferring them to the next tick would ask the same question a minute later with the
       * person waiting in between.
       */
      /**
       * The watermark is taken before the summary is read, not after.
       *
       * `clearTriggers` settles what the message contained by comparing each entry against this
       * instant. Reading the list first and stamping later left the window between the two open: a
       * trigger arriving in it was neither in the message nor above the watermark, so it was cleared
       * unseen. Stamping first can only over-deliver (an entry listed and kept one round), which is
       * recoverable; under-delivering loses a firing the person asked for.
       */
      const backlogReadAt = this.now()
      const triggerBacklog = this.triggerSummary(id)
      if (triggerBacklog) this.markTriggersDelivered(id, backlogReadAt)
      const triggerHint = triggerBacklog
        ? `。\n\n本轮期间累计的触发：\n${triggerBacklog}\n本轮已经结束，这些触发不用在本轮补派——下一次触发会正常开新的一轮。`
        : ''
      this.deps.wakeSupervisor(
        next.supervisorSessionId,
        verifyLimitReached
          ? `${id} 终态验收已跑满 ${task.verify.maxIterations ?? 3} 轮仍未通过，任务已暂停。请 report_to_user 告知用户，由人决定重开验收还是修改验收要求。`
          : pending
            ? `${id} 现在需要用户拍板（${pending.label}）：${pending.reason} 请用 report_to_user 带 kind=decision 告知用户。`
            : accepted
              ? `${id} 交接通过：${handoff.summary}${nextHint}${triggerHint}`
              : `${id} 交接未通过（${reasons.join('；') || handoff.outcome}）：${handoff.summary}${triggerHint}`,
        // One subject per task and outcome: a second failure notice about the same task is the same
        // fact restated, and a queue that stacks them makes the supervisor act twice.
        `${id}:${verifyLimitReached ? 'verify-limit' : pending ? 'decision' : accepted ? 'handoff-pass' : 'handoff-fail'}`,
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

  /**
   * Runtime resources of a live run, keyed by task.
   *
   * The run owns things the task record must not carry: the session it drives, timers,
   * background shells registered by the host. They are disposed when the run ends —
   * reverse order, each failure logged, never thrown into the write path. This is the
   * smallest version of a scope: `startRun` creates the handle, every release path
   * destroys it, and a leaked run can never leave its resources behind.
   */
  private readonly runRegistry = new Map<string, RunHandle>();

  private registerRun(taskId: string, sessionId: string): RunHandle {
    let handle = this.runRegistry.get(taskId);
    if (!handle) {
      handle = { sessionId: undefined, disposers: [] };
      this.runRegistry.set(taskId, handle);
    }
    handle.sessionId = sessionId;
    return handle;
  }

  /**
   * Register a resource for the current run, disposed when it ends.
   *
   * `mode` tells the disposer how the run ended: `suspended` (paused/canceled/
   * process lost — the session must stop producing work) or `ended` (handoff,
   * verdict, failed spawn — the session may be finishing its report, leave it).
   */
  onRunDispose(taskId: string, dispose: (mode: 'suspended' | 'ended') => void): void {
    let handle = this.runRegistry.get(taskId);
    if (!handle) {
      handle = { sessionId: undefined, disposers: [] };
      this.runRegistry.set(taskId, handle);
    }
    handle.disposers.push(dispose);
  }

  /**
   * Tear down a finished run: registered disposers first, then — for a run that
   * was interrupted rather than finished — stop the session it owned. A session
   * left running after a pause kept producing work for a task nobody owns.
   */
  private disposeRun(taskId: string, mode: 'suspended' | 'ended'): void {
    const handle = this.runRegistry.get(taskId);
    if (!handle) return;
    this.runRegistry.delete(taskId);
    for (const dispose of [...handle.disposers].reverse()) {
      try {
        dispose(mode);
      } catch (error) {
        log.warn(`[tasks] run disposer failed for ${taskId}`, { error: String(error) });
      }
    }
    if (mode === 'suspended' && handle.sessionId && !handle.sessionId.startsWith('pending:')) {
      if (this.deps.stopSession) {
        try {
          this.deps.stopSession(handle.sessionId);
        } catch (error) {
          log.warn(`[tasks] could not stop the worker of ${taskId}`, { error: String(error) });
        }
      }
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
      /**
       * A trigger claim is not a run that died.
       *
       * `pending:…` is a placeholder for a round the supervisor has not started yet — it never had a
       * session, so `sessionExists` is false by construction. Sweeping it up as `process_lost` paused
       * the task at startup, and a paused task only accumulates triggers: the round the person was
       * waiting for became a pause nobody would release. The same misread cost a live run on the
       * watchdog side; this is the startup copy of it.
       *
       * Left alone, the claim expires on its own deadline and the next tick asks again.
       */
      if (lockId?.startsWith('pending:')) continue;
      /**
       * A recovered run re-enters the registry: it is as much a run as a fresh
       * one, and its disposers (including the session stop on a later pause) are
       * owed the same as a run claimed by `startRun`.
       */
      if (lockId) this.registerRun(task.id, lockId);
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
    const released = this.releaseRunRecord(task, now);
    const paused = applyTransition(released, 'paused', { now, pauseReason: 'process_lost' }).task;
    this.save(paused);
    this.disposeRun(task.id, 'suspended');
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
  /** Task ids whose terminal state has already been announced to the host. */
  private readonly terminalAnnounced = new Set<string>();

  private save(task: Task, options?: { poke?: boolean; silentTerminal?: boolean }): Task {
    const derived = this.classifyPauseReason(syncDecisionMirror(task));
    saveTask(this.root, derived);
    this.notifyChanged();
    /**
     * Every write is a fact the watchdog reads, so every write asks it to look.
     *
     * The one exception is a heartbeat: it can only make a task look more alive, so
     * the pass would find strictly less than the one before it, and heartbeats are
     * the only write frequent enough for the passes to be visible in the log.
     */
    if (options?.poke !== false) this.deps.pokeWatchdog?.();
    /**
     * A fact that changes elsewhere still changes this record's label.
     *
     * `waiting` is derived from a dependency's status, so the moment that dependency completes the
     * pause stops meaning anything — but nothing writes the waiting task, so the derivation would
     * never run and the board would keep saying 「等待中」 for a task that is free to go. Completion
     * is the only event that can invalidate another task's reason, and it happens once.
     */
    if (derived.status === 'completed') this.releaseDependents(derived.id);
    /**
     * A finished task leaves nothing to reuse.
     *
     * The worker session outlives the round — that is the point of reusing it — but not the task:
     * once the record is terminal, every further round is impossible and the session is just a
     * closed conversation still listed as active. The record cannot archive it, so it asks the host
     * that owns sessions.
     */
    /**
     * Announce a terminal state once, not on every write.
     *
     * `save` is the only write path, so a condition on 「is terminal」 alone fired on every heartbeat,
     * every plan edit and every watchdog bookkeeping write on a finished task — the host then re-ran
     * its archiving each time. The transition is what the host cares about; the flag is cleared as
     * soon as the task leaves the terminal set, so a reopened task can be announced again.
     */
    if (TERMINAL_STATUSES.includes(derived.status) && !options?.silentTerminal) {
      if (!this.terminalAnnounced.has(derived.id)) {
        this.terminalAnnounced.add(derived.id);
        this.deps.onTaskTerminal?.(derived);
      }
    } else {
      this.terminalAnnounced.delete(derived.id);
    }
    return derived;
  }

  /** Re-derive the label of every paused task that was waiting on `completedId`. */
  private releaseDependents(completedId: string): void {
    for (const other of listTasks(this.root)) {
      if (other.status !== 'paused' || other.pauseReason !== 'waiting') continue;
      if (!(other.dependsOn ?? []).includes(completedId)) continue;
      const refreshed = this.classifyPauseReason(other);
      if (refreshed.pauseReason === other.pauseReason) continue;
      saveTask(this.root, refreshed);
      this.notifyChanged();
    }
  }

  private require(id: string): Task {
    const task = loadTask(this.root, id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }
}
