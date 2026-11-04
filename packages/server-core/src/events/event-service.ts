/**
 * Event Center — per-workspace service.
 *
 * Owns the SQLite store and the local ingest endpoint for one workspace.
 * Everything else (RPC handlers, session delivery) talks to this class rather
 * than to the store directly, so the retention policy and the change
 * broadcast stay in one place.
 *
 * Ingest is per workspace on purpose: `events/<listenerId>/` lives inside the
 * workspace, so a listener id can only ever mean one thing. Each workspace
 * gets its own port and token, which removes any cross-workspace ambiguity.
 */

import { join } from 'node:path';
import { createLogger } from '@craft-agent/shared/utils';
import { EventStore, type EventFilter, type EventMeta, type EventRecord } from '@craft-agent/shared/events/event-store.ts';
import { EventIngestServer, type EventIngestAddress } from './ingest-server.ts';
import {
  loadListeners,
  missingConfigKeys,
  setListenerConfig,
  setListenerEnabled,
  type LoadedListener,
} from './listener-registry.ts';
import { ListenerSupervisor, type ListenerRuntimeStatus } from './listener-supervisor.ts';
import { EventDispatcher, type DispatchTarget } from './event-dispatcher.ts';
import { fetchReportedDeps } from './listener-control.ts';
import { loadSubscriptions } from '@craft-agent/shared/events/subscriptions.ts';
import type { ListenerConfigSchema } from '@craft-agent/shared/events/manifest.ts';
import type { ListenerReportedDepsDto } from '@craft-agent/shared/protocol/dto';

const eventLog = createLogger('events');

export interface EventServiceOptions {
  workspaceId: string;
  workspaceRoot: string;
  /** Called after a non-duplicate insert so the host can push to renderers. */
  onChanged?: (event: EventRecord) => void;
  /** Called when a supervised listener changes state. */
  onListenerStatus?: (status: ListenerRuntimeStatus) => void;
  /**
   * Session delivery target. Absent in headless contexts that only collect
   * events (tests, ingest-only hosts), which leaves dispatching inert.
   */
  dispatchTarget?: DispatchTarget;
  /** Override for tests. */
  dbPath?: string;
  /** Override for tests; 0 disables. */
  retentionDays?: number;
  retentionRows?: number;
}

export interface EventServiceStatus {
  listening: boolean;
  host: string | null;
  port: number | null;
  /** Base URL listeners should POST to. */
  baseUrl: string | null;
}

export class EventService {
  private readonly options: EventServiceOptions;
  private readonly store: EventStore;
  private readonly ingest: EventIngestServer;
  private readonly supervisor: ListenerSupervisor;
  private readonly dispatcher: EventDispatcher | null;
  private started = false;

  constructor(options: EventServiceOptions) {
    this.options = options;
    const dbPath = options.dbPath ?? join(options.workspaceRoot, 'config', 'events.sqlite');

    this.store = new EventStore({
      dbPath,
      ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
      ...(options.retentionRows !== undefined ? { retentionRows: options.retentionRows } : {}),
    });

    this.ingest = new EventIngestServer({
      sink: this.store,
      onHealth: (listenerId) => {
        // A listener that can reach /health is proven working: flip it out of
        // 'starting' (and clear the ready-timeout) on the supervisor side.
        this.supervisor.markHealthy(listenerId);
      },
      onInserted: (event) => {
        this.options.onChanged?.(event);
        // Strip the body: the dispatcher only formats a nudge.
        const { body: _body, ...meta } = event;
        this.dispatcher?.dispatch(meta);
      },
    });

    this.dispatcher = options.dispatchTarget
      ? new EventDispatcher({
          getSubscriptions: () => loadSubscriptions(options.workspaceRoot),
          target: options.dispatchTarget,
        })
      : null;

    this.supervisor = new ListenerSupervisor({
      envFor: (listenerId) => this.ingest.listenerEnv(listenerId),
      onStatus: (status) => this.options.onListenerStatus?.(status),
    });
  }

