/**
 * Event Center RPC surface.
 *
 * The renderer never touches SQLite: it asks for metadata pages, a single
 * event body, or the per-source counts, and receives `events:changed` when a
 * listener posts something new.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { getEventService } from '../../events/event-service';
import type { EventFilter, EventMeta, EventRecord } from '../../events/event-store';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.events.LIST,
  RPC_CHANNELS.events.GET,
  RPC_CHANNELS.events.COUNTS,
  RPC_CHANNELS.events.STATUS,
] as const;

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
  return workspace;
}

export function registerEventsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  /**
   * Resolve the workspace service, wiring the change broadcast on first use.
   * `pushTyped` targets the workspace so every window converges.
   */
  const service = (workspaceId: string) => {
    const workspace = requireWorkspace(workspaceId);
    return getEventService(workspaceId, workspace.rootPath, (event: EventRecord) => {
      // Strip the body before pushing: the list must stay cheap, and the
      // renderer fetches it through `events:get` when a row is opened.
      const { body: _body, ...meta } = event;
      pushTyped(
        server,
        RPC_CHANNELS.events.CHANGED,
        { to: 'workspace', workspaceId },
        workspaceId,
        meta satisfies EventMeta,
      );
    });
  };

  server.handle(RPC_CHANNELS.events.LIST, async (_ctx, workspaceId: string, filter: EventFilter = {}) => {
    const svc = await service(workspaceId);
    return svc.list(filter);
  });

  server.handle(RPC_CHANNELS.events.GET, async (_ctx, workspaceId: string, id: string) => {
    if (!id) throw new Error('id is required');
    const svc = await service(workspaceId);
    return svc.get(id);
  });

  server.handle(RPC_CHANNELS.events.COUNTS, async (_ctx, workspaceId: string) => {
    const svc = await service(workspaceId);
    return { counts: svc.counts(), status: svc.status() };
  });

  server.handle(RPC_CHANNELS.events.STATUS, async (_ctx, workspaceId: string) => {
    const svc = await service(workspaceId);
    return svc.status();
  });
}
