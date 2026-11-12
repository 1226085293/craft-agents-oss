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
import {
  normalizeSpec,
  normalizeTrigger,
  processLostRetryDue,
  formatDecisionAnswerLine,
  formatDecisionAnswersLine,
  openDecisions,
  undeliveredAnswers,
} from '@craft-agent/shared/tasks';
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
      /**
       * Whether the watchdog is going to retry this on its own.
       *
       * The card offered 「继续」 on a task the loop was about to pick up anyway, and the person
       * clicked it into a gate that refused because a run already owned the task. Same function as
       * the loop's, so the card cannot promise something the loop is not about to do.
       */
      willRetry: processLostRetryDue(task, Date.now(), 0),
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
      return {
        task: { ...task, willRetry: processLostRetryDue(task, Date.now(), 0) },
        journal,
      };
    },
  );

  /**
   * The task board's update goes through the same implementation as the `task_update` tool.
   *
   * It used to call `setStatus` directly, so every option the tool learned — `scope`, the
   * instruction that answers a pending decision, and the resume-on-`running` behaviour — was
   * silently dropped for the buttons in the UI. Two implementations of one intent is how a page
   * can show success while the record does not change.
   */
  server.handle(
    RPC_CHANNELS.taskboard.UPDATE,
    async (
      _ctx,
      workspaceId: string,
      id: string,
      status?: TaskStatus,
      options?: {
        pauseReason?: string
        error?: string
        scope?: string
        /** The supervisor's reading of the person's reply; see `TaskSpec.directive`. */
        directive?: string
        /** Short board label; the tool can write it, so the board must be able to as well. */
        name?: string
      },
    ) => {
      const manager = deps.sessionManager as unknown as {
        updateTask?: (workspaceId: string, identifier: string, patch: Record<string, unknown>) => Promise<{ status: string; previousStatus?: string }>
        cancelProcessing?: (sessionId: string, silent?: boolean) => Promise<void>
      }
      if (!manager.updateTask) throw new Error('Task updater is not available in this build.')
      const service = tasksFor(deps, workspaceId)
      const before = service.get(id)
      const result = await manager.updateTask(workspaceId, id, {
        status: status ?? 'running',
        ...(options?.pauseReason ? { pauseReason: options.pauseReason } : {}),
        ...(options?.error ? { error: options.error } : {}),
        ...(options?.scope?.trim() ? { scope: options.scope.trim() } : {}),
        ...(options?.directive?.trim() ? { directive: options.directive.trim() } : {}),
        ...(options?.name?.trim() ? { name: options.name.trim() } : {}),
      })
      // Stopping a task has to stop the work: a label that changes while the worker keeps
      // writing is the same lie in the other direction.
      const after = service.get(id)
      const stopped = after?.status === 'paused' || after?.status === 'canceled'
      if (stopped && before?.status === 'running' && before.currentSessionId) {
        try {
          await manager.cancelProcessing?.(before.currentSessionId, true)
        } catch {
          // A session that never started cannot be stopped; the status change still stands.
        }
      }
      broadcast(workspaceId)
      return { status: result.status }
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
        runTask?: (
          workspaceId: string,
          taskId: string,
          reason: string,
        ) => Promise<{ started: boolean; reason?: string }>
      }
      if (!manager.runTask) throw new Error('Task runner is not available in this build.')
      const result = await manager.runTask(workspaceId, id, 'manual')
      broadcast(workspaceId)
      /**
       * The reason comes from the gate that refused, not from here.
       *
       * This answered every `false` with 「task is already running, blocked, or out of budget」.
       * When the real reason was 「你已回复…，但还没有人把这句话翻译成授权」, the button blamed a
       * budget nobody had spent.
       */
      return {
        started: result.started,
        ...(result.started ? {} : { reason: result.reason ?? '任务没有启动' }),
      }
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
      /**
       * Which question this reply closes.
       *
       * A task can be holding several open questions at once, so the answer has to name one.
       * Absent means 「the newest open question」, which is what a card raised before ids existed
       * carries.
       */
      decisionId?: string,
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
        /**
         * A question asked before the task exists is still a question.
         *
         * Planned work is often confirmed first and created afterwards — 「动手前先一次性问我三个
         * 问题」 — so the card is on screen while no task exists to own it. Every send came back
         * 「no task to answer」, which reads to the person as their click having failed; the
         * question was real and the asker was right there.
         *
         * The card names the session that asked, so the answer can go straight back to it. There
         * is no decision record to close in that case — the asker is waiting on the reply itself.
         */
        const managerNoTask = deps.sessionManager as unknown as {
          sendMessage?: (sessionId: string, text: string) => Promise<unknown>
        }
        if (!askedBySessionId || !managerNoTask.sendMessage) {
          return { accepted: false, reason: 'no task to answer — the card did not say which one' }
        }
        void managerNoTask.sendMessage(askedBySessionId, text.trim()).catch(() => undefined)
        return { accepted: true }
      }
      /**
       * A question can exist without a `decision` record, and then this used to be a dead end.
       *
       * `task.decision` is written by a worker's `needs_decision` hand-off. The supervisor's own
       * questions — the ones it writes with `report_to_user`, options and all — are messages, not
       * decisions, so a card drawn from one of those has nothing for `recordDecisionAnswer` to
       * find. Reported live: the card rendered with options and a textarea, and every send came
       * back 「no pending decision on this task」. Nothing the person could do with that: the
       * question was real, the answer had no route, and the task sat paused behind it.
       *
       * The distinction that has to survive: a decision that was already answered must still be
       * refused. Two surfaces show the same question, and accepting a second reply read it as a
       * second instruction (observed: the same 「放行」 arriving twice, 1.6s apart). So the check is
       * 「did this task ever have a decision?」 — if yes and it is not open, refuse; if no, deliver
       * the words to whoever asked.
       */
      const hadDecision = Boolean(service.get(resolvedId)?.decision)
      const task = service.recordDecisionAnswer(resolvedId, text, decisionId)
      if (!task && hadDecision) {
        // Answered already, or no longer open: say so instead of accepting words nobody will read.
        return { accepted: false, reason: 'no pending decision on this task' }
      }
      if (!task) {
        const managerForReply = deps.sessionManager as unknown as {
          sendMessage?: (sessionId: string, text: string) => Promise<unknown>
          decisionAskerFor?: (taskId: string) => string | undefined
        }
        const asker = askedBySessionId ?? managerForReply.decisionAskerFor?.(resolvedId)
        if (!asker || !managerForReply.sendMessage) {
          return { accepted: false, reason: 'no pending decision on this task' }
        }
        /**
         * Name the task in the reply, same as the decision path does.
         *
         * The supervisor's inbox holds several conversations and two open questions read as the
         * same prose; 「完成1.2，然后暂停」 without 「任务 T-1」 is a sentence the reader has to
         * place by memory.
         */
        const taskRecord = service.get(resolvedId)
        const line = taskRecord
          ? formatDecisionAnswerLine(taskRecord, text)
          : `〔任务 ${resolvedId} 拍板答复〕${text.trim()}`
        void managerForReply.sendMessage(asker, line).catch(() => undefined)
        broadcast(workspaceId)
        return { accepted: true }
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
      /**
       * Hold the answer until every question on this task has one.
       *
       * A task can hold several open questions — two failing checks, a boundary with two directions
       * open — and delivering each reply as it lands interrupts the supervisor per question. Worse,
       * it acts on the first reply while the person is still answering the second, so its next turn
       * is built on half an instruction.
       *
       * The reply is recorded either way (the card must close immediately), and the task stays
       * paused for a decision while anything is still open; `save` derives that from the queue.
       */
      const stillOpen = openDecisions(task)
      if (stillOpen.length) {
        broadcast(workspaceId)
        return { accepted: true, pending: stillOpen.length }
      }

      const askedBy = manager.decisionAskerFor?.(resolvedId)
      const supervisor = task.supervisorSessionId
      /**
       * Everything answered since the last delivery, not just this reply.
       *
       * This is what makes 「一起交给督导」 true: the batch is composed from the record, so the
       * supervisor reads the whole set with the question each answer belongs to.
       */
      const batch = undeliveredAnswers(task)
      if (supervisor && manager.sendMessage) {
        const line = batch.length > 1 ? formatDecisionAnswersLine(task, batch) : formatDecisionAnswerLine(task, text)
        /**
         * Fire and forget. `sendMessage` resolves when the whole turn has finished
         * streaming, so awaiting it kept this RPC open for the length of a model turn —
         * the answer had already been persisted and was already visible in the
         * supervisor's transcript, while the card still showed its buttons and the
         * person clicked again. The reply is delivered either way; the card must not
         * wait for the work it triggered.
         */
        void manager.sendMessage(supervisor, line).catch(() => undefined)
        // And the lane the card was shown in, so its copy of the question closes too.
        if (askedBy && askedBy !== supervisor) {
          void manager.sendMessage(askedBy, line).catch(() => undefined)
        }
        // Marked only after the send was issued: an answer that never left is still undelivered,
        // so a crash between the reply and the delivery does not lose what the person said.
        service.markAnswersDelivered(resolvedId)
      }
      broadcast(workspaceId)
      return { accepted: true, delivered: batch.length }
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.DELETE,
    async (_ctx: unknown, workspaceId: string, id: string) => {
      const service = tasksFor(deps, workspaceId);
      const task = service.get(id);
      /**
       * Every session that could still point at this task.
       *
       * `sessionIds` is the history; `currentSessionId` is the one that may be running right now.
       * They are normally the same set, but a task started through `spawnTaskRun` records the
       * session in two separate writes (`attachSession` for the list, `startRun` for the current
       * one), so a delete landing between them would leave the running session attached to a
       * record that no longer exists — the orphan this handler is trying to prevent.
       */
      const sessionIds = Array.from(
        new Set([...(task?.sessionIds ?? []), ...(task?.currentSessionId ? [task.currentSessionId] : [])]),
      );
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
