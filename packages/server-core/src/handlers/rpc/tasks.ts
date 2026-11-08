/**
 * Task RPC surface.
 *
 * The renderer never touches the task files: it lists, reads and advances them
 * through these channels. Every mutation goes through `TaskService` so the
 * state machine and the budget guard apply no matter who asked.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import type { TaskService } from '../../tasks/task-service';
import { readJournal } from '@craft-agent/shared/tasks';
import { normalizeSpec, normalizeTrigger } from '@craft-agent/shared/tasks';
import type { TaskStatus } from '@craft-agent/shared/tasks';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.taskboard.LIST,
  RPC_CHANNELS.taskboard.GET,
  RPC_CHANNELS.taskboard.UPDATE,
  RPC_CHANNELS.taskboard.HANDOFF,
  RPC_CHANNELS.taskboard.RUN,
  RPC_CHANNELS.taskboard.ANSWER,
  RPC_CHANNELS.taskboard.DELETE,
  RPC_CHANNELS.taskboard.UPDATE_TRIGGER,
  RPC_CHANNELS.taskboard.CHANGED,
] as const;

type ManagerWithTasks = { getTasks?: (workspaceId: string) => TaskService };

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
  return workspace;
}

function tasksFor(deps: HandlerDeps, workspaceId: string): TaskService {
  const manager = deps.sessionManager as unknown as ManagerWithTasks | undefined;
  if (!manager?.getTasks) throw new Error('Task service is not available in this build.');
  requireWorkspace(workspaceId);
  return manager.getTasks(workspaceId);
}

export function registerTasksHandlers(server: RpcServer, deps: HandlerDeps): void {
  const broadcast = (workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace) return;
    pushTyped(
      server,
      RPC_CHANNELS.taskboard.CHANGED,
      { to: 'workspace', workspaceId },
      { workspaceId },
    );
  };

  // Same contract note as the agents handlers: the transport spreads the RPC
  // args positionally (`handler(ctx, ...args)`), so an object payload never
  // matched and every task-board call saw `undefined`.
  server.handle(RPC_CHANNELS.taskboard.LIST, async (_ctx, workspaceId: string, status?: TaskStatus) => {
    const service = tasksFor(deps, workspaceId);
    return service.list(status).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      priority: task.priority,
      updatedAt: task.updatedAt,
      currentSessionId: task.currentSessionId,
      sessionCount: task.sessionIds.length,
      lastHandoff: task.handoffs.at(-1)?.summary,
      pauseReason: task.pauseReason ?? null,
      // A paused task that says 「等待你决定」 must also say what about, or the user has
      // to open it to find out there is nothing there — the decision lives on the task.
      ...(task.decision && !task.decision.resolvedAt
        ? { decisionLabel: task.decision.label }
        : {}),
    }));
  });

  server.handle(
    RPC_CHANNELS.taskboard.GET,
    async (_ctx, workspaceId: string, id: string, includeJournal?: boolean) => {
      const service = tasksFor(deps, workspaceId);
      const task = service.get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      const journal = includeJournal
        ? readJournal(requireWorkspace(workspaceId).rootPath, id)
        : undefined;
      return { task, journal };
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.UPDATE,
    async (
      _ctx,
      workspaceId: string,
      id: string,
      status?: TaskStatus,
      options?: { pauseReason?: string; error?: string },
    ) => {
      const service = tasksFor(deps, workspaceId);
      const before = service.get(id);
      const task = service.setStatus(id, status ?? 'running', {
        pauseReason: options?.pauseReason as never,
        error: options?.error,
      });
      // Stopping a task has to stop the work. Writing `paused` and leaving the
      // session running is the same lie as a board that says 待开始 while a
      // worker is editing files: the label and the machine disagree, and the
      // worker keeps writing into a task nobody thinks is live.
      const stopped = task.status === 'paused' || task.status === 'canceled';
      const wasRunning = before?.status === 'running';
      if (stopped && wasRunning && before?.currentSessionId) {
        const manager = deps.sessionManager as unknown as {
          cancelProcessing?: (sessionId: string, silent?: boolean) => Promise<void>
        };
        try {
          await manager.cancelProcessing?.(before.currentSessionId, true);
        } catch {
          // A session that never started cannot be stopped; the status change
          // still stands.
        }
      }
      // Give the lock back as well: `isRunLocked` keeps it while the session is
      // alive, so a paused task would refuse to resume until that session died.
      const after = stopped && wasRunning ? service.suspendRun(id) : task;
      broadcast(workspaceId);
      return after;
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.UPDATE_TRIGGER,
    async (_ctx, workspaceId: string, id: string, trigger: unknown) => {
      const service = tasksFor(deps, workspaceId)
      const task = service.updateTrigger(id, normalizeTrigger(trigger))
      broadcast(workspaceId)
      return { id: task.id, trigger: task.trigger }
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.RUN,
    async (_ctx, workspaceId: string, id: string) => {
      const manager = deps.sessionManager as unknown as {
        runTask?: (workspaceId: string, taskId: string, reason: string) => Promise<boolean>
      }
      if (!manager.runTask) throw new Error('Task runner is not available in this build.')
      const started = await manager.runTask(workspaceId, id, 'manual')
      broadcast(workspaceId)
      return { started, ...(started ? {} : { reason: 'task is already running, blocked, or out of budget' }) }
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.ANSWER,
    async (
      _ctx: unknown,
      workspaceId: string,
      id: string,
      text: string,
      /**
       * The session the card was shown in, used only when the card carried no task id.
       *
       * Cards delivered before the asker named a task have no id, and the renderer could
       * then only send bare words — observed: 「完成1.2后暂停」 reached the task supervisor
       * with nothing identifying which task it answered.
       */
      askedBySessionId?: string,
    ) => {
      const service = tasksFor(deps, workspaceId)
      const resolvedId =
        id ||
        (askedBySessionId
          ? (deps.sessionManager as unknown as { openTaskFor?: (s: string) => string | undefined }).openTaskFor?.(
              askedBySessionId,
            )
          : undefined)
      if (!resolvedId) {
        return { accepted: false, reason: 'no task to answer — the card did not say which one' }
      }
      const task = service.recordDecisionAnswer(resolvedId, text)
      if (!task) {
        // No open question: say so instead of accepting words nobody will read.
        return { accepted: false, reason: 'no pending decision on this task' }
      }

      /**
       * Deliver to the session that asked, and say which task the words belong to.
       *
       * `sendMessage` alone was the whole answer path, and it cannot identify the task:
       * two tasks waiting at once produce two cards, and their answers are both plain
       * prose in the same inbox. The supervisor then has to guess which decision the
       * words close — the exact ambiguity that made 「放行」 mean nothing when two
       * questions were open. Composing the line here, from the task record, is what
       * removes the guess.
       */
      const manager = deps.sessionManager as unknown as {
        sendMessage?: (sessionId: string, text: string) => Promise<unknown>
        /** Which supervisor asked the question the person is answering. */
        decisionAskerFor?: (taskId: string) => string | undefined
      }
      /**
       * The card can live on a different supervisor lane than the task.
       *
       * 督导·任务 owns the task; 督导·用户 is where the question was actually shown, because
       * `resolveReaderLane` forwards reader-facing rows there. The answer went only to the
       * owner, so the lane holding the card never learned the question was closed — it kept
       * offering (or hiding) a card for a decision that had already been answered.
       */
      const askedBy = manager.decisionAskerFor?.(resolvedId)
      const supervisor = task.supervisorSessionId
      if (supervisor && manager.sendMessage) {
        const remaining = (task.spec?.plan ?? []).filter((step) => step.status !== 'done')
        /**
         * Fire and forget. `sendMessage` resolves when the whole turn has finished
         * streaming, so awaiting it kept this RPC open for the length of a model turn —
         * the answer had already been persisted and was already visible in the
         * supervisor's transcript, while the card still showed its buttons and the
         * person clicked again. The reply is delivered either way; the card must not
         * wait for the work it triggered.
         */
        const line =
          `〔任务 ${task.id} 拍板答复〕${text.trim()}` +
          (remaining.length ? `
（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）` : '')
        void manager.sendMessage(supervisor, line).catch(() => undefined)
        // And the lane the card was shown in, so its copy of the question closes too.
        if (askedBy && askedBy !== supervisor) {
          void manager.sendMessage(askedBy, line).catch(() => undefined)
        }
      }
      broadcast(workspaceId)
      return { accepted: true }
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.DELETE,
    async (_ctx: unknown, workspaceId: string, id: string) => {
      const service = tasksFor(deps, workspaceId);
      const task = service.get(id);
      const sessionIds = task?.sessionIds ?? [];
      const result = service.remove(id);
      if (!result.ok) return result;

      // The sessions stay. A task is a board entry; a session is the conversation
      // that explains it — the tool calls, the files read, the errors. Deleting the
      // entry must not delete the history, and the same session can be referenced by
      // more than one task, so removing one task may not take it down anyway.
      //
      // What must go is the dangling reference: an orphan that still says "I belong
      // to T-3" shows a task chip that leads nowhere and keeps asking the task
      // service about a record that no longer exists.
      const manager = deps.sessionManager as unknown as {
        detachTask?: (sessionId: string, taskId: string) => void;
      };
      for (const sessionId of sessionIds) manager.detachTask?.(sessionId, id);

      broadcast(workspaceId);
      return { ...result, sessionsKept: sessionIds.length };
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.HANDOFF,
    async (_ctx, workspaceId: string, id: string, fromSessionId: string, handoff: unknown) => {
      const service = tasksFor(deps, workspaceId);
      const result = await service.reportHandoff(id, handoff, fromSessionId);
      broadcast(workspaceId);
      return {
        passed: result.passed,
        reasons: result.reasons,
        status: result.task.status,
      };
    },
  );
}
