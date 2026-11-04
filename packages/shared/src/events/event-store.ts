/**
 * Event Center — storage.
 *
 * One SQLite table plus a standalone FTS5 index. Runs on `node:sqlite`
 * (available in Electron 39 / Node 22.21 without a flag), so there is no
 * native module to rebuild.
 *
 * Two rules this file must keep, because the table stores whole email bodies:
 *
 * 1. NEVER `SELECT *`. List queries name their columns; only `get()` reads
 *    `body`. A stray `*` turns a 5ms list into a full table scan of megabytes.
 * 2. Only `search_text` (title + summary + first 4KB of body, bigram-ised) is
 *    indexed. Indexing full bodies bloats the index by an order of magnitude.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqlite, type SqliteDatabase } from './sqlite.ts';
import {
  bigramText,
  type CraftEventEnvelope,
  type CraftEventLink,
  type CraftEventPayloadRef,
} from './types.ts';

/** Body bytes kept for search. Matches the design doc. */
const BODY_HEAD_CHARS = 4096;

export interface EventStoreOptions {
  /** Path to the SQLite file. `:memory:` is accepted for tests. */
  dbPath: string;
  /** Rows older than this are pruned. 0 disables the age rule. */
  retentionDays?: number;
  /** Keep at most this many rows. 0 disables the count rule. */
  retentionRows?: number;
}

export interface EventDelivery {
  /** Receiving session id. */
  sessionId: string;
  /** When the delivery surfaced into that session, epoch ms. */
  at: number;
}

export interface EventRecord extends CraftEventEnvelope {
  /** Per-session delivery records, latest entry per session. */
  deliveries: EventDelivery[];
}

/** List projection: everything except `body`. */
export type EventMeta = Omit<EventRecord, 'body'>;

