/**
 * Supervisor runtime.
 *
 * Owns the coordination state that must survive a turn:
 *
 *  - which session is on duty for a workspace,
 *  - the unclaimed-event backlog (merged, bounded),
 *  - the per-turn dispatch guards,
 *  - the handoff → next-session bridge.
 *
 * It deliberately holds no chat state: the supervisor's context lives in its
 * session transcript, and nothing here needs to know what it said.
 */

import { createLogger } from '@craft-agent/shared/utils';
import {
  assertDispatchAllowed,
  DispatchRefused,
  EventBacklog,
  formatBacklogNudge,
  MAX_DISPATCHES_PER_TURN,
  newGuardState,
  newTurnState,
  type SupervisorGuardState,
  type SupervisorTurnState,
  type QueuedActivation,
} from '@craft-agent/shared/agents/supervisor';
import { loadRoutes, matchRoute, formatRouteInstruction, formatRouteRuleIssue, ruleParallelism } from '@craft-agent/shared/routing';
import { readAgentRoster } from '@craft-agent/shared/agents';
import { isTerminal, resumeDecisionFor } from '@craft-agent/shared/tasks';
import { DispatchQueue } from './dispatch-queue.ts';

const log = createLogger('supervisor');

export interface SupervisorSessionInfo {
  id: string;
  role: 'supervisor' | 'worker';
  spawnDepth?: number;
  agentId?: string;
  /**
   * Task this session is working on, if any.
   *
   * Needed to enforce "every dispatched unit of work is a task": sending an
   * instruction to a session that has no task would be work with no record, and
   * that used to be allowed simply because nothing checked.
   */
  taskId?: string;
  /** True while the session is mid-turn. */
  isProcessing: boolean;
}

export interface SupervisorRuntimeDeps {
  workspaceRoot: string;
  /** Find or lazily create the workspace's on-duty supervisor. */
  ensureSupervisorSession: () => Promise<SupervisorSessionInfo | null>;
  getSession: (sessionId: string) => SupervisorSessionInfo | null;
  /** Create a worker session and start it with `instruction`. */
  spawnWorker: (params: {
    name?: string;
    agentId?: string;
    scope: string;
    instruction: string;
    taskId?: string;
    spawnDepth: number;
    /** Working directory the worker must run in (from a routing rule). */
    cwd?: string;
    /** Skills the worker must follow (from a routing rule). */
    skills?: string[];
  }) => Promise<{ sessionId: string }>;
  /** Send a message into an existing session (wakes it if idle). */
  sendToSession: (sessionId: string, text: string) => Promise<void>;
  /**
   * Mark the task as running in `sessionId`, exactly as the spawn path does.
   *
   * Send-to-existing-session was the one dispatch shape that claimed nothing, so a task could be
   * `paused` while its worker did the work: the run was never recorded, and the hand-off that
   * followed was refused as `paused → completed`. The refusals are the task service's to make —
   * `claimTaskRun` only reports them.
   */
  claimRun?: (taskId: string, sessionId: string) => void;
  /** Diagnostics for routing decisions that change who runs the work. */
  logDispatch?: (message: string) => void;
  /**
   * The last hand-off for a task, rendered as a block.
   *
   * Dispatching the next step into an existing session used to send the
   * supervisor's instruction and nothing else, so the recorded findings, next
   * action and artifacts never reached the session that had to act on them. The
   * text is built by the caller because it knows how to read a task.
   */
  handoffContext?: (taskId: string) => string | undefined;
  /** Record a user-visible message on the supervisor's transcript. */
  writeToSupervisor: (sessionId: string, text: string) => Promise<void>;
  /** Ask the user (surfaced as a question card / message). */
  askUser: (supervisorSessionId: string, questions: { question: string; options?: string[] }[]) => Promise<void>;
  /** Resolve a task by id (for task targets). */
  getTask?: (taskId: string) => {
    id: string;
    currentSessionId?: string;
    /** Profile the task is assigned to; absent means the workspace default. */
    assigneeAgentId?: string;
    /**
     * Read by the scope boundary gate: whether a scope was written, what the plan
     * still has open, and whether work under the scope was already delivered.
     * Narrowing this back to id/session silently disables that gate.
     */
    spec?: {
      scope?: string;
      plan?: Array<{ id: string; status?: string }>;
      /** Read by `resumeDecisionFor`: the instruction the person's reply was turned into. */
      directive?: { text: string; at: number };
    };
    handoffs?: Array<{ outcome?: string; at?: number }>;
    /**
     * Read by `resumeDecisionFor` — the same verdict the run gate reads.
     *
     * Without these three, dispatch could not tell 「paused because nobody authorised it」 from
     * 「paused but the answer is already written down」, so it demanded a status flip, and a
     * status flip starts a run.
     */
    status?: string;
    /** The newest open decision's mirror; `askedAt` is what `resumeDecisionFor` compares against. */
    decision?: { askedAt?: number; label?: string; resolvedAt?: number; answer?: { text?: string; at?: number } };
    /**
     * Last time a person's words reached this task, machine-stamped. Read by
     * `resumeDecisionFor` — without it a question closed without an answer looks settled.
     */
    humanAuthAt?: number;
  } | null;
  /** Start a task by id; returns true when a run actually began. */
  runTask?: (taskId: string, reason: string) => Promise<boolean>;
  /** Start every task whose event trigger matches; returns how many started. */
  startEventTasks?: (event: {
    source: string;
    type: string;
    title?: string;
    summary?: string;
  }) => Promise<number>;
}

