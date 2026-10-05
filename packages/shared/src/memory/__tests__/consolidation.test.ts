import { describe, expect, it } from 'bun:test'
import { consolidateSessionMemories, splitConsolidationBatches } from '../consolidation'
import type { MemoryStore, MemoryEntry, SessionMemoryStore } from '../types'

function globalStore(): MemoryStore {
  return { version: 1, entries: [{ id: 'old', type: 'preference', content: '用户偏好英文回答', sourceSessionId: 's0', tags: ['language'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 }], trash: [], extractionHistory: [], totalInjectionTokens: 0 }
}
function sessionStore(): SessionMemoryStore {
  return { version: 1, sessionId: 's1', entries: [{ id: 'new', type: 'preference', content: '用户偏好简体中文回答', sourceSessionId: 's1', tags: ['language'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 }], consolidatedEntryIds: [], extractionHistory: [] }
}

describe('consolidateSessionMemories', () => {
  it('promotes model-selected candidates and moves confirmed conflicts to recoverable trash', async () => {
    const global = globalStore()
    const session = sessionStore()
    const result = await consolidateSessionMemories(global, [session], async () => JSON.stringify({ promotions: [{ id: 'new', content: '用户偏好简体中文回答', type: 'preference', tags: ['language'] }], conflicts: [{ oldId: 'old', newId: 'new', reason: '用户明确更改了回答语言偏好' }] }))
    expect(result.promoted).toBe(1)
    expect(global.entries.map(entry => entry.content)).toContain('用户偏好简体中文回答')
    expect(global.entries.map(entry => entry.id)).not.toContain('old')
    expect(global.trash?.[0]?.entry.id).toBe('old')
    expect(session.consolidatedEntryIds).toContain('new')
  })

  it('does not advance the session cursor when model output is invalid', async () => {
    const global = globalStore()
    const session = sessionStore()
    await expect(consolidateSessionMemories(global, [session], async () => 'not json')).rejects.toThrow()
    expect(session.consolidatedEntryIds).toEqual([])
    expect(global.entries).toHaveLength(1)
  })

  it('splits a large candidate set into multiple prompt-sized batches', () => {
    const entries: MemoryEntry[] = Array.from({ length: 200 }, (_, index) => ({
      id: `c${index}`,
      type: 'fact',
      content: `memory entry ${index} with some reasonably long content payload for batching`, // ~70 chars each
      sourceSessionId: 's1',
      tags: ['batch'],
      confidence: 0.9,
      createdAt: '2026-09-01T00:00:00.000Z',
      injectedCount: 0,
    }))
    const batches = splitConsolidationBatches(entries)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toHaveLength(entries.length)
    for (const batch of batches) expect(batch.length).toBeGreaterThan(0)
  })

  it('processes every batch before marking the session consolidated', async () => {
    const global = globalStore()
    const entries: MemoryEntry[] = Array.from({ length: 200 }, (_, index) => ({
      id: `c${index}`,
      type: 'fact',
      content: `memory entry ${index} with some reasonably long content payload for batching`,
      sourceSessionId: 's1',
      tags: ['batch'],
      confidence: 0.9,
      createdAt: '2026-09-01T00:00:00.000Z',
      injectedCount: 0,
    }))
    const session: SessionMemoryStore = { version: 1, sessionId: 's1', entries, consolidatedEntryIds: [], extractionHistory: [] }
    let evaluateCalls = 0
    let completed: { session: SessionMemoryStore; result: { promoted: number; trashed: number } } | null = null
    await consolidateSessionMemories(global, [session], async (prompt) => {
      evaluateCalls++
      // Promote only the first candidate of each batch (content unique per
      // call so cross-batch semantic dedup does not swallow later ones).
      const match = prompt.match(/"id":"(c\d+)"/)
      return JSON.stringify({ promotions: [{ id: match?.[1] ?? 'c0', content: `promoted${evaluateCalls}`, type: 'fact', tags: ['batch'] }], conflicts: [] })
    }, {
      onSessionConsolidated: (processed, result) => { completed = { session: processed, result } },
    })
    expect(evaluateCalls).toBeGreaterThan(1)
    expect(completed).not.toBeNull()
    // Marker covers every candidate only after ALL batches succeeded.
    expect(completed!.session.consolidatedEntryIds).toHaveLength(entries.length)
    expect(completed!.result.promoted).toBe(evaluateCalls)
  })

  it('does not report a session as consolidated when a later batch fails', async () => {
    const global = globalStore()
    const entries: MemoryEntry[] = Array.from({ length: 200 }, (_, index) => ({
      id: `c${index}`,
      type: 'fact',
      content: `memory entry ${index} with some reasonably long content payload for batching`,
      sourceSessionId: 's1',
      tags: ['batch'],
      confidence: 0.9,
      createdAt: '2026-09-01T00:00:00.000Z',
      injectedCount: 0,
    }))
    const session: SessionMemoryStore = { version: 1, sessionId: 's1', entries, consolidatedEntryIds: [], extractionHistory: [] }
    let calls = 0
    let completed = false
    await expect(consolidateSessionMemories(global, [session], async () => {
      calls++
      if (calls === 3) return 'not json'
      return JSON.stringify({ promotions: [], conflicts: [] })
    }, {
      onSessionConsolidated: () => { completed = true },
    })).rejects.toThrow()
    expect(completed).toBe(false)
    // Marker must NOT be advanced — the session only gets marked after full success.
    expect(session.consolidatedEntryIds).toEqual([])
  })
})
