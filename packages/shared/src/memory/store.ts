/**
 * Memory Store — Persistent cross-session memory storage.
 *
 * Reads/writes workspace-scoped memory.json for structured memory management.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MemoryEntry,
  MemoryStore,
  SessionMemoryStore,
  MemoryExtractionRecord,
  MemoryQueryArgs,
  MemoryQueryResult,
  MemoryAction,
  MemoryType,
  MemoryTrashEntry,
  BlockedRecord,
  ExtractionRetryItem,
} from './types.ts';
import { foldLegacyMemoryType, memoryConfig } from './types.ts';

/**
 * Concurrency guard (A+B, 2026-10-11): track the last seen mtime PER STORE
 * INSTANCE. Multiple processes (installed app + dev instance) share the same
 * memory.json; a second process writing its own stale snapshot can silently
 * wipe another's entries. Before saving we re-stat: if the file changed since
 * THIS store instance was loaded/saved, re-read the on-disk store and merge
 * the caller's changes on top instead of clobbering. Keyed by store object
 * (not workspace) so two live snapshots of the same file keep independent
 * baselines — exactly like two OS processes would.
 */
const storeMtimes = new WeakMap<MemoryStore, number>();

function fileMtimeMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null; // file missing
  }
}

/**
 * Merge the caller's store over a fresher on-disk store. Entries are keyed by
 * id: on-disk-only entries survive (added by another process), caller entries
 * win on id collision (this process just modified them). Non-entry fields
 * (trash, vocabulary, history, stats) follow the same keep-both merge.
 */
function mergeWithDisk(disk: MemoryStore, incoming: MemoryStore): MemoryStore {
  const entries = new Map<string, MemoryEntry>();
  const entryRecency = (e: MemoryEntry): number => {
    const t = e.updatedAt ?? e.createdAt ?? '';
    const n = Date.parse(t);
    return Number.isNaN(n) ? 0 : n;
  };
  for (const e of disk.entries ?? []) entries.set(e.id, e);
  for (const e of incoming.entries ?? []) {
    const existing = entries.get(e.id);
    // Disk wins on ties: an external edit (e.g. user hand-edit) does NOT bump
    // updatedAt, so a stale in-memory snapshot must never clobber it. A real
    // in-process update bumps updatedAt → incoming wins.
    if (!existing || entryRecency(e) > entryRecency(existing)) {
      entries.set(e.id, e);
    }
  }

  const trash = new Map<string, MemoryTrashEntry>();
  for (const t of disk.trash ?? []) trash.set(t.entry.id, t);
  for (const t of incoming.trash ?? []) trash.set(t.entry.id, t);

  const blocked = new Map<string, BlockedRecord>();
  for (const b of disk.blocked ?? []) blocked.set(blockKey(b), b);
  for (const b of incoming.blocked ?? []) blocked.set(blockKey(b), b);

  const history = new Map<string, MemoryExtractionRecord>();
  for (const h of disk.extractionHistory ?? []) history.set(historyKey(h), h);
  for (const h of incoming.extractionHistory ?? []) history.set(historyKey(h), h);

  const retry = new Map<string, ExtractionRetryItem>();
  for (const r of disk.extractionRetryQueue ?? []) retry.set(retryKey(r), r);
  for (const r of incoming.extractionRetryQueue ?? []) retry.set(retryKey(r), r);

  return {
    ...disk,
    entries: [...entries.values()],
    trash: [...trash.values()],
    blocked: [...blocked.values()],
    extractionHistory: [...history.values()],
    extractionRetryQueue: [...retry.values()],
  };
}

function mergeArray(a: string[], b: string[]): string[] {
  const s = new Set([...a, ...b]);
  return [...s];
}
function blockKey(b: BlockedRecord): string {
  return `${b.sourceSessionId}|${b.sourceMessageId ?? ''}|${b.candidateContent}`;
}
function historyKey(h: MemoryExtractionRecord): string {
  return `${h.sessionId}|${h.strategy ?? ''}|${h.newEntryIds?.join(',') ?? ''}`;
}
function retryKey(r: ExtractionRetryItem): string {
  return `${r.sessionId}|${r.strategy ?? ''}|${r.throughMessageId ?? ''}`;
}

