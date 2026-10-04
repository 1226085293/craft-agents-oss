import { describe, expect, it } from 'bun:test'
import { consolidateSessionMemories, splitConsolidationBatches, TransientLlmError } from '../consolidation'
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

  it('retries transient 429 errors and succeeds once the channel recovers', async () => {
    const global = globalStore()
    const session = sessionStore()
    let calls = 0
    const result = await consolidateSessionMemories(global, [session], async () => {
      calls++
      if (calls <= 2) throw new Error('429 rate limited: all API keys are cooling down')
      return JSON.stringify({ promotions: [{ id: 'new', content: '用户偏好简体中文回答', type: 'preference', tags: ['language'] }], conflicts: [] })
    }, { retryDelaysMs: [0, 0] })
    expect(calls).toBe(3)
    expect(result.promoted).toBe(1)
    expect(session.consolidatedEntryIds).toContain('new')
  })

  it('splits a timed-out batch in half so smaller prompts finish within the deadline', async () => {
    const global = globalStore()
    const entries: MemoryEntry[] = [
      { id: 'c0', type: 'fact', content: '用户偏好使用 TypeScript 严格模式', sourceSessionId: 's1', tags: ['ts'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'c1', type: 'fact', content: '用户常用 bun 测试框架', sourceSessionId: 's1', tags: ['bun'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 },
    ]
    const session: SessionMemoryStore = { version: 1, sessionId: 's1', entries, consolidatedEntryIds: [], extractionHistory: [] }
    const evaluate = async (prompt: string) => {
      // Only the CANDIDATES section reflects the current batch — the global
      // memories section accumulates earlier halves' promotions.
      const candidatesSection = prompt.slice(
        prompt.indexOf('Candidates: ') + 'Candidates: '.length,
        prompt.indexOf('Existing global memories:'),
      )
      const ids = [...candidatesSection.matchAll(/"id":"(c\d+)"/g)].map(match => match[1])
      if (ids.length > 1) throw new Error('queryLlm timed out after 115s')
      const source = entries.find(entry => entry.id === ids[0])!
      return JSON.stringify({ promotions: [{ id: source.id, content: source.content, type: source.type, tags: source.tags }], conflicts: [] })
    }
    const result = await consolidateSessionMemories(global, [session], evaluate, { retryDelaysMs: [0] })
    expect(result.promoted).toBe(2)
    expect(session.consolidatedEntryIds).toEqual(['c0', 'c1'])
  })

  it('retries (without splitting) when a single-entry batch times out', async () => {
    const global = globalStore()
    const entries: MemoryEntry[] = [{ id: 'c0', type: 'fact', content: '用户偏好使用 TypeScript 严格模式', sourceSessionId: 's1', tags: ['ts'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 }]
    const session: SessionMemoryStore = { version: 1, sessionId: 's1', entries, consolidatedEntryIds: [], extractionHistory: [] }
    let calls = 0
    const result = await consolidateSessionMemories(global, [session], async () => {
      calls++
      if (calls <= 1) throw new Error('queryLlm timed out after 115s')
      return JSON.stringify({ promotions: [{ id: 'c0', content: '用户偏好使用 TypeScript 严格模式', type: 'fact', tags: ['ts'] }], conflicts: [] })
    }, { retryDelaysMs: [0] })
    expect(calls).toBe(2)
    expect(result.promoted).toBe(1)
  })

  it('surfaces a TransientLlmError after exhausting retries on a persistent failure', async () => {
    const global = globalStore()
    const session = sessionStore()
    let calls = 0
    await expect(consolidateSessionMemories(global, [session], async () => {
      calls++
      throw new Error('429 rate limited')
    }, { retryDelaysMs: [0, 0], transientRetries: 3 })).rejects.toThrow(TransientLlmError)
    expect(calls).toBe(4) // initial + 3 retries
    expect(session.consolidatedEntryIds).toEqual([])
  })

  it('does not retry deterministic errors (401 auth) — fails fast', async () => {
    const global = globalStore()
    const session = sessionStore()
    let calls = 0
    await expect(consolidateSessionMemories(global, [session], async () => {
      calls++
      throw new Error('401 invalid API key')
    })).rejects.toThrow('401 invalid API key')
    expect(calls).toBe(1)
  })

  it('drops hallucinated conflict/promotion ids instead of aborting the run', async () => {
    const global = globalStore()
    const entries: MemoryEntry[] = [
      { id: 'c0', type: 'fact', content: '用户偏好使用 TypeScript 严格模式', sourceSessionId: 's1', tags: ['ts'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'c1', type: 'fact', content: '用户常用 bun 测试框架', sourceSessionId: 's1', tags: ['bun'], confidence: 1, createdAt: '2026-09-01T00:00:00.000Z', injectedCount: 0 },
    ]
    const session: SessionMemoryStore = { version: 1, sessionId: 's1', entries, consolidatedEntryIds: [], extractionHistory: [] }
    // Hallucinations: promotion of an unknown id, conflict whose oldId does
    // not exist globally, conflict whose newId was not promoted, duplicate
    // oldId, and one VALID conflict (old global 'old' superseded by c0).
    const result = await consolidateSessionMemories(global, [session], async () => JSON.stringify({
      promotions: [
        { id: 'c0', content: '用户偏好使用 TypeScript 严格模式', type: 'fact', tags: ['ts'] },
        { id: 'ghost', content: '编造的候选', type: 'fact', tags: [] },
      ],
      conflicts: [
        { oldId: 'no-such-global', newId: 'c1', reason: 'oldId 不存在' },
        { oldId: 'old', newId: 'c1', reason: 'newId 未提升' },
        { oldId: 'old', newId: 'c0', reason: '有效冲突：新偏好顶替旧偏好' },
        { oldId: 'old', newId: 'c0', reason: '重复 oldId' },
      ],
    }), { retryDelaysMs: [0] })
    expect(result.promoted).toBe(1)
    expect(result.trashed).toBe(1)
    // The valid conflict was applied; invalid ones were dropped.
    expect(global.entries.map(entry => entry.id)).not.toContain('old')
    expect(global.trash?.[0]?.entry.id).toBe('old')
    expect(session.consolidatedEntryIds).toEqual(['c0', 'c1'])
  })

  it('honors cancellation during the backoff sleep', async () => {
    const global = globalStore()
    const session = sessionStore()
    let cancelled = false
    const timer = setTimeout(() => { cancelled = true }, 100)
    const error = await consolidateSessionMemories(global, [session], async () => {
      throw new Error('429 rate limited')
    }, {
      retryDelaysMs: [2_000],
      transientRetries: 3,
      isCancelled: () => cancelled,
    }).catch(value => value)
    clearTimeout(timer)
    expect((error as Error).message).toBe('Memory consolidation cancelled')
    expect(session.consolidatedEntryIds).toEqual([])
  })
})

describe('consolidateSessionMemories — tolerant response parsing (narration/markdown)', () => {
  it('parses a response prefixed with natural-language narration (mini-model behavior)', async () => {
    const global = globalStore()
    const session = sessionStore()
    const dirty = '我们根据规则来评估候选记忆，结果如下：' +
      JSON.stringify({ promotions: [{ id: 'new', content: '用户偏好简体中文回答', type: 'preference', tags: ['language'] }], conflicts: [] })
    const result = await consolidateSessionMemories(global, [session], async () => dirty)
    expect(result.promoted).toBe(1)
    expect(global.entries.map(entry => entry.content)).toContain('用户偏好简体中文回答')
    expect(session.consolidatedEntryIds).toContain('new')
  })

  it('parses a response wrapped in a markdown code fence', async () => {
    const global = globalStore()
    const session = sessionStore()
    const fenced = '```json\n' + JSON.stringify({ promotions: [{ id: 'new', content: '用户偏好简体中文回答', type: 'preference', tags: ['language'] }], conflicts: [] }) + '\n```'
    const result = await consolidateSessionMemories(global, [session], async () => fenced)
    expect(result.promoted).toBe(1)
    expect(global.entries.map(entry => entry.content)).toContain('用户偏好简体中文回答')
  })

  it('still fails fast when the response contains no JSON object at all', async () => {
    const global = globalStore()
    const session = sessionStore()
    await expect(consolidateSessionMemories(global, [session], async () => '我们根据规则来评估，但今天不整理')).rejects.toThrow()
    expect(session.consolidatedEntryIds).toEqual([])
  })
})