export class SupervisorRuntime {
  private backlog = new EventBacklog();
  /**
   * Per-turn state, one slot per supervisor session.
   *
   * The runtime is per workspace — routes, the event backlog and the per-rule ceilings are
   * workspace facts — but a turn belongs to one conversation. One slot shared by both lanes
   * meant the user lane's turn ending drained the task lane's queue, and the notice about a
   * failed dispatch went to whichever supervisor happened to finish first.
   */
  private readonly turnStates = new Map<string, SupervisorTurnState>()
  /**
   * Cross-turn state, also per session.
   *
   * Kept apart from the turn state because it must survive `beginTurn`: the ping-pong guard
   * compares this turn's instruction with the last one sent, which is a fact about earlier turns.
   */
  private readonly guardStates = new Map<string, SupervisorGuardState>()
  /** Cached on-duty supervisor id, refreshed lazily. */
  private onDuty?: string;
  /**
   * Per-rule concurrency ceiling.
   *
   * Keyed by rule name and capped by `rule.to.parallel`. A second event of the
   * same kind waits instead of starting a second worker, which is what keeps a
   * burst of related events from multiplying into parallel agents.
   */
  private readonly dispatchQueue = new DispatchQueue((key) => this.ruleCaps.get(key) ?? 1);
  private readonly ruleCaps = new Map<string, number>();

  constructor(private readonly deps: SupervisorRuntimeDeps) {}

  /**
   * Release per-workspace state.
   *
   * Kept because the workspace lifecycle calls it on teardown. It used to clear
   * the cap-backoff timer; with the per-turn cap gone there is nothing to release
   * yet, and an empty method is honest about that — deleting it would only move
   * the no-op to the caller.
   */
  dispose(): void {
    // Workspace teardown: the sessions those slots belong to are going away with it.
    this.turnStates.clear();
    this.guardStates.clear();
  }

  // ------------------------------------------------------------
  // Events
  // ------------------------------------------------------------

