/**
 * Event Center RPC surface.
 *
 * The renderer never touches SQLite or spawns processes: it asks for metadata
 * pages, listener cards, or subscription state, and receives `events:changed`
 * / `events:listenerStatus` pushes.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
import { loadListeners } from '../../events/listener-registry';
import { runInstallCommand, type InstallResult } from '../../events/dependency-installer';
import { installMcp, type McpInstallResult } from '../../events/mcp-registry';
import { fetchReportedDeps, postDepAction, callPluginAction } from '../../events/listener-control';
import {
  loadSubscriptions,
  saveSubscriptions,
  matchesFilter,
  type EventSubscription,
  type SubscriptionFilter,
} from '@craft-agent/shared/events/subscriptions.ts';
import type { EventFilter, EventMeta, EventRecord } from '@craft-agent/shared/events/event-store.ts';
import type { EventAttachmentContentDto } from '@craft-agent/shared/protocol';
import {
  readAttachmentContent,
  resolveAttachmentPath,
  type AttachmentReadMode,
} from '../../events/attachment-file';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.events.LIST,
  RPC_CHANNELS.events.GET,
  RPC_CHANNELS.events.READ_ATTACHMENT,
  RPC_CHANNELS.events.OPEN_ATTACHMENT,
  RPC_CHANNELS.events.COUNTS,
  RPC_CHANNELS.events.STATUS,
  RPC_CHANNELS.events.LIST_LISTENERS,
  RPC_CHANNELS.events.GET_LISTENER,
  RPC_CHANNELS.events.GET_LISTENER_UI,
  RPC_CHANNELS.events.GET_LISTENER_LOG,
  RPC_CHANNELS.events.SET_LISTENER_ENABLED,
  RPC_CHANNELS.events.SET_LISTENER_CONFIG,
  RPC_CHANNELS.events.INSTALL_DEPENDENCY,
  RPC_CHANNELS.events.INSTALL_MCP,
  RPC_CHANNELS.events.LISTENER_DEPS,
  RPC_CHANNELS.events.LISTENER_DEPS_ACTION,
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
    }, _deps.sessionManager?.createEventDispatchTarget?.(), (event: EventMeta) => {
      // Nobody subscribed. Rules run first; unmatched events fall through to
      // the supervisor's merged backlog. This callback is also installed during
      // app warm-up, before any events RPC request occurs.
      void _deps.sessionManager?.routeUnclaimedEvent?.(workspaceId, event).catch(() => {
        // Routing an event must never take the ingest path down.
      });
    });
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

  /**
   * Tell renderers that a listener's on-disk facts changed (enabled flag,
   * saved config, installed dependency). Process state flows over
   * LISTENER_STATUS; these are the facts a status event cannot carry, and
   * the plugin list's lights must not wait for a page reload to see them.
   */
  const pushListenerChanged = (
    workspaceId: string,
    listenerId: string,
    reason: 'enabled' | 'config' | 'dependency',
  ) => {
    pushTyped(
      server,
      RPC_CHANNELS.events.LISTENER_CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      { listenerId, reason },
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

  /**
   * Attachment content for the preview overlays.
   *
   * `mode` is chosen by the renderer from `classifyFile`, the same function the
   * session previews use — so the Event Center shows exactly the file types a
   * session can show, and nothing silently diverges.
   */
  server.handle(
    RPC_CHANNELS.events.READ_ATTACHMENT,
    async (
      _ctx,
      workspaceId: string,
      eventId: string,
      index: number,
      mode: AttachmentReadMode,
    ): Promise<EventAttachmentContentDto> => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await service(workspaceId);
      const event = svc.get(eventId);
      if (!event) throw new Error(`Event ${eventId} not found`);
      const attachment = event.attachments[index];
      if (!attachment) throw new Error(`Attachment ${index} not found on event ${eventId}`);
      const filePath = resolveAttachmentPath(workspace.rootPath, attachment.path);
      return readAttachmentContent(filePath, mode, attachment.mime);
    },
  );

  /** Hand the attachment to the OS — the same escape hatch sessions use for
   *  types the app cannot preview (Office documents, archives). */
  server.handle(
    RPC_CHANNELS.events.OPEN_ATTACHMENT,
    async (_ctx, workspaceId: string, eventId: string, index: number): Promise<void> => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await service(workspaceId);
      const event = svc.get(eventId);
      if (!event) throw new Error(`Event ${eventId} not found`);
      const attachment = event.attachments[index];
      if (!attachment) throw new Error(`Attachment ${index} not found on event ${eventId}`);
      const filePath = resolveAttachmentPath(workspace.rootPath, attachment.path);
      if (!_deps.platform.openPath) {
        throw new Error('this host cannot open files with the system default application');
      }
      await _deps.platform.openPath(filePath);
    },
  );

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

  server.handle(
    RPC_CHANNELS.events.GET_LISTENER,
    async (_ctx, workspaceId: string, id: string) => {
      if (!id) throw new Error('id is required');
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      return getListenerFor(svc, workspace.rootPath, id);
    },
  );

  /**
   * The plugin's own HTML page. The renderer never touches the
   * filesystem: the document is resolved and read here, confined to the
   * plugin directory (the manifest already validated the path shape).
   */
  server.handle(
    RPC_CHANNELS.events.GET_LISTENER_UI,
    async (
      _ctx,
      workspaceId: string,
      id: string,
    ): Promise<{ html: string | null; source?: 'file' | 'inline' }> => {
      if (!id) throw new Error('id is required');
      const workspace = requireWorkspace(workspaceId);
      const listener = loadListeners({ workspaceRoot: workspace.rootPath, skipProbes: true }).find(
        (entry) => entry.id === id,
      );
      if (!listener) return { html: null };
      const ui = listener.manifest.ui;
      if (!ui) return { html: null };
      if (ui.page) {
        // The manifest confines the path (relative, plain segments); resolve
        // is the belt-and-suspenders check before touching the filesystem.
        const filePath = resolve(join(listener.dir, ui.page));
        const inside = filePath.startsWith(resolve(listener.dir) + sep);
        if (!inside || !existsSync(filePath)) return { html: null };
        try {
          return { html: readFileSync(filePath, 'utf8'), source: 'file' };
        } catch {
          return { html: null };
        }
      }
      return { html: ui.pageInline ?? null, source: 'inline' };
    },
  );

  /** Log tail + live process state, without re-running dependency probes. */
  server.handle(
    RPC_CHANNELS.events.GET_LISTENER_LOG,
    async (_ctx, workspaceId: string, id: string) => {
      if (!id) throw new Error('id is required');
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      const dataDir = join(workspace.rootPath, 'events-data', id);
      return {
        logTail: svc.tailListenerLog(id, dataDir),
        status: svc.supervisorStatus(id),
      };
    },
  );

  server.handle(
    RPC_CHANNELS.events.SET_LISTENER_ENABLED,
    async (_ctx, workspaceId: string, id: string, enabled: boolean) => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      const status = await svc.setListenerEnabled(workspace.rootPath, id, enabled);
      broadcastStatus(workspaceId, status);
      pushListenerChanged(workspaceId, id, 'enabled');
      return status;
    },
  );

  server.handle(
    RPC_CHANNELS.events.SET_LISTENER_CONFIG,
    async (_ctx, workspaceId: string, id: string, config: Record<string, unknown>) => {
      const workspace = requireWorkspace(workspaceId);
      const svc = await getEventService(workspaceId, workspace.rootPath, undefined);
      // Applied to a running plugin immediately, with the previous config kept
      // as a fallback. `restart` is null when the plugin was not running, in
      // which case the new config simply applies on the next start.
      const restart = await svc.saveListenerConfig(workspace.rootPath, id, config ?? {});
      pushListenerChanged(workspaceId, id, 'config');
      return { ok: true, restart };
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
      const result = await runInstallCommand(dependency);
      pushListenerChanged(workspaceId, id, 'dependency');
      return result;
    },
  );

  server.handle(RPC_CHANNELS.events.INSTALL_MCP, async (_ctx, workspaceId: string, id: string, mcpId: string) => {
    if (!id || !mcpId) throw new Error('id and mcpId are required');
    const workspace = requireWorkspace(workspaceId);
    // Resolve the mcp dependency from the manifest on the server side — the
    // renderer only names it, never supplies install parameters.
    const listener = loadListeners({ workspaceRoot: workspace.rootPath, skipProbes: true }).find(
      (entry) => entry.id === id,
    );
    const dep = listener?.manifest.dependencies?.mcp?.find((m) => m.id === mcpId);
    if (!dep) throw new Error(`listener ${id} declares no mcp dependency "${mcpId}"`);
    const result = await installMcp(workspace.rootPath, dep);
    pushListenerChanged(workspaceId, id, 'dependency');
    return result;
  });

  server.handle(RPC_CHANNELS.events.LISTENER_DEPS, async (_ctx, workspaceId: string, id: string) => {
    if (!id) throw new Error('id is required');
    const workspace = requireWorkspace(workspaceId);
    return fetchReportedDeps(join(workspace.rootPath, 'events-data', id));
  });

  server.handle(
    RPC_CHANNELS.events.LISTENER_DEPS_ACTION,
    async (_ctx, workspaceId: string, id: string, depId: string) => {
      if (!id || !depId) throw new Error('id and depId are required');
      const workspace = requireWorkspace(workspaceId);
      return postDepAction(join(workspace.rootPath, 'events-data', id), depId);
    },
  );

  /**
   * The plugin's own HTML page calls home through here: one of the plugin's
   * manifest-declared actions, relayed to its loopback control service. The
   * host only enforces the whitelist — what the action does is the plugin's.
   */
  server.handle(
    RPC_CHANNELS.events.LISTENER_PLUGIN_ACTION,
    async (_ctx, workspaceId: string, id: string, action: string, args: Record<string, unknown>) => {
      if (!id || !action) throw new Error('id and action are required');
      const workspace = requireWorkspace(workspaceId);
      const entry = loadListeners({ workspaceRoot: workspace.rootPath, skipProbes: true }).find(
        (listener) => listener.id === id,
      );
      if (!entry) return { ok: false, message: `插件 ${id} 未安装` };
      const declared = (entry.manifest.actions ?? []).find((a) => a.name === action);
      if (!declared) return { ok: false, message: `插件 ${id} 没有声明动作 ${action}` };
      return callPluginAction(entry.dataDir, { action, args: args ?? {} });
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