/** Path to the workspace-level memory store file */
export function getMemoryStorePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'memory.json');
}


/**
 * Idempotent  migration (§1.3): folds legacy five-class types into the
 * three-class schema, backfills promptVersion / lastInjectedAt / promoted.
 * Runs at most once (schemaVersion guard); repeating produces zero diff.
 */
export function migrateMemoryStore(store: MemoryStore, workspaceRootPath: string): boolean {
  if (store.schemaVersion === memoryConfig.schemaVersion) return false;

  for (const entry of [...store.entries, ...(store.trash ?? []).map(rec => rec.entry)]) {
    entry.type = foldLegacyMemoryType(entry.type);
    if (entry.promptVersion === undefined || entry.promptVersion === null) entry.promptVersion = 'legacy';
    if (entry.lastInjectedAt === undefined) entry.lastInjectedAt = null;
    if (entry.promoted === undefined) entry.promoted = false;
  }

  store.blocked ??= [];
  store.extractionRetryQueue ??= [];
  store.schemaVersion = memoryConfig.schemaVersion;
  return true;
}

/**
 * Load the memory store for a workspace.
 * Returns an empty store if the file doesn't exist. Migrates V1/V2 stores to
 *  in place (and persists immediately) when the schemaVersion is missing.
 */
export function loadMemoryStore(workspaceRootPath: string): MemoryStore {
  const filePath = getMemoryStorePath(workspaceRootPath);
  const mtime = fileMtimeMs(filePath);
  const empty: MemoryStore = {
    version: 1,
    schemaVersion: memoryConfig.schemaVersion,
    entries: [],
    trash: [],
    extractionHistory: [],
    totalInjectionTokens: 0,
    blocked: [],
    extractionRetryQueue: [],
  };
  // Baseline on the store instance: missing file → 0 (any real file is newer
  // → merge on save); existing file → its mtime.
  storeMtimes.set(empty, mtime ?? 0);
  if (!existsSync(filePath)) {
    return empty;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const store: MemoryStore = JSON.parse(raw);
    storeMtimes.set(store, mtime ?? 0);

    // Ensure backward compatibility: add missing fields
    if (!store.extractionHistory) store.extractionHistory = [];
    if (!store.trash) store.trash = [];
    if (store.totalInjectionTokens === undefined) store.totalInjectionTokens = 0;

    // one-shot idempotent migration (persist immediately so it runs once).
    if (store.schemaVersion !== memoryConfig.schemaVersion) {
      const migrated = migrateMemoryStore(store, workspaceRootPath);
      if (migrated) saveMemoryStore(workspaceRootPath, store);
    }

    // Clean up expired entries
    const now = new Date().toISOString();
    store.entries = store.entries.filter(e => !e.expiresAt || e.expiresAt > now);

    return store;
  } catch {
    // Corrupted file — return empty store
    console.warn(`[Memory] Failed to load memory store from ${filePath}, starting fresh`);
    const empty: MemoryStore = {
      version: 1,
      schemaVersion: memoryConfig.schemaVersion,
      entries: [],
      trash: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
      blocked: [],
      extractionRetryQueue: [],
    };
    storeMtimes.set(empty, mtime ?? 0);
    return empty;
  }
}

/**  retention caps applied silently at save time (LRU: keep the newest). */
function applyRetentionLimits(store: MemoryStore): void {
  const R = memoryConfig.retention;
  if (store.trash && store.trash.length > R.trash) store.trash = store.trash.slice(-R.trash);
  if (store.extractionHistory.length > R.extractionHistory) store.extractionHistory = store.extractionHistory.slice(-R.extractionHistory);
  if (store.blocked && store.blocked.length > R.blocked) store.blocked = store.blocked.slice(-R.blocked);
  if (store.extractionRetryQueue && store.extractionRetryQueue.length > R.retryQueue) store.extractionRetryQueue = store.extractionRetryQueue.slice(-R.retryQueue);
}

/**
 * Save the memory store to disk: atomic write (tmp + rename) with
 * retention GC applied first. No backup rotation — the atomic tmp+rename
 * write already guarantees a well-formed file, so memory.backup.N.json
 * rotation is dead weight.
 */