  /**
   * Tier 3 of the funnel: an event nobody subscribed to.
   *
   * Rules run first (deterministic, no model). Only what the rules cannot
   * decide reaches the supervisor, and even then it is queued and merged rather
   * than spending a turn per message.
   */
  async routeUnclaimed(event: {
    id: string;
    source: string;
    type: string;
    title: string;
    summary?: string;
  }): Promise<'routed' | 'queued'> {
    const rules = loadRoutes(this.deps.workspaceRoot);
    const decision = matchRoute(
      { source: event.source, type: event.type, title: event.title, summary: event.summary },
      rules,
    );

    // There is no opt-out tier: an event nobody subscribed to goes to the
    // supervisor, full stop. "No rule mentions this source" (ignore) routes the
    // same as "a rule exists but could not decide" (unknown) — dropping silent
    // drops made the third tier unreachable on any workspace without
    // routes.json, which the delivery test caught. The backlog merge below is
    // the flood guard.

    if (decision.kind === 'match') {
      const instruction = formatRouteInstruction(decision.rule);
      const text = `[event] ${event.title}${event.summary ? `\n${event.summary}` : ''}\n\n${instruction}`;
      // A rule may name a task instead of a session: the task owns execution,
      // so "route to task" means "start that task", not "find its session".
      const taskId = decision.rule.to.taskId;
      if (taskId && this.deps.runTask) {
        const started = await this.deps.runTask(taskId, `event:${event.source}/${event.type}`);
        if (started) return 'routed';
      }
      const targetSession = decision.rule.to.sessionId
        ?? (await this.resolveSessionForAgent(decision.rule.to.agentId));
      if (targetSession) {
        await this.deps.sendToSession(targetSession, text);
        return 'routed';
      }

      // Rule names an agent with no live session: start one, under this rule's
      // concurrency ceiling. `parallel: 1` (the default) means the next event of
      // the same kind queues rather than fanning out.
      if (decision.rule.to.agentId) {
        // A rule naming a role that does not exist must stop here, not spawn.
        // `spawnWorker` would create the session anyway — `getAgentById` treats a
        // missing id as "use the workspace default" — so the event would be
        // handled by a persona the rule never asked for, and the only trace would
        // be a session whose persona looks wrong. Sending the event to the
        // supervisor with the reason attached keeps the work and reports the bug.
        const wantedAgent = decision.rule.to.agentId.trim();
        const known = new Set(readAgentRoster(this.deps.workspaceRoot).map((entry) => entry.id));
        if (!known.has(wantedAgent)) {
          const notice = formatRouteRuleIssue({ rule: decision.rule.name, agentId: wantedAgent });
          log.error(`[supervisor] ${notice}`);
          this.backlog.push({
            id: event.id,
            summary: `${event.source}/${event.type}: ${event.title} — ${notice}`,
          });
          await this.drainToSupervisor();
          return 'queued';
        }

        const key = decision.rule.name;
        this.ruleCaps.set(key, ruleParallelism(decision.rule));
        const outcome = await this.dispatchQueue.submit(key, {
          run: async () => {
            try {
              const created = await this.deps.spawnWorker({
                name: decision.rule.name,
                agentId: decision.rule.to.agentId,
                scope: key,
                instruction: text,
                spawnDepth: 1,
                ...(decision.rule.to.cwd ? { cwd: decision.rule.to.cwd } : {}),
                ...(decision.rule.to.skills?.length ? { skills: decision.rule.to.skills } : {}),
              });
              return created.sessionId;
            } catch (error) {
              log.warn(`[supervisor] rule "${key}" failed to start a worker`, {
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }
          },
        });
        if (outcome === 'started' || outcome === 'queued') return 'routed';
      }

      // Rule named an agent with no live session: fall through to the supervisor
      // rather than silently dropping an event the user asked to handle.
      log.warn(`[supervisor] rule "${decision.rule.name}" has no live session; falling back`);
    }

    // Task-level event triggers are consulted even without a routing rule: the
    // trigger lives on the task, so there is nothing to duplicate in routes.json.
    if (this.deps.startEventTasks) {
      const started = await this.deps.startEventTasks({
        source: event.source,
        type: event.type,
        title: event.title,
        summary: event.summary,
      });
      if (started > 0) return 'routed';
    }

    this.backlog.push({
      id: event.id,
      summary: `${event.source}/${event.type}: ${event.title}`,
    });
    await this.drainToSupervisor();
    return 'queued';
  }

  /** Push the current backlog into the supervisor, once, merged. */
  private async drainToSupervisor(): Promise<void> {
    if (this.backlog.size === 0) return;

    const supervisor = await this.ensureSupervisor();
    if (!supervisor) {
      log.warn('[supervisor] no supervisor session available; events stay queued');
      return;
    }
    // Busy supervisor: keep the backlog; it will be drained on its next turn.
    if (supervisor.isProcessing) return;

    const items = this.backlog.drain();
    await this.deps.sendToSession(supervisor.id, formatBacklogNudge(items));
  }

  /**
   * Called when a supervisor turn ends: hand over anything that arrived while it
   * was busy, so a burst costs one extra turn rather than one per event.
   */
  async onSupervisorIdle(supervisorSessionId?: string): Promise<void> {
    /**
     * The turn is over: its deferred side effects happen now, before the state is reset.
     *
     * Any termination path reaches here — complete, interrupted, error — and that is deliberate.
     * A dispatch already told the user 「已派发」; dropping it because the turn was cut short
     * would make that sentence false, and the work would silently never start. Failures are
     * reported instead of swallowed.
     */
    /**
     * The caller knows which supervisor's turn ended; `onDuty` may not be resolved yet (it is
     * set when the first turn acquires a session), and gating the drain on it silently dropped
     * every queued dispatch in that window.
     */
    if (supervisorSessionId) {
      await this.drainActivations(supervisorSessionId)
      this.turnStates.delete(supervisorSessionId)
    } else {
      // No id given: every turn that is open may be over, so finish all of them rather than
      // guessing which supervisor the caller meant.
      for (const id of [...this.turnStates.keys()]) {
        await this.drainActivations(id)
        this.turnStates.delete(id)
      }
    }
    await this.drainToSupervisor();
  }

  private async ensureSupervisor(): Promise<SupervisorSessionInfo | null> {
    if (this.onDuty) {
      const existing = this.deps.getSession(this.onDuty);
      if (existing) return existing;
      this.onDuty = undefined;
    }
    const created = await this.deps.ensureSupervisorSession();
    this.onDuty = created?.id;
    return created;
  }

  private async resolveSessionForAgent(agentId?: string): Promise<string | undefined> {
    if (!agentId) return undefined;
    const supervisor = await this.ensureSupervisor();
    return supervisor && supervisor.agentId === agentId ? supervisor.id : undefined;
  }

  // ------------------------------------------------------------
  // Dispatching
  // ------------------------------------------------------------

  /**
   * Supervisor → work. Applies the fan-out, depth and ping-pong guards, then
   * either continues an existing session or spawns a new one.
   */
  /**
   * Can this task take more work right now?
   *
   * Extracted from the task-target branch because it was *only* there — and the
   * path that actually ran was `target: { kind: 'new' }` with an `attachTaskId`, which
   * never reached it. On a real run the user said 「完成 1.2 后暂停」, the task paused
   * for a decision, and the supervisor still dispatched a fresh session for 1.2 two
   * minutes later. Two rules now, enforced at every door that carries a task id:
   *
   *  - a paused task does not get new work; resuming it is a decision, and the
   *    board already says paused;
   *  - a scope is a boundary: once the scoped work has been delivered under it, what
   *    is left is the user's call, not the supervisor's.
   */
  private assertTaskAcceptsWork(
    task: {
      id: string;
      status?: string;
      spec?: {
        scope?: string;
        plan?: Array<{ id: string; status?: string }>;
        /** The instruction a person's reply was turned into; `at` is what makes it current. */
        directive?: { text: string; at: number };
      };
      handoffs?: Array<{ outcome?: string; at?: number }>;
    },
    params: { userApproved?: boolean; stepId?: string },
  ): void {
    /**
     * The step this dispatch names must still be open.
     *
     * This is the check the plan makes possible: the plan is the record of what is left, so a
     * dispatch that says which step it is for can be answered instead of guessed. Observed live:
     * 「执行步骤 1.2（读回确认）」 was dispatched thirty-four seconds after 1.2 was marked done; the
     * worker re-read the same file, filed a second hand-off, and the person was told 「交接通过」
     * twice for one step.
     */
    /**
     * A finished task takes no more work — not even from a human's 「继续」.
     *
     * Every other door already says this: `startGate` refuses a terminal task, `applyTransition`
     * has no `completed → running`, and `updateTask({status:'running'})` is refused outright. This
     * one did not, so a dispatch into a completed task still sent an instruction: the worker was
     * briefed for work nobody could record, the claim was refused, and the task stayed finished —
     * the board said done while a session did something under its name.
     *
     * Deliberately above the `userApproved` escape: approval widens a boundary, it does not
     * resurrect a task. Starting again is a new task, which is also what the person is told.
     */
    if (task.status && isTerminal(task.status as never)) {
      throw new DispatchRefused(
        `${task.id} 已经${task.status === 'completed' ? '完成' : '取消'}了，不能再派活。` +
          '要继续做就新建一条任务（task_create）；要接着这条做，先把任务重新打开。',
      )
    }

    const planned = task.spec?.plan ?? [];
    if (params.stepId && planned.length) {
      const step = planned.find((candidate) => candidate.id === params.stepId);
      if (!step) {
        throw new DispatchRefused(
          `${task.id} 的计划里没有 ${params.stepId} 这一步。先 task_get 看当前计划，再派真实存在的小节。`,
        );
      }
      if (step.status === 'done') {
        throw new DispatchRefused(
          `${task.id} 的 ${params.stepId} 已经完成了，不要重复派。要收尾就结束任务，要返工就用 task_plan 新开一节。`,
        );
      }
    }
    /**
     * A paused task accepts work when the authorisation exists — not when it is un-paused.
     *
     * The old rule said 「先让用户确认，恢复这个任务再继续」, and 「恢复」 meant
     * `task_update({status:'running'})`, which starts a run immediately. So the supervisor did
     * as instructed: it resumed the task, the worker woke up before any dispatch arrived, and
     * did the next step on its own — then the dispatch it had queued was refused with 「这一步
     * 已经完成了」. Observed live at 11:39:37 (resume) vs 11:40:28 (dispatch refused).
     *
     * `resumeDecisionFor` already answers 「may this task continue, and under what instruction」:
     * a directive newer than the person's reply, or no pending answer at all. That is the gate
     * dispatch should read, so the order becomes the one the design intends — answer, directive,
     * dispatch, work — instead of answer, resume, work, dispatch-refused.
     */
    if (task.status === 'paused' && !params.userApproved) {
      /**
       * Authorisation is a date, not a state.
       *
       * A paused task takes new work when someone wrote down what it may do *after* the slice
       * that stopped it: `directive.at` newer than the last hand-off. That is the same
       * comparison `resumeDecisionFor` makes, read here for the different question 「may I add
       * work」 rather than 「may a run start」.
       *
       * Too loose is worse than too strict: 「paused」 with no new instruction means the person
       * asked for a stop, and a supervisor dispatching into it is doing the thing they stopped.
       */
      const lastHandoffAt = Math.max(0, ...(task.handoffs ?? []).map((h) => h.at ?? 0));
      const directiveAt = task.spec?.directive?.at ?? 0;
      const authorised = directiveAt > lastHandoffAt;
      if (!authorised) {
        throw new DispatchRefused(
          `${task.id} 现在是暂停状态，而且没有覆盖这次继续的授权。` +
            '先让用户确认，再用 task_update 把他的话写成 directive，然后 dispatch —— 不要用改状态的方式启动任务。',
        );
      }
      /**
       * The date is not the whole answer.
       *
       * The supervisor can write a directive itself — the date check above cannot tell a
       * person-backed instruction from a self-authored one. `resumeDecisionFor` can: a question
       * closed without an answer unlocks nothing unless the person spoke after it was asked.
       * Observed live on T-1: the lane wrote its own directive, its scope write closed its own
       * question as obsolete, and the old date-only gate read the whole chain as authorised.
       */
      const verdict = resumeDecisionFor(task as never)
      if (!verdict.allowed) {
        throw new DispatchRefused(
          `${task.id} 现在是暂停状态，而且这次继续没有拿到用户的拍板：${verdict.why}`,
        )
      }
    }
    if (params.userApproved) return;
    const handedOff = (task.handoffs ?? []).some((h) => h.outcome !== 'needs_decision');

    /**
     * Work that the plan already records as done must not be dispatched again.
     *
     * Observed live: the supervisor dispatched 1.2 at 10:50:47 with
     * 「执行步骤 1.2（读回确认）」, thirty-four seconds after the worker had marked 1.2 done
     * at 10:50:13. The task was not `paused` at that instant (the delivery had just been
     * parked as `awaiting_dispatch`), so the pause gate above let it through, a worker
     * re-read the same file, filed a second hand-off, and the supervisor reported
     * 「交接通过」 twice — for one step.
     *
     * The plan is the record of what is left. If nothing in it is open, there is nothing
     * to dispatch, whatever the instruction says.
     */
    const openSteps = (task.spec?.plan ?? []).filter((step) => step.status !== 'done');
    if (task.spec?.plan?.length && openSteps.length === 0) {
      throw new DispatchRefused(
        `${task.id} 的计划已经全部完成，没有可派的步骤。不要重复派已经做完的活：` +
          '要收尾就直接把任务结束，要返工就先用 task_plan 新开一节。',
      );
    }
    if (!handedOff || openSteps.length > 0) return;
    /**
     * There used to be a boundary check here, and removing it is the point.
     *
     * It fired when `spec.scope` was set and any step was still open, comparing each open step
     * id against `authorizedUpTo` / `authorizedSteps`. That made this the third implementation of
     * "is this authorised?" — alongside the plan writer and the resume path — and the three
     * disagreed: the user answered 「完成1.2后暂停」, the supervisor recorded it correctly, and
     * the dispatch of 1.2 was refused anyway because the prose still said 「步骤 1.2」.
     *
     * The ids are gone because a boundary written in ids the worker invents cannot hold: the
     * worker can satisfy it by renaming, and it cannot express what people actually say. What
     * remains here is only what is checkable — the task is paused or it is not, and continuing a
     * paused task needs the person's agreement. Whether the *work* is still authorised is read
     * from `spec.directive` by whoever decides, not asserted by this method.
     */
  }

  async dispatch(params: {
    fromSessionId: string;
    target:
      | { kind: 'session'; sessionId: string }
      | { kind: 'task'; taskId: string }
      | { kind: 'new'; agentId?: string };
    name?: string;
    scope: string;
    instruction: string;
    attachTaskId?: string;
    /** Which plan step this work is for; checked against the plan before anything spawns. */
    stepId?: string;
    parallel: boolean;
    /**
     * The user explicitly authorised work beyond the task's recorded scope.
     *
     * Only a human can widen a boundary, so this is not the supervisor's call to
     * make on its own — it is set when the user answered 「继续，把剩下的也做完」.
     */
    userApproved?: boolean;
  }): Promise<{ sessionId: string; queued?: boolean; position?: number }> {
    const supervisor = this.deps.getSession(params.fromSessionId);
    if (!supervisor || supervisor.role !== 'supervisor') {
      throw new Error('dispatch is only available to a supervisor session.');
    }

    // Resolve the destination first: the guard needs a stable key for the
    // ping-pong check, and a task target resolves to its current session.
    let targetKey = '';
    let existingSessionId: string | undefined;
    // Who should run this, when nobody is running it yet. A task names its own
    // executor (`assigneeAgentId`); a bare "new session" target can name one too.
    // Both funnel into the same `spawnWorker` call below, because `dispatch` and
    // the cron/event runner (spawnTaskRun) must pick the same agent for the same
    // task — they previously did not: this path dropped the assignment, so a task
    // dispatched by the supervisor ran as the workspace default while the same
    // task fired by a trigger ran as its assignee.
    let workerAgentId: string | undefined;
    if (params.target.kind === 'session') {
      targetKey = params.target.sessionId;
      existingSessionId = params.target.sessionId;
    } else if (params.target.kind === 'task') {
      const task = this.deps.getTask?.(params.target.taskId);
      if (!task) throw new Error(`Task not found: ${params.target.taskId}`);
      targetKey = `task:${task.id}`;
      this.assertTaskAcceptsWork(task, params);
      // A task with a live session is already dispatched. Spawning a second
      // worker for it produced two sessions doing the same work, both writing
      // the same task's journal, and a board that could not say who owned it.
      // The instruction is a follow-up to recorded work, so it goes to that
      // session; only an absent or dead session means "start a new run".
      const live = task.currentSessionId ? this.deps.getSession(task.currentSessionId) : null;
      existingSessionId = live ? task.currentSessionId : undefined;
      if (task.currentSessionId && !live) {
        this.deps.logDispatch?.(`${task.id}: previous session ${task.currentSessionId} is gone; starting a new run`);
      }
      workerAgentId = task.assigneeAgentId;
    } else {
      targetKey = `new:${params.target.agentId ?? 'default'}:${params.scope}`;
      workerAgentId = params.target.agentId;
      // Every dispatched unit of work must be a task.
      //
      // The prompt asks for this, but prompting is exactly what the DeepSeek
      // ablation found unreliable: with a neutral prompt the model delegated 0
      // times out of 5, and even when told to delegate it still did the small jobs
      // itself. So the rule is enforced here, at the one door every dispatch goes
      // through, rather than hoped for.
      //
      // A throwaway session is not merely untidy: no acceptance, no board entry, no
      // restart recovery, and it disappears once done — the work becomes
      // unanswerable afterwards.
      if (!params.attachTaskId) {
        throw new DispatchRefused(
          '新会话必须挂到一条任务上（attachTaskId）。先 task_create，再 dispatch：没有任务的活做完也没人知道它发生过。',
        );
      }
      // The path that bypassed everything.
      //
      // A real run paused T-1 to wait for a decision, and two minutes later this
      // branch spawned a brand-new session for step 1.2 — the scope check lived in the
      // `task` branch, which this is not. Every dispatch that names a task now passes
      // the same gate, including the ones that create a session.
      const attached = this.deps.getTask?.(params.attachTaskId);
      if (attached) this.assertTaskAcceptsWork(attached, params);
    }

    assertDispatchAllowed({
      state: this.turnStateFor(params.fromSessionId),
      guard: this.guardStateFor(params.fromSessionId),
      spawnDepth: supervisor.spawnDepth ?? 0,
      targetKey,
      instruction: params.instruction,
      parallel: params.parallel,
    });

    if (existingSessionId) {
      // Same rule for an existing session: the work must belong to a task. Either
      // this dispatch says which one, or the session is already working on one —
      // in which case the instruction is a follow-up to recorded work, which is
      // exactly what should be allowed.
      const targetSession = this.deps.getSession(existingSessionId);
      const hasRecord = Boolean(params.attachTaskId || targetSession?.taskId);
      if (!hasRecord) {
        throw new DispatchRefused(
          `会话 ${existingSessionId} 没有挂任务，不能直接给它派活。先 task_create 建一条任务，再 dispatch 到该任务。`,
        );
      }
      // The hand-off travels with the work. Everything recorded about the last
      // round — what was found, what must happen next, which files exist — belongs
      // in the message that asks someone to continue it, not only in the task
      // file. Same rule for a new worker (its brief carries it) and for a session
      // that is already running (this does).
      const taskId = params.attachTaskId ?? targetSession?.taskId;
      // Same gate for a follow-up into a live session: the task it belongs to must
      // still accept work. Without this, 「目标会话」 was a way around both rules.
      const attached = taskId ? this.deps.getTask?.(taskId) : undefined;
      if (attached) this.assertTaskAcceptsWork(attached, params);
      const handoff = taskId ? this.deps.handoffContext?.(taskId) : undefined;
      const message = handoff ? `${handoff}\n\n## 这一轮要做的事\n${params.instruction}` : params.instruction;
      /**
       * Queued, not started.
       *
       * Everything above is a fact about the record and belongs in this turn's answer. The call
       * below is the side effect — it wakes another agent — and it must not land in the middle of
       * this turn's reasoning. Observed live: the supervisor dispatched 1.2, the worker finished it
       * before the turn ended, the supervisor reported 「已完成 1.2 并暂停」 from a state it had
       * already changed, and the queued hand-off then made it report the same thing again.
       */
      return {
        sessionId: existingSessionId,
        queued: true,
        position: this.enqueueActivation(params.fromSessionId, {
          kind: 'send',
          sessionId: existingSessionId,
          message,
          /**
           * The run is claimed when this is actually sent, and only for a task that exists.
           *
           * Without it the task's status stayed whatever it was while the work happened — the
           * record and the session disagreeing at exactly the moment a person looks at the board.
           */
          ...(taskId ? { taskId } : {}),
        }),
      }
    }

    const position = this.enqueueActivation(params.fromSessionId, {
      kind: 'spawn',
      name: params.name,
      agentId: workerAgentId,
      scope: params.scope,
      instruction: params.instruction,
      taskId: params.attachTaskId ?? (params.target.kind === 'task' ? params.target.taskId : undefined),
      spawnDepth: (supervisor.spawnDepth ?? 0) + 1,
    })
    return { sessionId: '', queued: true, position }
  }

  /** Queue an activation for the end of this turn; returns its 1-based position. */
  private enqueueActivation(supervisorSessionId: string, action: QueuedActivation): number {
    const state = this.turnStateFor(supervisorSessionId)
    state.queuedActivations.push(action)
    const position = state.queuedActivations.length
    /**
     * Written when it is only a promise, not when it happens.
     *
     * This queue lives in memory, so a crash between 「已排队」 and the turn ending would drop it
     * with nothing left behind. The log is the only place that can still answer 「它到底派过没有」
     * afterwards, which is the question a person asks when work never starts.
     */
    this.deps.logDispatch?.(
      `${supervisorSessionId} queued #${position}: ${describeActivation(action)}`,
    )
    return position
  }

  private turnStateFor(sessionId: string): SupervisorTurnState {
    let state = this.turnStates.get(sessionId)
    if (!state) {
      state = newTurnState()
      this.turnStates.set(sessionId, state)
    }
    return state
  }

  private guardStateFor(sessionId: string): SupervisorGuardState {
    let state = this.guardStates.get(sessionId)
    if (!state) {
      state = newGuardState()
      this.guardStates.set(sessionId, state)
    }
    return state
  }

  /**
   * Run what this turn deferred, in the order it was asked for.
   *
   * A failure cannot reach the tool call that queued it — the turn is over — so it goes where a
   * person can act on it: the log, and a notice to the supervisor naming what failed. Silence
   * would be worse than the extra turn, because the supervisor has already told the user
   * 「已派发」 and that sentence would quietly become false.
   */
  private async drainActivations(supervisorSessionId: string): Promise<void> {
    const queued = this.turnStateFor(supervisorSessionId).queuedActivations.splice(0)
    for (const action of queued) {
      try {
        this.deps.logDispatch?.(
          `${supervisorSessionId} starting queued: ${describeActivation(action)}`,
        )
        if (action.kind === 'send') {
          /**
           * Claim first, then send — the same order the spawn path uses.
           *
           * Claiming after the send would leave the original hole open on a send that throws:
           * the worker would still be told to work, and the task would still say `paused`.
           */
          if (action.taskId) this.deps.claimRun?.(action.taskId, action.sessionId)
          await this.deps.sendToSession(action.sessionId, action.message)
        } else {
          await this.deps.spawnWorker({
            name: action.name,
            agentId: action.agentId,
            scope: action.scope,
            instruction: action.instruction,
            taskId: action.taskId,
            spawnDepth: action.spawnDepth,
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('[supervisor] queued dispatch failed', { error: message })
        try {
          await this.deps.sendToSession(
            supervisorSessionId,
            `上一轮排队的派发执行失败：${message}
这一轮里「已派发」的说法因此没有发生，请重新安排或告知用户。`,
          )
        } catch {
          // Unreachable supervisor: the log has it, and nothing else can be done here.
        }
      }
    }
  }

  // ------------------------------------------------------------
  // Handoffs
  // ------------------------------------------------------------

  /**
   * A worker finished. The supervisor decides what the user sees; the worker
   * never speaks to the user directly.
   */
  async onHandoff(params: {
    supervisorSessionId: string;
    taskId?: string;
    text: string;
  }): Promise<void> {
    const supervisor = this.deps.getSession(params.supervisorSessionId);
    if (!supervisor) return;
    await this.deps.sendToSession(supervisor.id, params.text);
  }

  /** Supervisor → user: single channel, short by contract. */
  async reportToUser(params: { supervisorSessionId: string; text: string }): Promise<void> {
    await this.deps.writeToSupervisor(params.supervisorSessionId, params.text);
  }

  async askUser(params: {
    supervisorSessionId: string;
    questions: { question: string; options?: string[] }[];
  }): Promise<void> {
    await this.deps.askUser(params.supervisorSessionId, params.questions.slice(0, 2));
  }

  /** Exposed for tests and for the turn-timeout guard. */
  get pendingEvents(): number {
    return this.backlog.size;
  }

  /** Release the slot a finished worker held, draining any queued sibling. */
  releaseDispatch(sessionId: string): void {
    this.dispatchQueue.release(sessionId);
  }

  /** Release slots for workers whose session disappeared. */
  sweepDispatches(): void {
    this.dispatchQueue.sweep((sessionId) => {
      const session = this.deps.getSession(sessionId);
      return Boolean(session && session.isProcessing);
    });
  }

  /** Per-rule active/queued counts, for diagnostics. */
  dispatchSnapshot(): Record<string, { active: number; waiting: number; cap: number }> {
    return this.dispatchQueue.snapshot();
  }

  /** Dispatches this supervisor has made in its current turn. */
  dispatchesThisTurn(supervisorSessionId: string): number {
    return this.turnStateFor(supervisorSessionId).dispatchesThisTurn;
  }

  /**
   * A supervisor turn is starting: its per-turn counters go back to zero.
   *
   * Called by the session layer on the idle → processing edge. Guard state is deliberately left
   * alone — see `guardStates`.
   */
  beginTurn(supervisorSessionId: string): void {
    this.turnStates.set(supervisorSessionId, newTurnState());
  }
}

/** One line about a queued action, for the log. */
function describeActivation(action: QueuedActivation): string {
  return action.kind === 'send'
    ? `send to ${action.sessionId}${action.taskId ? ` for ${action.taskId}` : ''}`
    : `spawn ${action.name ?? 'worker'}${action.taskId ? ` for ${action.taskId}` : ''} (depth ${action.spawnDepth})`;
}

export { DispatchRefused, MAX_DISPATCHES_PER_TURN };
