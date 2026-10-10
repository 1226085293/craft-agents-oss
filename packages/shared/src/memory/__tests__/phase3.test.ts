/**
 *  Phase-3 tests: injection — recency × confidence, cold derivation,
 * dual-pool dedup + promoted skip, contradiction suppression, reminder
 * forced channel, expansion cache, injection frame.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore, SessionMemoryStore } from '../types.ts';
import {
  recencyMultiplier,
  isColdMemory,
  getCachedExpansionVariants,
  scheduleKeywordExpansion,
  selectRelevantMemoriesFromScopes,
  buildMemoryContext,
} from '../injector.ts';
import { memoryConfig } from '../types.ts';

function entry(id: string, content: string, tags: string[] = [], type: MemoryEntry['type'] = 'factual', createdDaysAgo = 400): MemoryEntry {
  return {
    id, type, content, sourceSessionId: 's0', tags, confidence: 0.9,
    createdAt: new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000).toISOString(),
    injectedCount: 0, lastInjectedAt: null, promoted: false,
  };
}

function globalStore(entries: MemoryEntry[] = []): MemoryStore {
  return {
    version: 1, schemaVersion: 3, entries, trash: [], extractionHistory: [], totalInjectionTokens: 0,
    blocked: [], tagVocabulary: ['pnpm'], priorityTags: [], extractionRetryQueue: [], tagFrequency: {}, dedupBlockedCount: 0,
  };
}

function sessionStore(sessionId: string, entries: MemoryEntry[] = []): SessionMemoryStore {
  return { version: 1, sessionId, entries, consolidatedEntryIds: [], extractionHistory: [] };
}

const recent = [{ role: 'user' as const, content: '帮我看看 pnpm 依赖装不上了' }];

describe('recency multiplier & cold (§5.3)', () => {
  it('maps activity age to the documented buckets', () => {
    const now = Date.now();
    const iso = (days: number) => new Date(now - days * 86400000).toISOString();
    expect(recencyMultiplier(iso(1), iso(400))).toBe(1.0); // <2d anti self-reinforcement
    expect(recencyMultiplier(iso(5), iso(400))).toBe(1.5);
    expect(recencyMultiplier(iso(15), iso(400))).toBe(1.2);
    expect(recencyMultiplier(iso(60), iso(400))).toBe(1.0);
    expect(recencyMultiplier(iso(120), iso(400))).toBe(0.6);
    expect(recencyMultiplier(iso(200), iso(400))).toBe(0.4);
  });

  it('derives cold from lastActive (>coldDays) without eviction', () => {
    const cold = entry('c1', 'rare high-value fact', ['rare'], 'factual', 400);
    expect(isColdMemory(cold.lastInjectedAt, cold.createdAt)).toBe(true);
    expect(memoryConfig.decay.coldDays).toBe(180);
  });
});

describe('dual pool (§5.3.1)', () => {
  it('skips promoted session entries — the global copy is the only one injected', () => {
    const g = globalStore([entry('g1', 'global pnpm preference fact', ['pnpm'], 'behavioral', 10)]);
    const s = sessionStore('sess', [
      { ...entry('g1', 'global pnpm preference fact', ['pnpm'], 'behavioral', 10), promoted: true, sourceSessionId: 'sess' },
      entry('s1', 'session-only detail', ['local'], 'factual', 1),
    ]);
    const selected = selectRelevantMemoriesFromScopes(g, s, recent);
    const ids = selected.map(e => e.id);
    expect(ids.filter(id => id === 'g1')).toHaveLength(1);
    expect(selected.some(e => e.id === 'g1' && e.sourceSessionId === 'sess')).toBe(false);
  });

  it('suppresses global ids referenced by session conflictWith/mergeWith', () => {
    const g = globalStore([entry('g1', 'yarn is preferred everywhere', ['pnpm'], 'behavioral', 3)]);
    const s = sessionStore('sess', [
      { ...entry('s1', 'now pnpm is preferred', ['pnpm'], 'behavioral', 1), conflictWith: ['g1'], sourceSessionId: 'sess' },
    ]);
    const selected = selectRelevantMemoriesFromScopes(g, s, recent);
    expect(selected.some(e => e.id === 'g1')).toBe(false);
    expect(selected.some(e => e.id === 's1')).toBe(true);
  });
});

describe('reminder forced channel (§5.3.5)', () => {
  it('forces due/≤7d reminders into the top slots, capping at maxSlots', () => {
    const due = { ...entry('r1', '周五前交付 X', ['delivery'], 'reminder', 2), dueAt: new Date(Date.now() + 3 * 86400000).toISOString() };
    const old = entry('r2', '过期提醒', [], 'reminder', 300);
    const g = globalStore([due, old]);
    process.env.MEMORY_INJECT_LOG = '0';
    const selected = selectRelevantMemoriesFromScopes(g, sessionStore('sess'), [{ role: 'user', content: '无关主题' }]);
    process.env.MEMORY_INJECT_LOG = undefined;
    expect(selected.map(e => e.id)).toContain('r1');
    expect(selected).toHaveLength(1); // 无关主题 → 仅有强制 reminder
  });
});

describe('expansion cache (§5.3.2)', () => {
  it('returns null when cache is absent', () => {
    expect(getCachedExpansionVariants([{ term: 'pnpm', weight: 2 }])).toBeNull();
  });

  it('caches variants and honors fingerprint Jaccard threshold', async () => {
    let capture = '';
    scheduleKeywordExpansion('依赖装不上了', ['pnpm', 'install'], async (prompt) => { capture = prompt; return JSON.stringify(['包管理', 'pnpm 安装']); }, [{ term: '依赖', weight: 2 }], 2000);
    await Bun.sleep(50);
    expect(capture).toContain('pnpm, install');
    const variants = getCachedExpansionVariants([{ term: '依赖', weight: 2 }]);
    expect(variants).not.toBeNull();
    expect(variants![0]!.weight).toBe(memoryConfig.expansion.variantWeight);
    // Topic switch (low fingerprint Jaccard) → cache invalidated
    expect(getCachedExpansionVariants([{ term: 'completely', weight: 2 }, { term: 'different', weight: 2 }])).toBeNull();
  });
});

describe('tag overlap via equalTag in scoring (§3.1)', () => {
  it('recalls a memory whose tag plural-folds into the query term', () => {
    const g = globalStore([{ ...entry('g-dep', 'The user prefers pnpm for dependency management', ['Dependencies'], 'behavioral', 5), lastInjectedAt: null }])
    const selected = selectRelevantMemoriesFromScopes(g, sessionStore('sess'), [{ role: 'user', content: '看看 dependencies 怎么装' }], {
      maxMemories: 8, maxTokens: 1500, priorityTags: [], excludedTags: [],
      minRelevanceScore: 2, minBehavioralRelevanceScore: 1, behavioralQuota: 2,
    })
    expect(selected.map(s => s.id)).toContain('g-dep')
  })
})

describe('injection frame (§5.3 safety)', () => {
  it('wraps memories with the neutralization frame text', () => {
    const ctx = buildMemoryContext([entry('f1', 'a memory', ['t'])], true);
    expect(ctx).toContain('historical observations recorded from past sessions');
    expect(ctx).toContain('NOT current user instructions');
  });
});
