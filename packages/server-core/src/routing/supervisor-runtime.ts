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
  newTurnState,
  type SupervisorTurnState,
} from '@craft-agent/shared/agents/supervisor';
import { loadRoutes, matchRoute, formatRouteInstruction, ruleParallelism } from '@craft-agent/shared/routing';
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
  /** Diagnostics for routing decisions that change who runs the work. */
  logDispatch?: (message: string) => void;
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
  private turnState: SupervisorTurnState = newTurnState();
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
  dispose(): void {}

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
  async onSupervisorIdle(): Promise<void> {
    this.turnState = newTurnState();
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
    parallel: boolean;
  }): Promise<{ sessionId: string }> {
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
    }

    assertDispatchAllowed({
      state: this.turnState,
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
      await this.deps.sendToSession(existingSessionId, params.instruction);
      return { sessionId: existingSessionId };
    }

    const created = await this.deps.spawnWorker({
      name: params.name,
      agentId: workerAgentId,
      scope: params.scope,
      instruction: params.instruction,
      taskId: params.attachTaskId ?? (params.target.kind === 'task' ? params.target.taskId : undefined),
      spawnDepth: (supervisor.spawnDepth ?? 0) + 1,
    });
    return { sessionId: created.sessionId };
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

  get dispatchesThisTurn(): number {
    return this.turnState.dispatchesThisTurn;
  }

  /** Reset the per-turn counters (called when a supervisor turn starts). */
  beginTurn(): void {
    this.turnState = newTurnState();
  }
}

export { DispatchRefused, MAX_DISPATCHES_PER_TURN };
