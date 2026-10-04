import { describe, expect, it } from 'bun:test'
import { consolidateSessionMemories } from '../consolidation'
import type { MemoryStore, SessionMemoryStore } from '../types'

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
})
