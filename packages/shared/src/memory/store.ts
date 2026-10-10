/**
 * Memory Store — Persistent cross-session memory storage.
 *
 * Reads/writes workspace-scoped memory.json for structured memory management.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
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
} from './types.ts';
import { normalizeTag, foldLegacyMemoryType, memoryConfig } from './types.ts';

/** Path to the workspace-level memory store file */
export function getMemoryStorePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'memory.json');
}

/** Tag-frequency collector used by the  vocabulary bootstrap. */
function countTags(tagCounts: Map<string, number>, tags: string[]): void {
  for (const tag of tags) {
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
}

/**
 * Idempotent  migration (§1.3): folds legacy five-class types into the
 * three-class schema, normalizes tags, backfills promptVersion / lastInjectedAt
 * / promoted, bootstraps tagVocabulary (global + session stores) and
 * priorityTags. Runs at most once (schemaVersion guard); repeating produces
 * zero diff.
 */
export function migrateMemoryStore(store: MemoryStore, workspaceRootPath: string): boolean {
  if (store.schemaVersion === memoryConfig.schemaVersion) return false;

  for (const entry of [...store.entries, ...(store.trash ?? []).map(rec => rec.entry)]) {
    entry.type = foldLegacyMemoryType(entry.type);
    entry.tags = entry.tags.map(normalizeTag);
    if (entry.promptVersion === undefined || entry.promptVersion === null) entry.promptVersion = 'legacy';
    if (entry.lastInjectedAt === undefined) entry.lastInjectedAt = null;
    if (entry.promoted === undefined) entry.promoted = false;
  }

  // Vocabulary bootstrap: aggregate global + all session stores, frequency-sorted.
  const tagCounts = new Map<string, number>();
  countTags(tagCounts, store.entries.flatMap(e => e.tags));
  try {
    const sessionsDir = join(workspaceRootPath, 'sessions');
    if (existsSync(sessionsDir)) {
      for (const sessionDir of readdirSync(sessionsDir)) {
        const sessionPath = join(sessionsDir, sessionDir, 'memory.json');
        if (!existsSync(sessionPath)) continue;
        try {
          const sessionStore = JSON.parse(readFileSync(sessionPath, 'utf-8'));
          countTags(tagCounts, (sessionStore.entries ?? []).flatMap((e: { tags: string[] }) => e.tags ?? []));
        } catch {
          // Skip unreadable session store — migration must never hard-fail.
        }
      }
    }
  } catch {
    // No sessions dir — vocabulary comes from global entries alone.
  }

  store.tagVocabulary = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
  // priorityTags bootstrap: no hard-coded seed in source (config priorityTags is []) → top-5 by frequency.
  store.priorityTags = store.tagVocabulary.slice(0, 5);
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
  if (!existsSync(filePath)) {
    return {
      version: 1,
      schemaVersion: memoryConfig.schemaVersion,
      entries: [],
      trash: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
      tagVocabulary: [],
      priorityTags: [],
      blocked: [],
      extractionRetryQueue: [],
      tagFrequency: {},
    };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const store: MemoryStore = JSON.parse(raw);

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
    return {
      version: 1,
      schemaVersion: memoryConfig.schemaVersion,
      entries: [],
      trash: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
      tagVocabulary: [],
      priorityTags: [],
      blocked: [],
      extractionRetryQueue: [],
      tagFrequency: {},
    };
  }
}

/** Scroll the current store file into memory.backup.{N}.json (keep retention.snapshots). */
function rotateBackup(filePath: string): void {
  if (!existsSync(filePath)) return;
  const dir = dirname(filePath);
  const base = basename(filePath, '.json');
  const max = memoryConfig.retention.snapshots;
  const oldest = join(dir, `${base}.backup.${max - 1}.json`);
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch {}
  }
  for (let i = max - 2; i >= 0; i--) {
    const from = join(dir, `${base}.backup.${i}.json`);
    const to = join(dir, `${base}.backup.${i + 1}.json`);
    if (existsSync(from)) {
      try { renameSync(from, to); } catch {}
    }
  }
  try { renameSync(filePath, join(dir, `${base}.backup.0.json`)); } catch {}
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
 * Save the memory store to disk: atomic write (tmp + rename) with snapshot
 * rotation (memory.backup.N.json) and  retention GC applied first.
 */
export function saveMemoryStore(
  workspaceRootPath: string,
  store: MemoryStore,
): void {
  const filePath = getMemoryStorePath(workspaceRootPath);
  const tmpPath = filePath + '.tmp';

  try {
    mkdirSync(workspaceRootPath, { recursive: true });
    if (store.schemaVersion !== memoryConfig.schemaVersion) store.schemaVersion = memoryConfig.schemaVersion;
    applyRetentionLimits(store);
    rotateBackup(filePath);
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    // Atomic rename
    renameSync(tmpPath, filePath);
  } catch (error) {
    // Clean up tmp file on failure
    try { unlinkSync(tmpPath); } catch {}
    console.error('[Memory] Failed to save memory store:', error);
    throw error;
  }
}

/**
 * Add a new memory entry. Tags are normalized (trim/lowercase/plural-fold)
 * before storage;  provenance fields accepted via opts.
 */
export function addMemoryEntry(
  store: MemoryStore | SessionMemoryStore,
  content: string,
  type: MemoryType,
  sourceSessionId: string,
  tags: string[] = [],
  confidence: number = 0.8,
  opts?: { promptVersion?: string; sourceMessageId?: string; dueAt?: string; conflictWith?: string[]; mergeWith?: string[] },
): MemoryEntry {
  const entry: MemoryEntry = {
    id: randomUUID(),
    type,
    content,
    sourceSessionId,
    tags: tags.map(normalizeTag),
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
  updates: Partial<Pick<MemoryEntry, 'content' | 'type' | 'tags' | 'confidence'>>,
): MemoryEntry | null {
  const entry = store.entries.find(e => e.id === id);
  if (!entry) return null;

  if (updates.content !== undefined) entry.content = updates.content;
  if (updates.type !== undefined) entry.type = updates.type;
  if (updates.tags !== undefined) entry.tags = updates.tags.map(normalizeTag);
  if (updates.confidence !== undefined) entry.confidence = updates.confidence;
  entry.updatedAt = new Date().toISOString();

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
    tags,
    limit = 10,
    minConfidence = 0.3,
  } = args;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
  const requestedTags = tags ? tags.split(',').map(t => normalizeTag(t)) : [];

  let results = store.entries.filter(entry => {
    // Filter by type
    if (type && entry.type !== type) return false;

    // Filter by confidence
    if (entry.confidence < minConfidence) return false;

    // Filter by tags (if specified)
    if (requestedTags.length > 0) {
      const entryTags = entry.tags.map(normalizeTag);
      if (!requestedTags.some(rt => entryTags.includes(rt))) return false;
    }

    // Score by query relevance
    const contentLower = entry.content.toLowerCase();
    const tagLower = entry.tags.join(' ').toLowerCase();
    const searchable = `${contentLower} ${tagLower}`;

    const score = queryTerms.reduce((acc, term) => {
      if (searchable.includes(term)) return acc + 1;
      return acc;
    }, 0);

    return score > 0;
  });

  // Sort by relevance score (descending), then recency
  results.sort((a, b) => {
    const scoreA = queryTerms.reduce((acc, term) => {
      const contentLower = a.content.toLowerCase();
      const tagLower = a.tags.join(' ').toLowerCase();
      return acc + ((contentLower + ' ' + tagLower).includes(term) ? 1 : 0);
    }, 0);
    const scoreB = queryTerms.reduce((acc, term) => {
      const contentLower = b.content.toLowerCase();
      const tagLower = b.tags.join(' ').toLowerCase();
      return acc + ((contentLower + ' ' + tagLower).includes(term) ? 1 : 0);
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
