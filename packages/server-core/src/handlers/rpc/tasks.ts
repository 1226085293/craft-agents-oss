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
import type { TaskStatus } from '@craft-agent/shared/tasks';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.taskboard.LIST,
  RPC_CHANNELS.taskboard.GET,
  RPC_CHANNELS.taskboard.UPDATE,
  RPC_CHANNELS.taskboard.HANDOFF,
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

  server.handle(RPC_CHANNELS.taskboard.LIST, async (_ctx, payload: { workspaceId: string; status?: TaskStatus }) => {
    const service = tasksFor(deps, payload.workspaceId);
    return service.list(payload.status).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      priority: task.priority,
      updatedAt: task.updatedAt,
      currentSessionId: task.currentSessionId,
      sessionCount: task.sessionIds.length,
      lastHandoff: task.handoffs.at(-1)?.summary,
      pauseReason: task.pauseReason ?? null,
    }));
  });

  server.handle(
    RPC_CHANNELS.taskboard.GET,
    async (_ctx, payload: { workspaceId: string; id: string; includeJournal?: boolean }) => {
      const service = tasksFor(deps, payload.workspaceId);
      const task = service.get(payload.id);
      if (!task) throw new Error(`Task not found: ${payload.id}`);
      const journal = payload.includeJournal
        ? readJournal(requireWorkspace(payload.workspaceId).rootPath, payload.id)
        : undefined;
      return { task, journal };
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.UPDATE,
    async (
      _ctx,
      payload: {
        workspaceId: string;
        id: string;
        status?: TaskStatus;
        pauseReason?: string;
        error?: string;
      },
    ) => {
      const service = tasksFor(deps, payload.workspaceId);
      const task = service.setStatus(payload.id, payload.status ?? 'running', {
        pauseReason: payload.pauseReason as never,
        error: payload.error,
      });
      broadcast(payload.workspaceId);
      return task;
    },
  );

  server.handle(
    RPC_CHANNELS.taskboard.HANDOFF,
    async (_ctx, payload: { workspaceId: string; id: string; fromSessionId: string; handoff: unknown }) => {
      const service = tasksFor(deps, payload.workspaceId);
      const result = service.reportHandoff(payload.id, payload.handoff, payload.fromSessionId);
      broadcast(payload.workspaceId);
      return {
        passed: result.passed,
        reasons: result.reasons,
        status: result.task.status,
      };
    },
  );
}
