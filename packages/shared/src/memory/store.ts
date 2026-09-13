/**
 * Memory Store — Persistent cross-session memory storage.
 *
 * Reads/writes workspace-scoped memory.json for structured memory management.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MemoryEntry,
  MemoryStore,
  MemoryExtractionRecord,
  MemoryQueryArgs,
  MemoryQueryResult,
  MemoryAction,
  MemoryType,
} from './types.ts';

/** Path to the workspace-level memory store file */
export function getMemoryStorePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'memory.json');
}

/**
 * Load the memory store for a workspace.
 * Returns an empty store if the file doesn't exist.
 */
export function loadMemoryStore(workspaceRootPath: string): MemoryStore {
  const filePath = getMemoryStorePath(workspaceRootPath);
  if (!existsSync(filePath)) {
    return {
      version: 1,
      entries: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
    };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const store: MemoryStore = JSON.parse(raw);

    // Ensure backward compatibility: add missing fields
    if (!store.extractionHistory) store.extractionHistory = [];
    if (store.totalInjectionTokens === undefined) store.totalInjectionTokens = 0;

    // Clean up expired entries
    const now = new Date().toISOString();
    store.entries = store.entries.filter(e => !e.expiresAt || e.expiresAt > now);

    return store;
  } catch {
    // Corrupted file — return empty store
    console.warn(`[Memory] Failed to load memory store from ${filePath}, starting fresh`);
    return {
      version: 1,
      entries: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
    };
  }
}

/**
 * Save the memory store to disk (atomic write via tmp file).
 */
export function saveMemoryStore(
  workspaceRootPath: string,
  store: MemoryStore,
): void {
  const filePath = getMemoryStorePath(workspaceRootPath);
  const tmpPath = filePath + '.tmp';

  try {
    mkdirSync(workspaceRootPath, { recursive: true });
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
 * Add a new memory entry.
 */
export function addMemoryEntry(
  store: MemoryStore,
  content: string,
  type: MemoryType,
  sourceSessionId: string,
  tags: string[] = [],
  confidence: number = 0.8,
): MemoryEntry {
  const entry: MemoryEntry = {
    id: randomUUID(),
    type,
    content,
    sourceSessionId,
    tags,
    confidence,
    createdAt: new Date().toISOString(),
    injectedCount: 0,
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
  updates: Partial<Pick<MemoryEntry, 'content' | 'tags' | 'confidence'>>,
): MemoryEntry | null {
  const entry = store.entries.find(e => e.id === id);
  if (!entry) return null;

  if (updates.content !== undefined) entry.content = updates.content;
  if (updates.tags !== undefined) entry.tags = updates.tags;
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
  const requestedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()) : [];

  let results = store.entries.filter(entry => {
    // Filter by type
    if (type && entry.type !== type) return false;

    // Filter by confidence
    if (entry.confidence < minConfidence) return false;

    // Filter by tags (if specified)
    if (requestedTags.length > 0) {
      const entryTags = entry.tags.map(t => t.toLowerCase());
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
 * Mark a memory as injected into a session.
 */
export function markMemoryInjected(store: MemoryStore, id: string): void {
  const entry = store.entries.find(e => e.id === id);
  if (entry) {
    entry.injectedCount += 1;
  }
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
 * Apply a memory action (add/update/delete).
 */
export function applyMemoryAction(
  store: MemoryStore,
  action: MemoryAction,
): { success: boolean; entryId?: string } {
  switch (action.type) {
    case 'add': {
      const entry = addMemoryEntry(
        store,
        action.content,
        action.typeLabel,
        'manual', // Manual additions come from the user, not a session
        action.tags || [],
        action.confidence ?? 1.0,
      );
      return { success: true, entryId: entry.id };
    }

    case 'update': {
      const entry = updateMemoryEntry(store, action.id, {
        content: action.content,
        tags: action.tags,
        confidence: action.confidence,
      });
      return { success: !!entry, entryId: action.id };
    }

    case 'delete': {
      const success = deleteMemoryEntry(store, action.id);
      return { success, entryId: action.id };
    }

    case 'inject': {
      markMemoryInjected(store, action.id);
      return { success: true, entryId: action.id };
    }
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
    fact: 0,
    preference: 0,
    workflow: 0,
    reminder: 0,
    context: 0,
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
