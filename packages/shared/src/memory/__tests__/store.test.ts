import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addMemoryEntry,
  clearMemoryTrash,
  loadMemoryStore,
  restoreMemoryEntry,
  saveMemoryStore,
  softDeleteMemoryEntry,
} from '../store'

const roots: string[] = []
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'craft-memory-store-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('global memory trash', () => {
  it('loads legacy stores without trash and initializes an empty trash', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'memory.json'), JSON.stringify({
      version: 1,
      entries: [],
      extractionHistory: [],
      totalInjectionTokens: 0,
    }))

    expect(loadMemoryStore(root).trash).toEqual([])
  })

  it('soft-deletes to trash, restores the original entry, and clears trash permanently', () => {
    const root = makeRoot()
    const store = loadMemoryStore(root)
    const entry = addMemoryEntry(store, '用户偏好简体中文', 'behavioral', 'manual')

    expect(softDeleteMemoryEntry(store, entry.id, 'replaced by newer preference')).toBe(true)
    expect(store.entries).toHaveLength(0)
    expect(store.trash ?? []).toHaveLength(1)
    expect(store.trash?.[0]?.entry).toEqual(entry)

    expect(restoreMemoryEntry(store, entry.id)).toBe(true)
    expect(store.entries[0]).toEqual(entry)
    expect(store.trash).toHaveLength(0)

    softDeleteMemoryEntry(store, entry.id)
    expect(clearMemoryTrash(store)).toBe(1)
    expect(store.trash).toHaveLength(0)

    saveMemoryStore(root, store)
    expect(loadMemoryStore(root).trash).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'memory.json'), 'utf8')).trash).toEqual([])
  })
})

describe('concurrent write protection (A+B)', () => {
  it('merges an externally-written entry instead of clobbering it', () => {
    const root = makeRoot()
    // Process A: load, add an entry, keep the in-memory store without saving.
    const storeA = loadMemoryStore(root)
    addMemoryEntry(storeA, '进程A的记忆', 'factual', 'manual')

    // Process B simulates another instance: writes its own store to disk.
    const storeB = loadMemoryStore(root)
    addMemoryEntry(storeB, '进程B的记忆', 'factual', 'manual')
    saveMemoryStore(root, storeB)

    // Process A flushes now — the file changed since its load; both entries
    // must survive (A's own + B's), not just A's.
    saveMemoryStore(root, storeA)
    const after = loadMemoryStore(root)
    const contents = after.entries.map(e => e.content)
    expect(contents).toContain('进程A的记忆')
    expect(contents).toContain('进程B的记忆')
  })

  it('does not merge when the file is unchanged (normal path)', () => {
    const root = makeRoot()
    const store = loadMemoryStore(root)
    addMemoryEntry(store, '普通写入', 'factual', 'manual')
    saveMemoryStore(root, store)
    const after = loadMemoryStore(root)
    expect(after.entries.map(e => e.content)).toEqual(['普通写入'])
  })
})
