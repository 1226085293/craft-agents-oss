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
  /** Record a user-visible message on the supervisor's transcript. */
  writeToSupervisor: (sessionId: string, text: string) => Promise<void>;
  /** Ask the user (surfaced as a question card / message). */
  askUser: (supervisorSessionId: string, questions: { question: string; options?: string[] }[]) => Promise<void>;
  /** Resolve a task by id (for task targets). */
  getTask?: (taskId: string) => { id: string; currentSessionId?: string } | null;
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

  /**
   * Consecutive supervisor turns that died at the per-turn cap.
   *
   * The cap used to close the turn and immediately re-drain, so work that needed
   * longer than the cap produced start → kill → re-queue → start again, throwing
   * the reasoning away every round. The counter is what turns that into a bounded
   * wait.
   */
  private capHits = 0;
  /** No supervisor turn may start before this timestamp. 0 = no wait. */
  private capBackoffUntil = 0;
  /** Armed by `noteCapHit` so the backlog is not stranded when the window ends. */
  private capBackoffTimer?: ReturnType<typeof setTimeout>;

  /**
   * One hit is bad luck with a slow channel; a streak is work that does not
   * belong in a router. So the first hit still drains immediately and the delay
   * only starts from the second.
   */
  private static backoffFor(hits: number): number {
    return hits >= 2 ? Math.min(5 * 60_000, 15_000 * (hits - 1)) : 0;
  }

  /**
   * Record that a supervisor turn exceeded the cap.
   *
   * Called by whoever closed the turn, because only that side knows the turn was
   * killed by the cap rather than finishing on its own — the two arrive through
   * the same "turn ended" path.
   */
  noteCapHit(): void {
    this.capHits += 1;
    const delay = SupervisorRuntime.backoffFor(this.capHits);
    if (delay <= 0) return;
    this.capBackoffUntil = Date.now() + delay;
    log.warn(`[supervisor] ${this.capHits} consecutive cap hits; holding the backlog for ${delay}ms`);
  }

  /** A turn finished without hitting the cap, so the streak is over. */
  noteTurnCompleted(): void {
    this.capHits = 0;
    this.capBackoffUntil = 0;
    if (this.capBackoffTimer) {
      clearTimeout(this.capBackoffTimer);
      this.capBackoffTimer = undefined;
    }
  }

  /** Stop the timer when the workspace is released. */
  dispose(): void {
    if (this.capBackoffTimer) {
      clearTimeout(this.capBackoffTimer);
      this.capBackoffTimer = undefined;
    }
  }

  constructor(private readonly deps: SupervisorRuntimeDeps) {}

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

    // The wait lives here, not at the call sites, because there are two ways in:
    // a turn ending (`onSupervisorIdle`) and a fresh event arriving
    // (`routeUnclaimed`). Gating only the first left the second able to start the
    // very turn the backoff was meant to prevent — a busy channel would have
    // re-woken the supervisor immediately after each cap kill.
    const waitMs = this.capBackoffUntil - Date.now();
    if (waitMs > 0) {
      // Arm a timer, not just a return: nothing else would come back for these
      // events, and a stranded backlog is the older bug this whole path exists to
      // avoid. One timer is enough — a second event during the window joins it.
      if (!this.capBackoffTimer) {
        this.capBackoffTimer = setTimeout(() => {
          this.capBackoffTimer = undefined;
          void this.drainToSupervisor();
        }, waitMs);
        this.capBackoffTimer.unref?.();
      }
      log.info(`[supervisor] holding ${this.backlog.size} event(s) for ${waitMs}ms`);
      return;
    }

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
    if (params.target.kind === 'session') {
      targetKey = params.target.sessionId;
      existingSessionId = params.target.sessionId;
    } else if (params.target.kind === 'task') {
      const task = this.deps.getTask?.(params.target.taskId);
      if (!task) throw new Error(`Task not found: ${params.target.taskId}`);
      targetKey = `task:${task.id}`;
      existingSessionId = task.currentSessionId;
    } else {
      targetKey = `new:${params.target.agentId ?? 'default'}:${params.scope}`;
    }

    assertDispatchAllowed({
      state: this.turnState,
      spawnDepth: supervisor.spawnDepth ?? 0,
      targetKey,
      instruction: params.instruction,
      parallel: params.parallel,
    });

    if (existingSessionId) {
      await this.deps.sendToSession(existingSessionId, params.instruction);
      return { sessionId: existingSessionId };
    }

    const created = await this.deps.spawnWorker({
      name: params.name,
      agentId: params.target.kind === 'new' ? params.target.agentId : undefined,
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