export function saveMemoryStore(
  workspaceRootPath: string,
  store: MemoryStore,
): void {
  const filePath = getMemoryStorePath(workspaceRootPath);
  const tmpPath = filePath + '.tmp';

  try {
    mkdirSync(workspaceRootPath, { recursive: true });

    // A (§2026-10-11): another process may have written this file since our
    // last load/save (installed app + dev instance share memory.json). Merge
    // rather than clobber: re-read the on-disk store and fold our changes in.
    const lastSeen = storeMtimes.get(store);
    const diskMtime = fileMtimeMs(filePath);
    if (lastSeen !== undefined && diskMtime !== null && diskMtime > lastSeen + 1) {
      try {
        const disk = loadMemoryStoreNoCache(workspaceRootPath);
        const merged = mergeWithDisk(disk, store);
        Object.assign(store, merged);
        console.warn(`[Memory] Concurrent store change detected (${filePath}); merged ${disk.entries?.length ?? 0} disk entries with ${store.entries.length} incoming.`);
      } catch {
        // If re-read fails, fall through and write our snapshot (best effort).
      }
    }

    if (store.schemaVersion !== memoryConfig.schemaVersion) store.schemaVersion = memoryConfig.schemaVersion;
    applyRetentionLimits(store);
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    // Atomic rename
    renameSync(tmpPath, filePath);
    // B: update the baseline so the next save doesn't misread our own write
    // as an external change.
    const newMtime = fileMtimeMs(filePath);
    if (newMtime !== null) storeMtimes.set(store, newMtime);
  } catch (error) {
    // Clean up tmp file on failure
    try { unlinkSync(tmpPath); } catch {}
    console.error('[Memory] Failed to save memory store:', error);
    throw error;
  }
}

/** Load from disk without touching the shared mtime baseline (merge path). */
function loadMemoryStoreNoCache(workspaceRootPath: string): MemoryStore {
  const filePath = getMemoryStorePath(workspaceRootPath);
  const raw = readFileSync(filePath, 'utf-8');
  const store: MemoryStore = JSON.parse(raw);
  if (!store.extractionHistory) store.extractionHistory = [];
  if (!store.trash) store.trash = [];
  if (store.totalInjectionTokens === undefined) store.totalInjectionTokens = 0;
  return store;
}

/**
 * Add a new memory entry. Provenance fields accepted via opts.
 */