  /**
   * Publish the endpoint to `<workspace>/config/events.json`.
   *
   * The token has to be readable by the user's own scripts, otherwise nobody
   * can hand-write a listener or curl the endpoint. Written owner-only.
   */
  private publishEndpoint(address: EventIngestAddress): void {
    try {
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
      const { dirname } = require('node:path') as typeof import('node:path')
      const path = join(this.options.workspaceRoot, 'config', 'events.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            baseUrl: `http://${address.host}:${address.port}`,
            host: address.host,
            port: address.port,
            token: address.token,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}
`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      eventLog.warn(`[events] cannot publish endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async start(): Promise<EventIngestAddress> {
    if (this.started) {
      const address = this.ingest.currentAddress;
      if (address) return address;
    }
    const address = await this.ingest.start();
    this.started = true;
    this.publishEndpoint(address);
    eventLog.info(
      `[events] ingest listening on ${address.host}:${address.port} for workspace ${this.options.workspaceId}`,
    );
    // Keep the table bounded without a scheduler thread of its own.
    try {
      this.store.prune();
    } catch (error) {
      eventLog.warn(`[events] initial prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return address;
  }

  async stop(): Promise<void> {
    await this.supervisor.stopAll();
    await this.ingest.stop();
    this.started = false;
  }

  /** Close the store too — only when the workspace is going away. */
  dispose(): void {
    try {
      this.store.close();
    } catch {
      // Already closed.
    }
  }

  list(filter: EventFilter): EventMeta[] {
    return this.store.list(filter);
  }

  get(id: string): EventRecord | null {
    return this.store.get(id);
  }

  counts(): Record<string, number> {
    return this.store.countsBySource();
  }

  status(): EventServiceStatus {
    const address = this.ingest.currentAddress;
    return {
      listening: Boolean(address),
      host: address?.host ?? null,
      port: address?.port ?? null,
      baseUrl: this.ingest.baseUrl,
    };
  }

  /** Env a supervised listener receives. */
  listenerEnv(listenerId: string): Record<string, string> {
    return this.ingest.listenerEnv(listenerId);
  }

  supervisorStatus(id: string): ListenerRuntimeStatus {
    return this.supervisor.getStatus(id);
  }

  allSupervisorStatuses(): ListenerRuntimeStatus[] {
    return this.supervisor.listStatuses();
  }

  /** Spawn (or no-op when already running) after checking readiness. */
  startListener(listener: LoadedListener): ListenerRuntimeStatus {
    const blocking = listener.dependencies.filter(
      (dep) => dep.state === 'missing' || dep.state === 'mismatch',
    );
    if (blocking.length > 0) {
      return {
        ...this.supervisor.getStatus(listener.id),
        state: 'failed',
        lastError: `dependencies not satisfied: ${blocking.map((d) => d.label).join(', ')}`,
      };
    }
    if (missingConfigKeys(listener).length > 0) {
      return {
        ...this.supervisor.getStatus(listener.id),
        state: 'failed',
        lastError: 'required config is missing',
      };
    }
    return this.supervisor.start(listener);
  }

  async stopListener(id: string): Promise<void> {
    await this.supervisor.stop(id);
  }

  markListenerHealthy(id: string): void {
    this.supervisor.markHealthy(id);
  }

  tailListenerLog(id: string, dataDir: string): string {
    return this.supervisor.tailLog(id, dataDir);
  }

  /** Enable/disable + start/stop in one step, the way the UI toggle behaves. */
  async setListenerEnabled(workspaceRoot: string, id: string, enabled: boolean): Promise<ListenerRuntimeStatus> {
    setListenerEnabled(workspaceRoot, id, enabled);
    if (!enabled) {
      await this.supervisor.stop(id);
      return this.supervisor.getStatus(id);
    }
    const listener = loadListeners({ workspaceRoot }).find((entry) => entry.id === id);
    if (!listener) {
      return { ...this.supervisor.getStatus(id), state: 'failed', lastError: 'listener not found' };
    }
    return this.startListener(listener);
  }

  saveListenerConfig(workspaceRoot: string, id: string, config: Record<string, unknown>): void {
    setListenerConfig(workspaceRoot, id, config);
  }

  /** Boot every enabled listener (app start, workspace switch). */
  async startAllEnabled(workspaceRoot: string): Promise<ListenerRuntimeStatus[]> {
    const listeners = loadListeners({ workspaceRoot }).filter((listener) => listener.enabled);
    return listeners.map((listener) => this.startListener(listener));
  }

  /** A session stopped processing: release events deferred for it. */
  flushDeferredEvents(sessionId: string): void {
    this.dispatcher?.flushDeferred(sessionId);
  }

  flushAllDeferredEvents(): void {
    this.dispatcher?.flushAll();
  }

  pendingEventCounts(): Record<string, number> {
    return this.dispatcher?.pendingCounts() ?? {};
  }

  /** Exposed for tests and the retention job. */
  prune(now?: number): number {
    return this.store.prune(now);
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

export interface ListenerView extends LoadedListener {
  status: ListenerRuntimeStatus
  missingConfig: string[]
  logTail: string
  /** Flattened from manifest so the renderer can read them at the top level. */
  name: string
  version: string
  description?: string
  icon?: string
  homepage?: string
  configSchema?: ListenerConfigSchema
  setup: Array<{ text: string; link?: string }>
  /** Dependency state the listener itself reports (control service). */
  controlDeps?: ListenerReportedDepsDto
  /** Tail of the last failed startup, when the process gave up non-zero. */
  startupErrorTail?: string
}

/** Map a LoadedListener (fields nested under `manifest`) onto the ListenerView shape. */
/** Map a LoadedListener (fields nested under `manifest`) onto the ListenerView shape. */
function toListenerView(
  listener: LoadedListener,
  service: EventService,
  logTail: string,
  controlDeps?: ListenerReportedDepsDto,
): ListenerView {
  const m = listener.manifest
  const status = service.supervisorStatus(listener.id)
  return {
    ...listener,
    name: m.name,
    version: m.version,
    description: m.description,
    icon: m.icon,
    homepage: m.homepage,
    configSchema: m.config,
    setup: m.setup ?? [],
    status,
    missingConfig: missingConfigKeys(listener),
    logTail,
    ...(controlDeps ? { controlDeps } : {}),
    ...(status.startupErrorTail ? { startupErrorTail: status.startupErrorTail } : {}),
  }
}

export function listListenersFor(service: EventService, workspaceRoot: string, skipProbes = false): ListenerView[] {
  return loadListeners({ workspaceRoot, skipProbes }).map((listener) =>
    toListenerView(listener, service, ''),
  )
}

export async function getListenerFor(
  service: EventService,
  workspaceRoot: string,
  id: string,
): Promise<ListenerView | null> {
  const listener = loadListeners({ workspaceRoot }).find((entry) => entry.id === id);
  if (!listener) return null;
  // The control service is listener-provided and optional; a missing or slow
  // answer just renders as "no dependency info".
  const controlDeps = await fetchReportedDeps(listener.dataDir);
  return toListenerView(listener, service, service.tailListenerLog(id, listener.dataDir), controlDeps);
}

// ---------------------------------------------------------------------------
// Per-workspace registry
// ---------------------------------------------------------------------------

const services = new Map<string, EventService>();

/**
 * Get (or lazily create + start) the service for a workspace.
 *
 * `onChanged` is rebound on every call so the newest renderer broadcast wins;
 * the service itself survives across calls.
 */
export async function getEventService(
  workspaceId: string,
  workspaceRoot: string,
  onChanged?: (event: EventRecord) => void,
  dispatchTarget?: DispatchTarget,
): Promise<EventService> {
  let service = services.get(workspaceId);
  if (!service) {
    service = new EventService({
      workspaceId,
      workspaceRoot,
      ...(onChanged ? { onChanged } : {}),
      ...(dispatchTarget ? { dispatchTarget } : {}),
    });
    services.set(workspaceId, service);
  }
  await service.start();
  return service;
}

export function getExistingEventService(workspaceId: string): EventService | undefined {
  return services.get(workspaceId);
}

export async function stopAllEventServices(): Promise<void> {
  for (const [id, service] of services) {
    try {
      await service.stop();
      service.dispose();
    } catch (error) {
      eventLog.warn(`[events] failed to stop service for ${id}: ${error}`);
    }
    services.delete(id);
  }
}

/** Test seam: drop everything without touching the network. */
export function resetEventServicesForTest(): void {
  for (const service of services.values()) service.dispose();
  services.clear();
}
