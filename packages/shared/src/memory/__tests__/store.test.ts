import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('schemaVersion 3→4 一次性迁移（v7 阶段 9 托管记忆，用户拍板口径）', () => {
  it('会话池 entries 清空（抽取标记保留防回填），陈旧重试队列清空，全局存量保留；幂等', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sessions', 's-1'), { recursive: true })
    writeFileSync(
      join(root, 'sessions', 's-1', 'memory.json'),
      JSON.stringify({
        version: 1,
        sessionId: 's-1',
        entries: [{ id: 'se1', type: 'factual', content: '旧会话记忆', sourceSessionId: 's-1', confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 }],
        consolidatedEntryIds: [],
        extractionHistory: [{ sessionId: 's-1', timestamp: '2026-01-01T00:00:00.000Z', factsExtracted: 1, factsDiscarded: 0, newEntryIds: ['se1'] }],
      }),
    )
    writeFileSync(
      join(root, 'memory.json'),
      JSON.stringify({
        version: 1,
        schemaVersion: 3,
        entries: [{ id: 'g1', type: 'factual', content: '全局存量记忆', sourceSessionId: 's0', confidence: 1, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 }],
        trash: [],
        extractionHistory: [],
        totalInjectionTokens: 0,
        blocked: [],
        extractionRetryQueue: [{ sessionId: 'old-1', strategy: 'session_end', throughMessageId: 'm1', reason: '429', attempts: 1, failedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    )

    const store = loadMemoryStore(root)
    expect(store.schemaVersion).toBe(4)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.content).toBe('全局存量记忆')
    expect(store.entries[0]!.domain).toBeUndefined() // 缺域标 = global = 全局记忆存量
    expect(store.extractionRetryQueue ?? []).toHaveLength(0)

    const sessionRaw = JSON.parse(readFileSync(join(root, 'sessions', 's-1', 'memory.json'), 'utf8')) as {
      entries: unknown[]
      extractionHistory: unknown[]
    }
    expect(sessionRaw.entries).toEqual([])
    expect(sessionRaw.extractionHistory).toHaveLength(1) // 标记保留：防重新抽取回填

    // 幂等：第二次 load 不再迁移（会话池标记不动）
    loadMemoryStore(root)
    const sessionRaw2 = JSON.parse(readFileSync(join(root, 'sessions', 's-1', 'memory.json'), 'utf8')) as { extractionHistory: unknown[] }
    expect(sessionRaw2.extractionHistory).toHaveLength(1)
  })

  it('已是 schemaVersion 4 的 store 不触发迁移（会话池原样）', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sessions', 's-1'), { recursive: true })
    writeFileSync(
      join(root, 'sessions', 's-1', 'memory.json'),
      JSON.stringify({
        version: 1, sessionId: 's-1',
        entries: [{ id: 'se1', type: 'factual', content: '新管线会话记忆', sourceSessionId: 's-1', confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 }],
        extractionHistory: [],
      }),
    )
    writeFileSync(
      join(root, 'memory.json'),
      JSON.stringify({ version: 1, schemaVersion: 4, entries: [], trash: [], extractionHistory: [], totalInjectionTokens: 0 }),
    )
    loadMemoryStore(root)
    const sessionRaw = JSON.parse(readFileSync(join(root, 'sessions', 's-1', 'memory.json'), 'utf8')) as { entries: unknown[] }
    expect(sessionRaw.entries).toHaveLength(1) // 新管线的会话池条目不受迁移影响
  })
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

describe('concurrent write protection v2 — disk as truth', () => {
  it('keeps a hand-edited entry (disk) over a stale in-memory snapshot with equal updatedAt', () => {
    const root = makeRoot()
    // Baseline store with an entry both sides will have (stale snapshot version).
    const baseline = loadMemoryStore(root)
    addMemoryEntry(baseline, '(2026-10-12) 旧内容', 'factual', 'manual')
    saveMemoryStore(root, baseline)

    // A "stale" in-memory snapshot (what a long-lived process holds).
    const stale = loadMemoryStore(root)
    // Then the user hand-edits the file on disk (same updatedAt — hand edits
    // do not bump updatedAt), e.g. removes a date prefix.
    const disk = loadMemoryStore(root)
    disk.entries[0]!.content = '新内容(手改)'
    saveMemoryStore(root, disk)

    // The stale snapshot flushes; the hand-edit must survive.
    saveMemoryStore(root, stale)
    const after = loadMemoryStore(root)
    expect(after.entries[0]!.content).toContain('新内容(手改)')
    expect(after.entries[0]!.content).not.toContain('(2026-10-12)')
  })

  it('lets a real in-process update (newer updatedAt) win over the disk copy', () => {
    const root = makeRoot()
    const base = loadMemoryStore(root)
    addMemoryEntry(base, 'original', 'factual', 'manual')
    saveMemoryStore(root, base)

    // Process holds a snapshot, user edits on disk (older timestamp semantics
    // preserved), then the process performs a REAL update bumping updatedAt.
    const process = loadMemoryStore(root)
    const id = process.entries[0]!.id
    const disk = loadMemoryStore(root)
    disk.entries[0]!.content = '手改内容'
    saveMemoryStore(root, disk)

    const entry = process.entries.find(e => e.id === id)!
    entry.content = '进程真实更新'
    entry.updatedAt = new Date(Date.now() + 60_000).toISOString() // newer than hand-edit
    saveMemoryStore(root, process)

    const after = loadMemoryStore(root)
    expect(after.entries[0]!.content).toBe('进程真实更新')
  })
})
