/**
 * SessionManager-side implementation of the multi-agent tool callbacks.
 *
 * Kept out of `SessionManager.ts` (already very large) but still a method
 * factory rather than a free function, so it can use the manager's private
 * helpers without re-implementing session creation.
 */

import type { TaskService } from '../tasks/task-service.ts';

export interface AgentToolBindingsDeps {
  sessionId: string;
  role: 'supervisor' | 'worker';
  taskId?: string;
  sessionName?: string;
  tasks: TaskService;
  /** Create a worker session and send it the first instruction. */
  spawnWorkerSession: (params: {
    name?: string;
    agentId?: string;
    scope: string;
    instruction: string;
    taskId?: string;
    spawnDepth: number;
  }) => Promise<{ sessionId: string; queued?: boolean; position?: number }>;
  /** Send into an existing session (wakes it when idle). */
  sendToSession: (sessionId: string, text: string) => Promise<void>;
  /**
   * Everything this turn has to say to the person, in order, delivered when the turn ends.
   *
   * Two methods used to sit here — `writeUserVisible` (one statement, delivered immediately) and
   * `askUser` (questions, delivered at turn end) — and both drew the same kind of row. Two doors to
   * one room is how one turn produced two cards for one question.
   */
  askUser: (payload: {
    entries: Array<{ kind: 'completed' | 'decision' | 'blocked'; text: string; options?: string[] }>;
    taskId?: string;
  }) => Promise<void>;
  /** The questions still waiting for an answer, for the asker to read back. */
  listQuestions?: (params: { taskId?: string }) => Promise<
    Array<{
      taskId: string;
      id: string;
      question: string;
      options?: string[];
      label?: string;
      askedAt: number;
    }>
  >;
  /**
   * The user lane's one door into the system: the person's words, verbatim.
   *
   * With no `taskId` the implementation creates the task skeleton and wakes the working lane to
   * analyse the words; with one it hands them over as a follow-up. See the implementation in
   * SessionManager for why this replaced `send_agent_message`.
   */
  createTaskFromUser?: (payload: { request: string; taskId?: string }) => Promise<{
    taskId?: string;
    message: string;
  }>;
  /** Supervisor runtime, for dispatch guards. */
  dispatchViaSupervisor?: (params: {
    target:
      | { kind: 'session'; sessionId: string }
      | { kind: 'task'; taskId: string }
      | { kind: 'new'; agentId?: string };
    name?: string;
    scope: string;
    instruction: string;
    attachTaskId?: string;
    parallel: boolean;
  }) => Promise<{ sessionId: string; queued?: boolean; position?: number }>;
  /** Start the next run in a fresh session (context rotation). */
  continueTask?: (taskId: string) => void;
  /** Depth of the calling session, for the delegation cap. */
  spawnDepth?: number;
}

export function buildAgentToolBindings(deps: AgentToolBindingsDeps) {
  return {
    async reportResult(payload: {
      outcome: 'delivered' | 'handoff' | 'needs_decision';
      summary: string;
      keyFindings?: string[];
      nextAction?: string;
      artifacts?: { path: string; note?: string }[];
      verify?: { ran: string[]; passed: boolean; note?: string };
    }): Promise<{ message: string }> {
      if (!deps.taskId) {
        // A worker outside a task still reports; the supervisor gets the text,
        // there is simply no task journal to write it into.
        return {
          message:
            'Handoff recorded. There is no task attached to this session, so the supervisor was notified without a task journal entry.',
        };
      }
      const result = await deps.tasks.reportHandoff(deps.taskId, payload, deps.sessionId);
      // A long task must not keep growing one session: when the service says the
      // context is nearly full, compact in place (same thread, same window
      // budget) instead of restarting cold.
      if (result.compactionPending) deps.continueTask?.(deps.taskId);
      return {
        message: result.passed
          ? `Handoff accepted${result.task.status === 'completed' ? '; task completed' : result.compactionPending ? '; context compacted for the next round' : ''}.`
          : `Handoff rejected: ${result.reasons.join('; ')}`,
      };
    },

    async dispatch(payload: {
      target:
        | { kind: 'session'; sessionId: string }
        | { kind: 'task'; taskId: string }
        | { kind: 'new'; agentId?: string };
      name?: string;
      scope: string;
      instruction: string;
      attachTaskId?: string;
      parallel: boolean;
    }): Promise<{ message: string }> {
      if (deps.role !== 'supervisor') {
        throw new Error('dispatch is only available to a supervisor session.');
      }
      const created = deps.dispatchViaSupervisor
        ? await deps.dispatchViaSupervisor(payload)
        : await deps.spawnWorkerSession({
            name: payload.name,
            agentId: payload.target.kind === 'new' ? payload.target.agentId : undefined,
            scope: payload.scope,
            instruction: payload.instruction,
            taskId: payload.attachTaskId,
            spawnDepth: (deps.spawnDepth ?? 0) + 1,
          });

      if (payload.attachTaskId) {
        /**
         * Only when there is a session to record yet.
         *
         * The dispatch is queued now, so a new worker has no id at this point — attaching
         * `''` would put an empty session into the task's `sessionIds`. The scope is a fact
         * about the record and is written here; the session is attached when the run starts.
         */
        if (created.sessionId) deps.tasks.attachSession(payload.attachTaskId, created.sessionId);
        // `scope` used to reach this point and stop: it fed the dedupe key and the
        // default session name, then was dropped. Persisting it makes the
        // responsibility readable later, which is what "which session is right for
        // this" needs in order to be answerable from data instead of titles.
        deps.tasks.setScope(payload.attachTaskId, payload.scope);
      }
      /**
       * Queued, and it says so.
       *
       * The work starts when this turn ends — not now — so a receipt that named a session
       * would be describing something that does not exist yet, and 「you will be woken when it
       * reports」 would arrive into a turn that may also be reporting the same step.
       */
      if (created.queued) {
        return {
          message:
            `已排队（第 ${created.position ?? 1} 位），本轮结束时派发。` +
            '现在就把这一轮的结论告诉用户，不要在这里等它开工——它开工后会向你回报。',
        };
      }
      return { message: `Dispatched to ${created.sessionId}. End your turn; you will be woken when it reports.` };
    },

    async listQuestions(payload: { taskId?: string }) {
      if (!deps.listQuestions) return [];
      return deps.listQuestions(payload);
    },

    async askUser(payload: {
      entries: Array<{ kind: 'completed' | 'decision' | 'blocked'; text: string; options?: string[] }>;
      taskId?: string;
    }): Promise<void> {
      await deps.askUser(payload);
    },

    /** Absent in lanes that should not have the door; the tool refuses itself then. */
    ...(deps.createTaskFromUser ? { createTaskFromUser: deps.createTaskFromUser } : {}),
  };
}
