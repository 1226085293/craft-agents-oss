/**
 * Event Center RPC surface.
 *
 * The renderer never touches SQLite or spawns processes: it asks for metadata
 * pages, listener cards, or subscription state, and receives `events:changed`
 * / `events:listenerStatus` pushes.
 */

import { randomUUID } from 'node:crypto';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import {
  getEventService,
  listListenersFor,
  getListenerFor,
  type EventService,
} from '../../events/event-service';
import { runInstallCommand, type InstallResult } from '../../events/dependency-installer';
import {
  loadSubscriptions,
  saveSubscriptions,
  matchesFilter,
  type EventSubscription,
  type SubscriptionFilter,
} from '@craft-agent/shared/events/subscriptions.ts';
import type { EventFilter, EventMeta, EventRecord } from '@craft-agent/shared/events/event-store.ts';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.events.LIST,
  RPC_CHANNELS.events.GET,
  RPC_CHANNELS.events.COUNTS,
  RPC_CHANNELS.events.STATUS,
  RPC_CHANNELS.events.LIST_LISTENERS,
  RPC_CHANNELS.events.GET_LISTENER,
  RPC_CHANNELS.events.SET_LISTENER_ENABLED,
  RPC_CHANNELS.events.SET_LISTENER_CONFIG,
  RPC_CHANNELS.events.INSTALL_DEPENDENCY,
  RPC_CHANNELS.events.LIST_SUBSCRIPTIONS,
  RPC_CHANNELS.events.SUBSCRIBE,
  RPC_CHANNELS.events.UNSUBSCRIBE,
] as const;

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
  return workspace;
}

/** Strip the body before pushing: lists stay cheap, detail fetches on demand. */
function toMeta(event: EventRecord): EventMeta {
  const { body: _body, ...meta } = event;
  return meta;
}

export function registerEventsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  const service = (workspaceId: string) => {
    const workspace = requireWorkspace(workspaceId);
    return getEventService(workspaceId, workspace.rootPath, (event: EventRecord) => {
      pushTyped(
        server,
        RPC_CHANNELS.events.CHANGED,
        { to: 'workspace', workspaceId },
        workspaceId,
        toMeta(event),
      );
    }, _deps.sessionManager?.createEventDispatchTarget?.());
  };

  const broadcastStatus = (workspaceId: string, status: import('../../events/listener-supervisor').ListenerRuntimeStatus) => {
    pushTyped(
      server,
      RPC_CHANNELS.events.LISTENER_STATUS,
      { to: 'workspace', workspaceId },
      workspaceId,
      status,
    );
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

  // --- Listeners -----------------------------------------------------------

  server.handle(RPC_CHANNELS.events.LIST_LISTENERS, async (_ctx, workspaceId: string, skipProbes?: boolean) => {
    const workspace = requireWorkspace(workspaceId);
    const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
    // The list call skips subprocess probes by default: cards render instantly
    // and the detail page pays for the probe.
    return listListenersFor(svc, workspace.rootPath, skipProbes ?? true);
  });

  server.handle(RPC_CHANNELS.events.GET_LISTENER, async (_ctx, workspaceId: string, id: string) => {
    if (!id) throw new Error('id is required');
    const workspace = requireWorkspace(workspaceId);
    const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
    return getListenerFor(svc, workspace.rootPath, id);
  });

  server.handle(
    RPC_CHANNELS.events.SET_LISTENER_ENABLED,
    async (_ctx, workspaceId: string, id: string, enabled: boolean) => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      const status = await svc.setListenerEnabled(workspace.rootPath, id, enabled);
      broadcastStatus(workspaceId, status);
      return status;
    },
  );

  server.handle(
    RPC_CHANNELS.events.SET_LISTENER_CONFIG,
    async (_ctx, workspaceId: string, id: string, config: Record<string, unknown>) => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      svc.saveListenerConfig(workspace.rootPath, id, config ?? {});
      return { ok: true };
    },
  );

  server.handle(
    RPC_CHANNELS.events.INSTALL_DEPENDENCY,
    async (
      _ctx,
      workspaceId: string,
      id: string,
      dependency: { manager: 'pip' | 'npm'; name: string; range: string },
    ): Promise<InstallResult> => {
      requireWorkspace(workspaceId);
      return runInstallCommand(dependency);
    },
  );

  // --- Subscriptions -------------------------------------------------------

  server.handle(RPC_CHANNELS.events.LIST_SUBSCRIPTIONS, async (_ctx, workspaceId: string, sessionId: string) => {
    const workspace = requireWorkspace(workspaceId);
    return loadSubscriptions(workspace.rootPath).filter((sub) => sub.sessionId === sessionId);
  });

  server.handle(
    RPC_CHANNELS.events.SUBSCRIBE,
    async (_ctx, workspaceId: string, sessionId: string, filter: SubscriptionFilter) => {
      const workspace = requireWorkspace(workspaceId);
      const subscriptions = loadSubscriptions(workspace.rootPath);
      const subscription: EventSubscription = {
        subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
        sessionId,
        filter: filter ?? {},
        createdAt: Date.now(),
      };
      subscriptions.push(subscription);
      saveSubscriptions(workspace.rootPath, subscriptions);
      return subscription;
    },
  );

  server.handle(
    RPC_CHANNELS.events.UNSUBSCRIBE,
    async (_ctx, workspaceId: string, sessionId: string, subscriptionId?: string, source?: string) => {
      const workspace = requireWorkspace(workspaceId);
      const subscriptions = loadSubscriptions(workspace.rootPath);
      const remaining = subscriptions.filter((sub) => {
        if (sub.sessionId !== sessionId) return true;
        if (subscriptionId) return sub.subscriptionId !== subscriptionId;
        if (source) return !(sub.filter.sources ?? []).includes(source);
        // No selector: drop every subscription this session owns.
        return false;
      });
      saveSubscriptions(workspace.rootPath, remaining);
      return { removed: subscriptions.length - remaining.length, remaining: remaining.filter((s) => s.sessionId === sessionId) };
    },
  );
}

/** Re-exported so session tools can reuse the same matching rules. */
export { matchesFilter };
export type { EventService };
