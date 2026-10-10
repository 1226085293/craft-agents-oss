import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MemoryEntry, MemoryType, SessionMemoryStore } from './types.ts'
import { normalizeTag, foldLegacyMemoryType } from './types.ts'

export function getSessionMemoryStorePath(workspaceRootPath: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID')
  const root = resolve(workspaceRootPath, 'sessions')
  const path = resolve(root, sessionId, 'memory.json')
  if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) throw new Error('Invalid session ID')
  return path
}

export function loadSessionMemoryStore(workspaceRootPath: string, sessionId: string): SessionMemoryStore {
  const filePath = getSessionMemoryStorePath(workspaceRootPath, sessionId)
  const empty: SessionMemoryStore = { version: 1, sessionId, entries: [], consolidatedEntryIds: [], extractionHistory: [] }
  if (!existsSync(filePath)) return empty
  try {
    const loaded = JSON.parse(readFileSync(filePath, 'utf8')) as SessionMemoryStore
    if (loaded.version !== 1 || loaded.sessionId !== sessionId || !Array.isArray(loaded.entries)) throw new Error('Invalid session memory store')
    const store: SessionMemoryStore = { ...empty, ...loaded, consolidatedEntryIds: loaded.consolidatedEntryIds ?? [], extractionHistory: loaded.extractionHistory ?? [] }
    // Idempotent  normalization on read: fold legacy types, normalize tags,
    // backfill provenance fields. Safe to run every load (no schema flag needed).
    for (const entry of store.entries) {
      entry.type = foldLegacyMemoryType(entry.type)
      entry.tags = entry.tags.map(normalizeTag)
      if (entry.promptVersion === undefined || entry.promptVersion === null) entry.promptVersion = 'legacy'
      if (entry.lastInjectedAt === undefined) entry.lastInjectedAt = null
      if (entry.promoted === undefined) entry.promoted = false
    }
    return store
  } catch (error) {
    console.warn(`[Memory] Failed to load session memory store from ${filePath}:`, error)
    return empty
  }
}

export function saveSessionMemoryStore(workspaceRootPath: string, store: SessionMemoryStore): void {
  const filePath = getSessionMemoryStorePath(workspaceRootPath, store.sessionId)
  const dir = join(workspaceRootPath, 'sessions', store.sessionId)
  const tmpPath = filePath + '.tmp'
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmpPath, filePath)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch {}
    throw error
  }
}

export function updateSessionMemory(store: SessionMemoryStore, id: string, updates: Partial<Pick<MemoryEntry, 'content' | 'type' | 'tags' | 'confidence'>>): MemoryEntry | null {
  const entry = store.entries.find(item => item.id === id)
  if (!entry) return null
  if (updates.content !== undefined) entry.content = updates.content
  if (updates.type !== undefined) entry.type = foldLegacyMemoryType(updates.type)
  if (updates.tags !== undefined) entry.tags = updates.tags.map(normalizeTag)
  if (updates.confidence !== undefined) entry.confidence = updates.confidence
  entry.updatedAt = new Date().toISOString()
  store.consolidatedEntryIds = (store.consolidatedEntryIds ?? []).filter(itemId => itemId !== id)
  return entry
}

export function deleteSessionMemory(store: SessionMemoryStore, id: string): boolean {
  const index = store.entries.findIndex(entry => entry.id === id)
  if (index < 0) return false
  store.entries.splice(index, 1)
  store.consolidatedEntryIds = (store.consolidatedEntryIds ?? []).filter(itemId => itemId !== id)
  return true
}

export function addSessionMemory(store: SessionMemoryStore, content: string, type: MemoryType, tags: string[] = [], confidence = 0.8): MemoryEntry {
  const entry: MemoryEntry = {
    id: randomUUID(), type: foldLegacyMemoryType(type), content: content.trim(), sourceSessionId: store.sessionId,
    tags: tags.map(normalizeTag), confidence, createdAt: new Date().toISOString(), injectedCount: 0,
  }
  store.entries.push(entry)
  return entry
}
