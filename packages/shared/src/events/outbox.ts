/**
 * Outbox: the durable half of sending.
 *
 * The article's point: an always-on agent's outbound messages must survive the
 * process that tried to send them. A send that failed (plugin stopped, bad
 * token, platform down) is not discarded — it is a row in this file, and a
 * dispatcher keeps retrying it with backoff and pacing. The UI's 发件箱 panel
 * reads the same file, so "what did I ask the agent to send, and what
 * actually went out" is one answer, not two.
 *
 * Only send-shaped actions are recorded (message text / file delivery): the
 * outbox is a queue of *messages to the outside world*, not a log of every
 * control-service call. Retrying an auth flow or a probe would be wrong.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../utils/index.ts';

const log = createLogger('events');

export type OutboxStatus = 'sent' | 'pending' | 'failed';

export interface OutboxRecord {
  id: string;
  /** The plugin that owns the channel (telegram, whatsapp, …). */
  listenerId: string;
  action: string;
  args: Record<string, unknown>;
  status: OutboxStatus;
  /** Retry attempts made by the dispatcher (0 while the first sync send is still the live one). */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** When the dispatcher may try again; absent while the first send is in flight. */
  nextAttemptAt?: number;
  lastError?: string;
}

interface Persisted {
  version: 1;
  records: OutboxRecord[];
}

/** Minimum gap between two dispatcher sends into the same plugin channel. */
export const OUTBOX_PACE_MS = 3000;
/** Backoff ladder for failed sends: 1s, 10s, 1m, 5m, 15m. */
export const OUTBOX_BACKOFF_MS = [1_000, 10_000, 60_000, 300_000, 900_000];
/** After this many attempts a record gives up and waits for a manual retry. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/**
 * Actions that move something OUT of the machine: safe to replay, worth
 * retrying, and the only things the outbox panel calls 「消息」.
 */
export const RETRYABLE_OUTBOX_ACTIONS = new Set(['send_message', 'reply', 'deliver_file']);

/** The outbox lives beside the other workspace state: `<root>/config/outbox.json`. */
export function outboxPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'outbox.json');
}

export function loadOutbox(workspaceRoot: string): OutboxRecord[] {
  const path = outboxPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records.filter(
      (entry): entry is OutboxRecord =>
        typeof entry?.id === 'string' &&
        typeof entry?.listenerId === 'string' &&
        typeof entry?.action === 'string' &&
        typeof entry?.status === 'string',
    );
  } catch (error) {
    // A corrupt outbox must not take event routing down: drop the file to a
    // re-serialisable state on the next save, and keep going with nothing.
    log.warn(`[outbox] unreadable records at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function saveOutbox(workspaceRoot: string, records: OutboxRecord[]): void {
  const path = outboxPath(workspaceRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
  } catch (error) {
    log.warn(`[outbox] could not persist: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function nextBackoffMs(attempts: number): number {
  const index = Math.min(attempts, OUTBOX_BACKOFF_MS.length - 1);
  // The ladder is non-empty, but index access still types as possibly-undefined;
  // the fallback only fires in the type system, not at runtime.
  return OUTBOX_BACKOFF_MS[index] ?? OUTBOX_PACE_MS;
}

/**
 * Record one plugin-action call in the outbox.
 *
 * The sync call already happened — the record exists so the dispatcher knows
 * what to retry, and the panel knows what the agent asked to send. Actions
 * outside `RETRYABLE_OUTBOX_ACTIONS` return null: they are not messages, and
 * replaying them would be wrong.
 */
export function recordOutboxCall(
  workspaceRoot: string,
  params: {
    listenerId: string;
    action: string;
    args: Record<string, unknown>;
    ok: boolean;
    error?: string;
    now?: number;
  },
): OutboxRecord | null {
  if (!RETRYABLE_OUTBOX_ACTIONS.has(params.action)) return null;
  const now = params.now ?? Date.now();
  const records = loadOutbox(workspaceRoot);
  const record: OutboxRecord = {
    id: `outb_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    listenerId: params.listenerId,
    action: params.action,
    args: params.args,
    status: params.ok ? 'sent' : 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...(params.ok
      ? {}
      : {
          lastError: params.error ?? 'send failed',
          nextAttemptAt: now + nextBackoffMs(0),
        }),
  };
  records.unshift(record);
  saveOutbox(workspaceRoot, records);
  return record;
}

/** Records the dispatcher may attempt right now: pending and due. */
export function outboxDue(records: OutboxRecord[], now: number): OutboxRecord[] {
  return records.filter(
    (record) =>
      record.status === 'pending' &&
      RETRYABLE_OUTBOX_ACTIONS.has(record.action) &&
      (record.nextAttemptAt === undefined || record.nextAttemptAt <= now),
  );
}
