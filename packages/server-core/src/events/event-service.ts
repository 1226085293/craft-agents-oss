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
import { existsSync } from 'node:fs';
import { createLogger } from '@craft-agent/shared/utils';
import { EventStore, type EventFilter, type EventMeta, type EventRecord } from '@craft-agent/shared/events/event-store.ts';
import { EventIngestServer, type EventIngestAddress } from './ingest-server.ts';
import { loadListeners, missingConfigKeys, setListenerConfig, setListenerEnabled, type LoadedListener, pluginReadiness } from './listener-registry.ts';
import { ListenerSupervisor, type ListenerRuntimeStatus } from './listener-supervisor.ts';
import { EventDispatcher, type DispatchTarget } from './event-dispatcher.ts';
import { fetchReportedDeps } from './listener-control.ts';
import { loadSubscriptions } from '@craft-agent/shared/events/subscriptions.ts';
import type { ListenerConfigSchema } from '@craft-agent/shared/events/manifest.ts';
import type { CraftEventEnvelope } from '@craft-agent/shared/events/types.ts';
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
  /**
   * Called for an event no session subscribed to.
   *
   * The host wires this to the workspace supervisor runtime (rules first, then
   * the supervisor). May be rebound after a boot warm-up creates the service.
   */
  onUnclaimed?: (event: EventMeta) => void;
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
  private dispatcher: EventDispatcher | null;
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
      onInserted: (event) => this.publish(event),
    });

    this.dispatcher = options.dispatchTarget ? this.createDispatcher(options.dispatchTarget) : null;

    this.supervisor = new ListenerSupervisor({
      envFor: (listenerId) => this.ingest.listenerEnv(listenerId),
      onStatus: (status) => this.options.onListenerStatus?.(status),
    });
  }

  /**
   * Announce and dispatch one freshly stored event.
   *
   * Shared by the HTTP ingest server and the messaging bridge so an event that
   * came from a group chat reaches rules, tasks and the audit trail by exactly
   * the same path as a webhook — one funnel, one dedupe, one history.
   */
  private publish(event: CraftEventEnvelope): void {
    // A freshly inserted event has no deliveries yet — they land via
    // onDelivered below. Renderers get the enriched record shape.
    const record: EventRecord = { ...event, deliveries: [], routing: [] };
    this.options.onChanged?.(record);
    // Strip the body: the dispatcher only formats a nudge.
    const { body: _body, ...meta } = record;
    this.dispatcher?.dispatch(meta);
  }

  /**
   * Store an event that did not arrive over HTTP.
   *
   * The messaging bridge produces these: a group message that mentions the bot
   * is an external event, not a user turn. Returns null when the store rejects
   * the payload, so the caller can log and continue instead of throwing into a
   * chat pipeline.
   */
  ingestExternalEvent(event: CraftEventEnvelope): { id: string; duplicate: boolean } | null {
    try {
      const result = this.store.insert(event);
      if (!result.duplicate) this.publish(event);
      return result;
    } catch (error) {
      eventLog.warn(
        `[events] external event rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private createDispatcher(target: DispatchTarget): EventDispatcher {
    return new EventDispatcher({
      getSubscriptions: () => loadSubscriptions(this.options.workspaceRoot),
      target,
      // Read the current host callback at dispatch time. The boot warm-up can
      // create this dispatcher before RPC registers the supervisor callback.
      onUnclaimed: (event) => {
        // Tier boundary: nothing was subscribed, so the rule table (and, failing
        // that, the supervisor) owns it. Recorded here rather than downstream so
        // "nobody subscribed" stays visible even if routing throws.
        try {
          this.store.recordRouting(event.id, {
            via: 'supervisor',
            outcome: '无订阅者，转规则/督导',
            at: Date.now(),
          });
        } catch {
          // Audit is best-effort: losing a trail line must not drop the event.
        }
        this.options.onUnclaimed?.(event);
      },
      onDelivered: (eventId, sessionId) => {
        try {
          this.store.recordDelivery(eventId, sessionId, Date.now());
          this.store.recordRouting(eventId, {
            via: 'subscription',
            target: sessionId,
            outcome: '投递给订阅会话',
            at: Date.now(),
          });
        } catch (error) {
          eventLog.warn(
            `[events] cannot record delivery for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
  }

  /**
   * Rebind host callbacks after construction.
   *
   * Binding only in the constructor is a trap: the boot warm-up starts the
   * service before any renderer exists and therefore passes no `onChanged`, and
   * every later RPC call would silently keep that callback-less instance — so
   * inserts never reach the UI and the list only updates on reload. Callers
   * pass `undefined` when they have nothing new to say; absent values must not
   * clear an already-live callback.
   */
  updateCallbacks(callbacks: {
    onChanged?: (event: EventRecord) => void;
    onListenerStatus?: (status: ListenerRuntimeStatus) => void;
    dispatchTarget?: DispatchTarget;
    onUnclaimed?: (event: EventMeta) => void;
  }): void {
    if (callbacks.onChanged) this.options.onChanged = callbacks.onChanged;
    if (callbacks.onListenerStatus) this.options.onListenerStatus = callbacks.onListenerStatus;
    if (callbacks.onUnclaimed) this.options.onUnclaimed = callbacks.onUnclaimed;
    // A host that only learns the delivery target after boot (Electron builds it
    // with the session manager) must still get a dispatcher.
    if (callbacks.dispatchTarget && !this.dispatcher) {
      this.options.dispatchTarget = callbacks.dispatchTarget;
      this.dispatcher = this.createDispatcher(callbacks.dispatchTarget);
    }
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

  /**
   * Spawn (or no-op when already running) — but only when the plugin is ready.
   *
   * The gate lives here so every entry point (autostart, the enable toggle,
   * "start" on the detail page) applies the same rule. A plugin that is not
   * installed, switched off, missing required config, missing a dependency, or
   * has no runnable program is reported as `stopped` with a reason — not
   * `failed`. Nothing is running, but nothing is broken either; a plugin that
   * has just been installed has no credentials yet, and that must not raise an
   * error every time Craft starts.
   */
  startListener(listener: LoadedListener): ListenerRuntimeStatus {
    const readiness = pluginReadiness(listener);
    if (!readiness.ready) {
      return {
        ...this.supervisor.getStatus(listener.id),
        state: 'stopped',
        ...(readiness.detail ? { lastError: readiness.detail } : {}),
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
    const listener = loadListeners({ workspaceRoot, catalogDirs: pluginCatalogDirs() }).find((entry) => entry.id === id);
    if (!listener) {
      return { ...this.supervisor.getStatus(id), state: 'failed', lastError: 'listener not found' };
    }
    return this.startListener(listener);
  }

  saveListenerConfig(workspaceRoot: string, id: string, config: Record<string, unknown>): void {
    setListenerConfig(workspaceRoot, id, config);
  }

  /**
   * Boot the ready plugins (app start, workspace switch).
   *
   * Unready ones are skipped rather than attempted-and-failed: their state is
   * already `stopped`, so at launch they simply do not start. This is what
   * makes autostart conditional on "configured and environment satisfied".
   */
  async startAllEnabled(workspaceRoot: string): Promise<ListenerRuntimeStatus[]> {
    const listeners = loadListeners({ workspaceRoot, catalogDirs: pluginCatalogDirs() }).filter(
      (listener) => pluginReadiness(listener).ready,
    );
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

/**
 * Bundled plugin directories, highest priority first.
 *
 * The catalog ships with Craft (a plain `plugins/` directory in the repo or the
 * packaged app) and is read-only in spirit: it exists so a plugin can be seen
 * and adopted without a download step. Plugin *data* never lives there — see
 * `events-data/<id>` in the workspace.
 *
 * `CRAFT_PLUGIN_CATALOG` lets a developer point at another directory without
 * rebuilding.
 */
export function pluginCatalogDirs(): string[] {
  const dirs: string[] = []
  const envDir = process.env.CRAFT_PLUGIN_CATALOG
  if (envDir && existsSync(envDir)) dirs.push(envDir)

  // Repo layout: <root>/plugins. Packaged: resources/plugins next to the app.
  const candidates = [
    join(process.cwd(), 'plugins'),
    join(process.cwd(), '..', '..', 'plugins'),
    typeof (process as { resourcesPath?: string }).resourcesPath === 'string'
      ? join((process as { resourcesPath?: string }).resourcesPath!, 'plugins')
      : '',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && !dirs.includes(candidate)) dirs.push(candidate)
  }
  return dirs
}

export function listListenersFor(service: EventService, workspaceRoot: string, skipProbes = false): ListenerView[] {
  return loadListeners({ workspaceRoot, skipProbes, catalogDirs: pluginCatalogDirs() }).map((listener) =>
    toListenerView(listener, service, ''),
  )
}

export async function getListenerFor(
  service: EventService,
  workspaceRoot: string,
  id: string,
): Promise<ListenerView | null> {
  const listener = loadListeners({ workspaceRoot, catalogDirs: pluginCatalogDirs() }).find((entry) => entry.id === id);
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
  onUnclaimed?: (event: EventMeta) => void,
): Promise<EventService> {
  let service = services.get(workspaceId);
  if (!service) {
    service = new EventService({
      workspaceId,
      workspaceRoot,
      ...(onChanged ? { onChanged } : {}),
      ...(dispatchTarget ? { dispatchTarget } : {}),
      ...(onUnclaimed ? { onUnclaimed } : {}),
    });
    services.set(workspaceId, service);
  }
  // Rebind on every access, not just at creation: the boot warm-up runs before
  // any renderer is connected and passes no `onChanged`, so a create-only bind
  // would leave the instance permanently silent to the UI.
  service.updateCallbacks({
    ...(onChanged ? { onChanged } : {}),
    ...(dispatchTarget ? { dispatchTarget } : {}),
    ...(onUnclaimed ? { onUnclaimed } : {}),
  });
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