export interface EventFilter {
  source?: string;
  /** `mail.received` or a prefix such as `mail.*`. */
  type?: string;
  /** Only events that carry at least one recipient. */
  hasRecipients?: boolean;
  delivered?: boolean;
  /** Inclusive lower bound, epoch ms. */
  since?: number;
  until?: number;
  /** Full-text query. Passed through `bigramText` before matching. */
  search?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface EventRow {
  id: string;
  source: string;
  type: string;
  received_at: number;
  occurred_at: number | null;
  title: string;
  summary: string | null;
  recipients: string | null;
  links: string | null;
  body: string | null;
  payload_kind: string | null;
  payload_path: string | null;
  payload_size: number | null;
  dedupe_key: string | null;
  delivered: number;
  deliveries: string | null;
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toEvent(row: EventRow, includeBody: boolean): EventRecord {
  const payloadRef: CraftEventPayloadRef | undefined = row.payload_path
    ? {
        kind: row.payload_kind ?? 'file',
        path: row.payload_path,
        ...(row.payload_size !== null ? { size: row.payload_size } : {}),
      }
    : undefined;

  return {
    spec: 'craft-event/1',
    id: row.id,
    source: row.source,
    type: row.type,
    receivedAt: row.received_at,
    ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    recipients: parseJsonArray<string>(row.recipients),
    links: parseJsonArray<CraftEventLink>(row.links),
    deliveries: parseJsonArray<EventDelivery>(row.deliveries),
    ...(includeBody && row.body !== null ? { body: row.body } : {}),
    ...(payloadRef ? { payloadRef } : {}),
    delivered: row.delivered === 1,
  };
}

const META_COLUMNS = `e.id, e.source, e.type, e.received_at, e.occurred_at, e.title, e.summary,
  e.recipients, e.links, e.payload_kind, e.payload_path, e.payload_size,
  e.dedupe_key, e.delivered, e.deliveries`;

export class EventStore {
  private readonly db: SqliteDatabase;
  private readonly retentionDays: number;
  private readonly retentionRows: number;

  constructor(options: EventStoreOptions) {
    this.retentionDays = options.retentionDays ?? 90;
    this.retentionRows = options.retentionRows ?? 50_000;

    if (options.dbPath !== ':memory:') {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.db = openSqlite(options.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        source       TEXT NOT NULL,
        type         TEXT NOT NULL,
        received_at  INTEGER NOT NULL,
        occurred_at  INTEGER,
        title        TEXT NOT NULL,
        summary      TEXT,
        recipients   TEXT,
        links        TEXT,
        body         TEXT,
        search_text  TEXT,
        payload_kind TEXT,
        payload_path TEXT,
        payload_size INTEGER,
        dedupe_key   TEXT,
        delivered    INTEGER NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
        ON events(source, dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_time ON events(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_delivered ON events(delivered, received_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        event_id UNINDEXED,
        search_text,
        tokenize='unicode61'
      );
    `);

    // Per-session delivery records (who received the event, when). Older
    // databases predate the column — added in place, nullable, no default.
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'deliveries')) {
      this.db.exec('ALTER TABLE events ADD COLUMN deliveries TEXT');
    }
  }

  /**
   * Store an event. Returns the id and whether this was a duplicate.
   *
   * Duplicate detection is the `(source, dedupe_key)` unique index, so two
   * listeners cannot collide and a re-delivered webhook is idempotent.
   */
  insert(event: CraftEventEnvelope): { id: string; duplicate: boolean } {
    if (event.dedupeKey) {
      const existing = this.db
        .prepare('SELECT id FROM events WHERE source = ? AND dedupe_key = ?')
        .get(event.source, event.dedupeKey) as { id: string } | undefined;
      if (existing) return { id: existing.id, duplicate: true };
    }

    const searchText = bigramText(
      [event.title, event.summary, event.body?.slice(0, BODY_HEAD_CHARS)].filter(Boolean).join('\n'),
    );

    const insert = this.db.prepare(`
      INSERT INTO events (
        id, source, type, received_at, occurred_at, title, summary, recipients,
        links, body, search_text, payload_kind, payload_path, payload_size, dedupe_key, delivered, deliveries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `);

    this.db.exec('BEGIN');
    try {
      insert.run(
        event.id,
        event.source,
        event.type,
        event.receivedAt,
        event.occurredAt ?? null,
        event.title,
        event.summary ?? null,
        event.recipients.length ? JSON.stringify(event.recipients) : null,
        event.links.length ? JSON.stringify(event.links) : null,
        event.body ?? null,
        searchText,
        event.payloadRef?.kind ?? null,
        event.payloadRef?.path ?? null,
        event.payloadRef?.size ?? null,
        event.dedupeKey ?? null,
      );
      this.db
        .prepare('INSERT INTO events_fts (event_id, search_text) VALUES (?, ?)')
        .run(event.id, searchText);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { id: event.id, duplicate: false };
  }

  /** List events WITHOUT bodies. */
  list(filter: EventFilter = {}): EventMeta[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.source) {
      where.push('e.source = ?');
      params.push(filter.source);
    }
    if (filter.type) {
      if (filter.type.endsWith('.*')) {
        where.push('e.type LIKE ?');
        params.push(`${filter.type.slice(0, -1)}%`);
      } else {
        where.push('e.type = ?');
        params.push(filter.type);
      }
    }
    if (filter.hasRecipients) {
      where.push("e.recipients IS NOT NULL AND e.recipients != '[]'");
    }
    if (filter.delivered !== undefined) {
      where.push('e.delivered = ?');
      params.push(filter.delivered ? 1 : 0);
    }
    if (filter.since !== undefined) {
      where.push('e.received_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      where.push('e.received_at <= ?');
      params.push(filter.until);
    }

    let join = '';
    if (filter.search?.trim()) {
      join = 'JOIN events_fts f ON f.event_id = e.id';
      where.push('events_fts MATCH ?');
      params.push(bigramText(filter.search.trim()));
    }

    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);

    const sql = `
      SELECT ${META_COLUMNS}
      FROM events e ${join}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.received_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit, offset) as unknown as EventRow[];
    return rows.map((row) => toEvent(row, false));
  }

  /** Full event, including the body. */
  get(id: string): EventRecord | null {
    const row = this.db
      .prepare(`SELECT ${META_COLUMNS}, e.body FROM events e WHERE e.id = ?`)
      .get(id) as unknown as EventRow | undefined;
    return row ? toEvent(row, true) : null;
  }

  markDelivered(ids: string[]): number {
    if (!ids.length) return 0;
    const stmt = this.db.prepare('UPDATE events SET delivered = 1 WHERE id = ? AND delivered = 0');
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        const result = stmt.run(id);
        changed += Number(result.changes ?? 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /**
   * Record that a session received this event, and mark it delivered. The
   * latest delivery per session wins (re-delivery after a deferral replaces
   * the older entry, so the list answers "who has it now").
   */
  recordDelivery(id: string, sessionId: string, at: number): void {
    const row = this.db
      .prepare('SELECT deliveries, delivered FROM events WHERE id = ?')
      .get(id) as { deliveries: string | null; delivered: number } | undefined;
    if (!row) return;

    const deliveries = parseJsonArray<EventDelivery>(row.deliveries).filter(
      (entry) => entry.sessionId !== sessionId,
    );
    deliveries.push({ sessionId, at });
    this.db
      .prepare('UPDATE events SET deliveries = ?, delivered = 1 WHERE id = ?')
      .run(JSON.stringify(deliveries), id);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    return row.c;
  }

  /** By-source totals for the listener cards. */
  countsBySource(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT source, COUNT(*) AS c FROM events GROUP BY source')
      .all() as unknown as Array<{ source: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.source, r.c]));
  }

  /**
   * Apply the retention policy. Returns how many rows were removed.
   *
   * Deletion is batched so a first run against a large table cannot hold the
   * write lock long enough to stall ingestion.
   */
  prune(now = Date.now()): number {
    let removed = 0;

    if (this.retentionDays > 0) {
      const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
      removed += this.deleteBatched('received_at < ?', [cutoff]);
    }

    if (this.retentionRows > 0) {
      const total = this.count();
      if (total > this.retentionRows) {
        const overflow = total - this.retentionRows;
        const ids = this.db
          .prepare('SELECT id FROM events ORDER BY received_at ASC LIMIT ?')
          .all(overflow) as unknown as Array<{ id: string }>;
        removed += this.deleteIds(ids.map((r) => r.id));
      }
    }

    return removed;
  }

  private deleteBatched(whereSql: string, params: Array<string | number>): number {
    let removed = 0;
    for (;;) {
      const ids = this.db
        .prepare(`SELECT id FROM events WHERE ${whereSql} LIMIT 500`)
        .all(...params) as unknown as Array<{ id: string }>;
      if (!ids.length) break;
      removed += this.deleteIds(ids.map((r) => r.id));
      if (ids.length < 500) break;
    }
    return removed;
  }

  private deleteIds(ids: string[]): number {
    if (!ids.length) return 0;
    const delEvent = this.db.prepare('DELETE FROM events WHERE id = ?');
    const delFts = this.db.prepare('DELETE FROM events_fts WHERE event_id = ?');
    let removed = 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        removed += Number(delEvent.run(id).changes ?? 0);
        delFts.run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return removed;
  }

  close(): void {
    this.db.close();
  }
}
