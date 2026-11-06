/**
 * Thread bindings: which session is responsible for which conversation.
 *
 * The gap this closes, concretely: `message://<platform>/<channelId>/<messageId>`
 * already identifies a conversation, and `EventSubscription` can only say
 * "I want events from qq" — a *class*, not a conversation. So the second message
 * in a group chat became a new triage decision for the supervisor, and the third,
 * and the fourth. Every one of them cost a model turn, and the supervisor's turns
 * are capped, so a busy channel could sit in a loop of "start, get killed at the
 * cap, re-queue, start again".
 *
 * A binding says: this conversation is already being handled by that session. It
 * is a record, not a judgement, so routing by it costs no model call at all. The
 * supervisor then only sees genuinely new conversations — which is the work it is
 * actually for.
 *
 * Deliberately *not* a dependency graph: one conversation can be bound to one
 * session at a time (the most recent owner wins), because two sessions answering
 * the same channel is the confusion this is meant to remove.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { EventStore } from './event-store.ts';
import { createLogger } from '../utils/index.ts';

const log = createLogger('events');

/** How long a binding stays valid without being refreshed. */
export const THREAD_BINDING_TTL_MS = 12 * 60 * 60 * 1000;

export interface ThreadBinding {
  /** `message://platform/channelId` — the conversation, not the message. */
  threadKey: string;
  sessionId: string;
  /** Task the session is working on, when it has one. */
  taskId?: string;
  updatedAt: number;
}

interface Persisted {
  version: 1;
  bindings: ThreadBinding[];
}

/**
 * Record that a session owns the conversation an event arrived in.
 *
 * Reads the event from its own store to get `links` — the dispatcher only passes
 * a summary, not the links, so the identity has to be re-read rather than threaded
 * through every delivery call.
 *
 * Returns the thread key it bound, or undefined when the event carries no message
 * link (a webhook or a cron tick has no conversation, and inventing one would bind
 * unrelated events to whichever session happened to be last).
 */
export function bindThreadForEvent(params: {
  workspaceRoot: string;
  dbPath: string;
  eventId: string;
  sessionId: string;
  taskId?: string;
  now?: number;
}): string | undefined {
  const { workspaceRoot, dbPath, eventId, sessionId, taskId } = params;
  if (!existsSync(dbPath)) return undefined;
  const store = new EventStore({ dbPath });
  try {
    const event = store.get(eventId);
    const threadKey = deriveThreadKey(event?.links);
    if (!threadKey) return undefined;
    bindThread(
      workspaceRoot,
      { threadKey, sessionId, ...(taskId ? { taskId } : {}) },
      params.now,
    );
    return threadKey;
  } finally {
    store.close();
  }
}

/**
 * Derive the thread key from an event's links.
 *
 * `message://platform/channelId/messageId` — the channel identifies the
 * conversation, the trailing message id identifies one message inside it, which
 * is exactly the part that must be dropped. `channelId` can itself contain colons
 * (`group:123`, `user:456`), so the split is on the first segment and the *last*
 * slash only.
 *
 * Returns undefined when the event carries no message link: a CRM webhook or a
 * cron tick has no conversation to belong to, and inventing one would bind
 * unrelated events to whichever session happened to be last.
 */
export function deriveThreadKey(links: Array<{ url?: string }> | undefined): string | undefined {
  const link = links?.find((entry) => entry.url?.startsWith('message://'));
  if (!link?.url) return undefined;
  const rest = link.url.slice('message://'.length);
  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0) return undefined;
  const platform = rest.slice(0, firstSlash);
  const tail = rest.slice(firstSlash + 1);
  const lastSlash = tail.lastIndexOf('/');
  const channelId = lastSlash > 0 ? tail.slice(0, lastSlash) : tail;
  if (!platform || !channelId) return undefined;
  return `message://${platform}/${channelId}`;
}

function bindingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'config', 'thread-bindings.json');
}

/**
 * Read bindings for a workspace.
 *
 * A corrupt file yields no bindings rather than throwing: the worst case is that
 * routing falls back to the supervisor, which is the pre-existing behaviour. An
 * exception here would take the ingest path down instead.
 */
export function loadThreadBindings(workspaceRoot: string, now = Date.now()): ThreadBinding[] {
  const path = bindingsPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Persisted>;
    if (!Array.isArray(parsed.bindings)) return [];
    return parsed.bindings.filter((entry): entry is ThreadBinding =>
      typeof entry?.threadKey === 'string'
      && typeof entry?.sessionId === 'string'
      && typeof entry?.updatedAt === 'number'
      && now - entry.updatedAt < THREAD_BINDING_TTL_MS,
    );
  } catch (error) {
    log.warn(`[thread] unreadable bindings at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Look up one thread's owner. */
export function findThreadOwner(
  workspaceRoot: string,
  threadKey: string,
  now = Date.now(),
): ThreadBinding | undefined {
  return loadThreadBindings(workspaceRoot, now).find((entry) => entry.threadKey === threadKey);
}

/**
 * Record that a session now owns a conversation.
 *
 * One key, one owner: a later binding replaces an earlier one so a reassigned
 * thread has exactly one responder.
 */
export function bindThread(
  workspaceRoot: string,
  binding: { threadKey: string; sessionId: string; taskId?: string },
  now = Date.now(),
): void {
  const existing = loadThreadBindings(workspaceRoot, now).filter(
    (entry) => entry.threadKey !== binding.threadKey,
  );
  const next: Persisted = {
    version: 1,
    bindings: [
      ...existing,
      {
        threadKey: binding.threadKey,
        sessionId: binding.sessionId,
        ...(binding.taskId ? { taskId: binding.taskId } : {}),
        updatedAt: now,
      },
    ],
  };
  try {
    writeFileSync(bindingsPath(workspaceRoot), JSON.stringify(next, null, 2), 'utf-8');
  } catch (error) {
    // Losing a binding costs a supervisor turn later; it must not fail the
    // dispatch that was being recorded.
    log.warn(`[thread] could not persist binding for ${binding.threadKey}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Drop a thread's owner, e.g. when its session is gone. */
export function unbindThread(workspaceRoot: string, threadKey: string, now = Date.now()): void {
  const remaining = loadThreadBindings(workspaceRoot, now).filter((entry) => entry.threadKey !== threadKey);
  try {
    writeFileSync(bindingsPath(workspaceRoot), JSON.stringify({ version: 1, bindings: remaining }, null, 2), 'utf-8');
  } catch (error) {
    log.warn(`[thread] could not drop binding for ${threadKey}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Bindings whose session no longer exists, so the caller can clean them up. */
export function staleThreadBindings(
  bindings: ThreadBinding[],
  sessionExists: (sessionId: string) => boolean,
): ThreadBinding[] {
  return bindings.filter((entry) => !sessionExists(entry.sessionId));
}