export function addMemoryEntry(
  store: MemoryStore | SessionMemoryStore,
  content: string,
  type: MemoryType,
  sourceSessionId: string,
  confidence: number = 0.8,
  opts?: { promptVersion?: string; sourceMessageId?: string; dueAt?: string; conflictWith?: string[]; mergeWith?: string[] },
): MemoryEntry {
  const entry: MemoryEntry = {
    id: randomUUID(),
    type,
    content,
    sourceSessionId,
    confidence,
    createdAt: new Date().toISOString(),
    injectedCount: 0,
    ...(opts?.promptVersion !== undefined ? { promptVersion: opts.promptVersion } : {}),
    ...(opts?.sourceMessageId !== undefined ? { sourceMessageId: opts.sourceMessageId } : {}),
    ...(opts?.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
    ...(opts?.conflictWith !== undefined ? { conflictWith: opts.conflictWith } : {}),
    ...(opts?.mergeWith !== undefined ? { mergeWith: opts.mergeWith } : {}),
  };

  store.entries.push(entry);
  return entry;
}

/**
 * Update an existing memory entry.
 */
export function updateMemoryEntry(
  store: MemoryStore,
  id: string,
  updates: Partial<Pick<MemoryEntry, 'content' | 'type' | 'confidence'>>,
): MemoryEntry | null {
  const entry = store.entries.find(e => e.id === id);
  if (!entry) return null;

  if (updates.content !== undefined) entry.content = updates.content;
  if (updates.type !== undefined) entry.type = updates.type;
  if (updates.confidence !== undefined) entry.confidence = updates.confidence;
  entry.updatedAt = new Date().toISOString();
  // Content change invalidates the semantic vector — recompute lazily on read.
  if (updates.content !== undefined) delete entry.embedding;

  return entry;
}

/**
 * Delete a memory entry.
 */
export function deleteMemoryEntry(store: MemoryStore, id: string): boolean {
  const idx = store.entries.findIndex(e => e.id === id);
  if (idx === -1) return false;

  store.entries.splice(idx, 1);
  return true;
}

/** Move an active entry into the recoverable global-memory trash. */
export function softDeleteMemoryEntry(store: MemoryStore, id: string, reason?: string, replacedById?: string): boolean {
  const index = store.entries.findIndex(entry => entry.id === id);
  if (index < 0) return false;
  const [entry] = store.entries.splice(index, 1);
  if (!entry) return false;
  store.trash ??= [];
  store.trash.push({ entry, deletedAt: new Date().toISOString(), ...(reason ? { reason } : {}), ...(replacedById ? { replacedById } : {}) });
  return true;
}

/** Restore a trashed global-memory entry without changing its original metadata. */
export function restoreMemoryEntry(store: MemoryStore, id: string): boolean {
  store.trash ??= [];
  const index = store.trash.findIndex(record => record.entry.id === id);
  if (index < 0 || store.entries.some(entry => entry.id === id)) return false;
  const [record] = store.trash.splice(index, 1);
  if (!record) return false;
  store.entries.push(record.entry);
  return true;
}

/** Permanently remove every entry currently in the global-memory trash. */
export function clearMemoryTrash(store: MemoryStore): number {
  const count = store.trash?.length ?? 0;
  store.trash = [];
  return count;
}

/** Permanently remove the given trashed entries (irreversible). Returns how many were removed. */
export function permanentlyDeleteTrashEntries(store: MemoryStore, ids: string[]): number {
  if (!store.trash || ids.length === 0) return 0;
  const idSet = new Set(ids);
  const before = store.trash.length;
  store.trash = store.trash.filter(record => !idSet.has(record.entry.id));
  return before - store.trash.length;
}

/**
 * Query memories by search terms.
 */
export function queryMemories(
  store: MemoryStore,
  args: MemoryQueryArgs,
): MemoryQueryResult {
  const {
    query,
    type,
    limit = 10,
    minConfidence = 0.3,
  } = args;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

  let results = store.entries.filter(entry => {
    // Filter by type
    if (type && entry.type !== type) return false;

    // Filter by confidence
    if (entry.confidence < minConfidence) return false;

    // Score by query relevance (content only — tags removed with embedding track)
    const contentLower = entry.content.toLowerCase();
    const score = queryTerms.reduce((acc, term) => {
      if (contentLower.includes(term)) return acc + 1;
      return acc;
    }, 0);

    return score > 0;
  });

  // Sort by relevance score (descending), then recency
  results.sort((a, b) => {
    const scoreA = queryTerms.reduce((acc, term) => {
      const contentLower = a.content.toLowerCase();
      return acc + (contentLower.includes(term) ? 1 : 0);
    }, 0);
    const scoreB = queryTerms.reduce((acc, term) => {
      const contentLower = b.content.toLowerCase();
      return acc + (contentLower.includes(term) ? 1 : 0);
    }, 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return {
    entries: results.slice(0, limit),
    totalCount: results.length,
    query,
  };
}

/**
 * Record an extraction pass.
 */
export function recordExtraction(
  store: MemoryStore,
  record: Omit<MemoryExtractionRecord, 'timestamp'>,
): void {
  store.extractionHistory.push({
    ...record,
    timestamp: new Date().toISOString(),
  });
  store.lastExtractedAt = new Date().toISOString();

  // Keep only last 100 extraction records to prevent unbounded growth
  if (store.extractionHistory.length > 100) {
    store.extractionHistory = store.extractionHistory.slice(-100);
  }
}

/**
 * Get statistics about the memory store.
 */
export function getMemoryStats(store: MemoryStore): {
  totalEntries: number;
  entriesByType: Record<MemoryType, number>;
  totalExtractions: number;
  lastExtractionAt?: string;
  totalInjectionTokens: number;
} {
  const entriesByType: Record<MemoryType, number> = {
    factual: 0,
    behavioral: 0,
    reminder: 0,
  };

  for (const entry of store.entries) {
    entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
  }

  return {
    totalEntries: store.entries.length,
    entriesByType,
    totalExtractions: store.extractionHistory.length,
    lastExtractionAt: store.lastExtractedAt,
    totalInjectionTokens: store.totalInjectionTokens,
  };
}
