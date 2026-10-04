import { describe, expect, it } from 'bun:test'
import {
  buildMemoryContext,
  extractContextKeywords,
  selectRelevantMemoriesFromScopes,
  extractWeightedKeywords,
  selectRelevantMemories,
  type WeightedKeyword,
} from '../injector'
import type { MemoryEntry, MemoryStore } from '../types'
import { DEFAULT_MEMORY_INJECTION_CONFIG, isBehavioralMemoryType } from '../types'

// ============================================================
// Fixtures
// ============================================================

let idCounter = 0
function makeEntry(partial: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  idCounter += 1
  return {
    id: `mem-${idCounter}`,
    type: 'fact',
    tags: [],
    confidence: 0.9,
    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    injectedCount: 0,
    sourceSessionId: 'test-session',
    ...partial,
  }
}

function makeStore(entries: MemoryEntry[]): MemoryStore {
  return { version: 1, entries, extractionHistory: [], totalInjectionTokens: 0 }
}

const noConfig = DEFAULT_MEMORY_INJECTION_CONFIG

// ============================================================
// extractWeightedKeywords — multilingual + authority weights
// ============================================================

describe('extractWeightedKeywords', () => {
  it('extracts both English and Chinese tokens from mixed text', () => {
    const kws = extractWeightedKeywords([{ role: 'user', content: '更新craft按照仓库docs文档进行' }], 30)
    const terms = kws.map(k => k.term)
    expect(terms).toContain('craft')
    expect(terms).toContain('docs')
    expect(terms).toContain('更新')
    expect(terms).toContain('按照')
  })

  it('gives user-message keywords higher weight than assistant/tool', () => {
    const kws = extractWeightedKeywords([
      { role: 'assistant', content: 'Running setup with markdown shadow strong minimal eslint vite build'.repeat(3) },
      { role: 'tool', content: 'Running Bash' },
      { role: 'user', content: '更新craft发布' },
    ], 30)
    const user = kws.find(k => k.term === '发布')
    const assistant = kws.find(k => k.term === 'markdown')
    expect(user).toBeDefined()
    expect(assistant).toBeDefined()
    expect(user!.weight).toBeGreaterThan(assistant!.weight)
  })

  it('truncation keeps the highest-weight (user) terms, not the assistant noise', () => {
    const kws = extractWeightedKeywords([
      { role: 'assistant', content: 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss ttt' },
      { role: 'tool', content: 'Running Bash' },
      { role: 'user', content: '发版更新craft' },
    ], 15)
    const terms = kws.map(k => k.term)
    expect(terms).toContain('发版')
    expect(terms).toContain('更新')
    expect(terms).toContain('craft')
  })

  it('extractContextKeywords keeps string[] compatibility', () => {
    const terms = extractContextKeywords([{ role: 'user', content: '更新craft完成' }], 15)
    expect(Array.isArray(terms)).toBe(true)
    expect(terms.every(t => typeof t === 'string')).toBe(true)
  })
})

// ============================================================
// selectRelevantMemories — behavioral quota + relevance gating
// ============================================================

describe('selectRelevantMemoriesFromScopes', () => {
  it('retrieves relevant entries from the global and only the current session store', () => {
    const globalEntry = makeEntry({ content: 'Craft deployment uses Bun runtime', sourceSessionId: 'global' })
    const current = makeEntry({ content: 'Craft deployment target is Windows', sourceSessionId: 'session-a' })
    const otherSession = makeEntry({ content: 'Craft deployment target is Linux', sourceSessionId: 'session-b' })
    const globalStore = makeStore([globalEntry])
    const sessionStore = { version: 1 as const, sessionId: 'session-a', entries: [current, otherSession], extractionHistory: [] }

    const selected = selectRelevantMemoriesFromScopes(globalStore, sessionStore, [
      { role: 'user', content: 'Craft deployment target Windows' },
    ])

    expect(selected.map(entry => entry.content)).toContain(globalEntry.content)
    expect(selected.map(entry => entry.content)).toContain(current.content)
    expect(selected.map(entry => entry.content)).not.toContain(otherSession.content)
  })
})

describe('selectRelevantMemories', () => {
  it('injects a topically-matching workflow even when many knowledge memories share a generic tag', () => {
    // Generic label `craft-agent` shared by a flood of unrelated knowledge.
    const knowledgeNoise = Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        type: i % 2 === 0 ? 'fact' : 'context',
        tags: ['craft-agent', `noise-${i}`],
        content: `Craft Agent background detail number ${i}: credentials backup storage file paths keys loss handling process across sessions.`,
        confidence: 0.95,
        createdAt: new Date().toISOString(),
      }))
    const workflow = makeEntry({
      id: 'target-workflow',
      type: 'workflow',
      tags: [],
      confidence: 1,
      content: '用户要求完成工作后自己更新craft按照仓库docs里的文档流程进行',
      createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
    })
    const store = makeStore([...knowledgeNoise, workflow])

    const msgs = [
      { role: 'assistant', content: '构建完成，vite 编译通过，正在检查界面细节问题列表' },
      { role: 'user', content: '工作完成后你自己更新craft' },
    ] as const

    const selected = selectRelevantMemories(store, [...msgs] as any, noConfig)
    expect(selected.some(m => m.id === 'target-workflow')).toBe(true)
    // The workflow should come first within the behavioral tier
    const workflowIdx = selected.findIndex(m => m.id === 'target-workflow')
    expect(workflowIdx).toBeGreaterThanOrEqual(0)
    expect(workflowIdx).toBeLessThan(noConfig.behavioralQuota)
  })

  it('behavioral quota guarantees seats for user-intent memories even when knowledge scores higher', () => {
    const hotKnowledge = makeEntry({ type: 'context', content: 'active link from government official', createdAt: new Date().toISOString() })
    const midWorkflow = makeEntry({
      type: 'workflow',
      content: '发布前按照仓库docs下的文档流程更新craft',
      createdAt: new Date().toISOString(),
    })
    const store = makeStore([hotKnowledge, midWorkflow])
    const msgs = [{ role: 'user', content: '更新完发布' }] as const
    const selected = selectRelevantMemories(store, [...msgs] as any, {
      ...noConfig,
      maxMemories: 2,
      minRelevanceScore: 0, // let knowledge in easily
    })
    // Both entries make it, but the workflow is not dropped in the process
    expect(selected.some(m => m.type === 'workflow')).toBe(true)
  })

  it('returns nothing when no memory matches the conversation (recall gate works)', () => {
    const store = makeStore([
      makeEntry({ content: '用户桌面壁纸是蓝色渐变风格', tags: ['desktop', 'wallpaper'] }),
    ])
    const msgs = [{ role: 'user', content: '量子力学波函数坍塌概率计算问题' }] as const
    const selected = selectRelevantMemories(store, [...msgs] as any, noConfig)
    expect(selected).toHaveLength(0)
  })

  it('filters out expired and excluded-tag memories', () => {
    const expired = makeEntry({
      content: '旧的过期提醒：每周一早上9点同步进度',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const excluded = makeEntry({ content: '实验性功能：自动收集浏览历史', tags: ['experimental'] })
    const ok = makeEntry({ content: 'git 提交前不要自动推送，等待用户确认', tags: ['git'] })
    const store = makeStore([expired, excluded, ok])
    const msgs = [{ role: 'user', content: 'git提交后不要推送' }] as const
    const selected = selectRelevantMemories(store, [...msgs] as any, noConfig)
    expect(selected.map(m => m.id)).not.toContain(expired.id)
    expect(selected.map(m => m.id)).not.toContain(excluded.id)
    expect(selected.some(m => m.id === ok.id)).toBe(true)
  })

  it('does not re-inject memories beyond token budget', () => {
    const bigMem = makeEntry({ content: '很长内容的记忆噪音'.repeat(200), tags: ['noise'] })
    const tinyMem = makeEntry({ content: '关键工作流：完成后自己发版', tags: [] })
    const store = makeStore([bigMem, tinyMem])
    const cfg = { ...noConfig, maxTokens: 300 }
    const msgs = [{ role: 'user', content: '发版' }] as const
    const selected = selectRelevantMemories(store, [...msgs] as any, cfg)
    expect(selected.some(m => m.id === tinyMem.id)).toBe(true)
    // big content should be skipped under the token budget
    expect(selected.some(m => m.id === bigMem.id)).toBe(false)
  })

  it('isBehavioralMemoryType groups workflow/preference/reminder together', () => {
    expect(isBehavioralMemoryType('workflow')).toBe(true)
    expect(isBehavioralMemoryType('preference')).toBe(true)
    expect(isBehavioralMemoryType('reminder')).toBe(true)
    expect(isBehavioralMemoryType('fact')).toBe(false)
    expect(isBehavioralMemoryType('context')).toBe(false)
  })
})

// ============================================================
// buildMemoryContext — grouping display unchanged
// ============================================================

describe('buildMemoryContext', () => {
  it('groups injected memories by type with heading labels', async () => {
    const { buildMemoryContext } = await import('../injector')
    const ctx = buildMemoryContext([
      makeEntry({ type: 'workflow', content: '更新流程A' }),
      makeEntry({ type: 'fact', content: '事实B' }),
    ])
    expect(ctx).toContain('Workflows')
    expect(ctx).toContain('Facts')
    expect(ctx).toContain('更新流程A')
    expect(ctx).toContain('事实B')
    expect(ctx).toContain('<cross_session_memory>')
    expect(ctx).toContain('</cross_session_memory>')
  })
})