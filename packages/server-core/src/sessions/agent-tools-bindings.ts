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
  }) => Promise<{ sessionId: string }>;
  /** Send into an existing session (wakes it when idle). */
  sendToSession: (sessionId: string, text: string) => Promise<void>;
  /** Append a user-visible assistant message to the caller's own transcript. */
  writeUserVisible: (
    text: string,
    kind: 'completed' | 'decision' | 'blocked',
    options?: string[],
  ) => Promise<void>;
  /** Surface a question to the user (rendered as an ask card / message). */
  askUser: (questions: { question: string; options?: string[] }[]) => Promise<void>;
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
  }) => Promise<{ sessionId: string }>;
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
        deps.tasks.attachSession(payload.attachTaskId, created.sessionId);
        // `scope` used to reach this point and stop: it fed the dedupe key and the
        // default session name, then was dropped. Persisting it makes the
        // responsibility readable later, which is what "which session is right for
        // this" needs in order to be answerable from data instead of titles.
        deps.tasks.setScope(payload.attachTaskId, payload.scope);
      }
      return { message: `Dispatched to ${created.sessionId}. End your turn; you will be woken when it reports.` };
    },

    async reportToUser(payload: {
      text: string;
      kind: 'completed' | 'decision' | 'blocked';
      sessionId?: string;
      options?: string[];
    }): Promise<void> {
      await deps.writeUserVisible(payload.text, payload.kind, payload.options);
    },

    async askUser(payload: { questions: { question: string; options?: string[] }[] }): Promise<void> {
      await deps.askUser(payload.questions);
    },
  };
}
