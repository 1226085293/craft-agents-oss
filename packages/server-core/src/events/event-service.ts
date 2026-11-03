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
import { EventStore, type EventFilter, type EventMeta, type EventRecord } from './event-store.ts';
import { EventIngestServer, type EventIngestAddress } from './ingest-server.ts';

const eventLog = createLogger('events');

export interface EventServiceOptions {
  workspaceId: string;
  workspaceRoot: string;
  /** Called after a non-duplicate insert so the host can push to renderers. */
  onChanged?: (event: EventRecord) => void;
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
      onInserted: (event) => {
        this.options.onChanged?.(event);
      },
    });
  }

  async start(): Promise<EventIngestAddress> {
    if (this.started) {
      const address = this.ingest.currentAddress;
      if (address) return address;
    }
    const address = await this.ingest.start();
    this.started = true;
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

  /** Env a supervised listener receives (P2 uses this). */
  listenerEnv(listenerId: string): Record<string, string> {
    return this.ingest.listenerEnv(listenerId);
  }

  /** Exposed for tests and the retention job. */
  prune(now?: number): number {
    return this.store.prune(now);
  }
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
): Promise<EventService> {
  let service = services.get(workspaceId);
  if (!service) {
    service = new EventService({ workspaceId, workspaceRoot, ...(onChanged ? { onChanged } : {}) });
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
