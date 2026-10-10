/**
 *  Phase-1 tests: consolidation write-time adjudication gate.
 * Verifies §4.4 dispositions (real mode) and §4.3 shadow behavior.
 */
import { describe, it, expect } from 'bun:test';
import type { MemoryEntry, MemoryStore, SessionMemoryStore } from '../types.ts';
import { consolidateSessionMemories } from '../consolidation.ts';

function entry(id: string, content: string, tags: string[] = [], type: MemoryEntry['type'] = 'behavioral'): MemoryEntry {
  return { id, type, content, sourceSessionId: 's1', tags, confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 };
}

function globalWith(): MemoryStore {
  return {
    version: 1,
    schemaVersion: 3,
    entries: [entry('old-pkg', 'The user prefers yarn for package management across all projects', ['pkg'])],
    trash: [],
    extractionHistory: [],
    totalInjectionTokens: 0,
    blocked: [],
    tagFrequency: {},
    tagVocabulary: ['pkg'],
    priorityTags: ['pkg'],
    extractionRetryQueue: [],
    dedupBlockedCount: 0,
  };
}

function sessionWith(c: MemoryEntry): SessionMemoryStore {
  return { version: 1, sessionId: 's1', entries: [c], consolidatedEntryIds: [], extractionHistory: [] };
}

const l3 = (verdict: string, targetId?: string, mergedContent?: string, reason = 'test') => async () =>
  JSON.stringify([{ candidateId: 'c-new', verdict, targetId, mergedContent, reason }]);

/** Consolidation (main) model answers with a promotion of the given candidate. */
const evaluatePromotion = (c: MemoryEntry) => async () =>
  JSON.stringify({ promotions: [{ id: c.id, content: c.content, type: c.type, tags: c.tags }], conflicts: [] });

describe('write-time gate — shadow OFF (real dispositions, §4.4)', () => {
  it('conflict: promotes new entry, soft-deletes target with replacedById', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'The user switched to pnpm for package management across all projects', ['pkg']);
    const res = await consolidateSessionMemories(global, [sessionWith(cand)], evaluatePromotion(cand), {
      runMiniCompletion: l3('conflict', 'old-pkg'),
      adjudicationShadow: false,
    });
    expect(res.promoted).toBe(1);
    expect(global.entries.map(e => e.id)).toContain('c-new');
    expect(global.entries.some(e => e.id === 'old-pkg')).toBe(false);
    expect(global.trash?.[0]?.entry.id).toBe('old-pkg');
    expect(global.trash?.[0]?.replacedById).toBe('c-new');
    expect(global.blocked?.some(b => b.verdict === 'conflict')).toBe(true);
  });

  it('duplicate: does not promote, records blocked + dedupBlockedCount', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'The user prefers yarn for package management across all projects', ['pkg']);
    const res = await consolidateSessionMemories(global, [sessionWith(cand)], evaluatePromotion(cand), {
      runMiniCompletion: l3('duplicate', 'old-pkg'),
      adjudicationShadow: false,
    });
    expect(res.promoted).toBe(0);
    expect(global.entries.map(e => e.id)).toEqual(['old-pkg']);
    expect(global.dedupBlockedCount).toBe(1);
    expect(global.blocked?.some(b => b.verdict === 'duplicate')).toBe(true);
  });

  it('update: promotes mergedContent, trashes target with reason=merged', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'The user prefers pnpm for package management across all recent client projects', ['pkg']);
    const res = await consolidateSessionMemories(global, [sessionWith(cand)], evaluatePromotion(cand), {
      runMiniCompletion: l3('update', 'old-pkg', 'The user prefers pnpm for package management across all projects.'),
      adjudicationShadow: false,
    });
    expect(res.promoted).toBe(1);
    expect(global.entries.find(e => e.id === 'c-new')?.content).toBe('The user prefers pnpm for package management across all projects.');
    expect(global.trash?.[0]?.reason).toBe('merged');
  });
});

describe('write-time gate — shadow ON (observe only, §4.3)', () => {
  it('conflict verdict records blocked but keeps both entries (no soft delete)', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'The user switched to pnpm for package management across all projects', ['pkg']);
    const res = await consolidateSessionMemories(global, [sessionWith(cand)], evaluatePromotion(cand), {
      runMiniCompletion: l3('conflict', 'old-pkg'),
      adjudicationShadow: true,
    });
    expect(res.promoted).toBe(1);
    expect(global.entries.map(e => e.id).sort()).toEqual(['c-new', 'old-pkg']);
    expect(global.trash).toHaveLength(0);
    expect(global.blocked?.some(b => b.verdict === 'conflict' && b.shadow === true)).toBe(true);
  });

  it('duplicate verdict in shadow still promotes and records shadow audit', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'The user prefers Yarn when installing all packages across projects', ['pkg']);
    const res = await consolidateSessionMemories(global, [sessionWith(cand)], evaluatePromotion(cand), {
      runMiniCompletion: l3('duplicate', 'old-pkg'),
      adjudicationShadow: true,
    });
    expect(res.promoted).toBe(1);
    expect(global.entries).toHaveLength(2);
    expect(global.blocked?.some(b => b.verdict === 'duplicate' && b.shadow === true)).toBe(true);
  });
});

describe('promoted flag & vocabulary growth gate (§5.1 / §3.3)', () => {
  it('marks session entry promoted after successful promotion', async () => {
    const global = globalWith();
    const cand = entry('c-new', 'A brand new independent fact about gardening', ['garden', 'new-tag'], 'factual');
    const session = sessionWith(cand);
    await consolidateSessionMemories(global, [session], async () =>
      JSON.stringify({ promotions: [{ id: 'c-new', content: 'A brand new independent fact about gardening', type: 'factual', tags: ['garden', 'new-tag'] }], conflicts: [] }),
      { runMiniCompletion: async () => null, adjudicationShadow: false },
    );
    expect(session.entries[0]!.promoted).toBe(true);
    expect(global.entries.some(e => e.id === 'c-new')).toBe(true);
  });

  it('folds a new tag into vocabulary only after ≥3 occurrences', async () => {
    const global = globalWith();
    const mk = (id: string, content: string) => entry(id, content, ['fresh-tag'], 'factual');
    const l3ok = async () => JSON.stringify({ promotions: [], conflicts: [] });
    const run = async (c: MemoryEntry) => consolidateSessionMemories(global, [sessionWith(c)], async () =>
      JSON.stringify({ promotions: [{ id: c.id, content: c.content, type: 'factual', tags: c.tags }], conflicts: [] }),
      { runMiniCompletion: async () => null, adjudicationShadow: false },
    );
    await run(mk('a', 'A unique fact about aquascaping biotopes'));
    await run(mk('b', 'A distinct note about bonsai wiring techniques'));
    expect(global.tagVocabulary).not.toContain('fresh-tag');
    await run(mk('c', 'A separate observation about fermentation vessels'));
    expect(global.tagVocabulary).toContain('fresh-tag');
  });
});