/**
 *  replay fixtures (§5.4): store/session/conversation snapshots drive a
 * deterministic regression bed for the inject path. Every switch-relevant
 * behavior asserted here can be flipped on/off via config/env and re-run.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore, SessionMemoryStore } from '../types.ts';
import { selectRelevantMemoriesFromScopes, isColdMemory } from '../injector.ts';

const fx = (name: string): any => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'));

const globalStore = fx('store.json') as MemoryStore;
const sessionStore = fx('session-store.json') as SessionMemoryStore;
const conversation = fx('conversation.json');

function runSelection(msgs: Array<{ role: string; content: string }>, opts?: { maxMemories?: number; priorityTags?: string[]; store?: MemoryStore; session?: SessionMemoryStore }) {
  process.env.MEMORY_INJECT_LOG = '0';
  try {
    return selectRelevantMemoriesFromScopes(opts?.store ?? globalStore, opts?.session ?? sessionStore, msgs, {
      maxMemories: opts?.maxMemories ?? 8,
      maxTokens: 1500,
      priorityTags: opts?.priorityTags ?? (globalStore.priorityTags ?? []),
      excludedTags: ['experimental', 'discarded'],
      minRelevanceScore: 2,
      minBehavioralRelevanceScore: 1,
      behavioralQuota: 2,
    });
  } finally {
    process.env.MEMORY_INJECT_LOG = undefined;
  }
}

describe('replay: store fixture — replay-session conversation', () => {
  it('recalls the pnpm behavioral memory on a topical message (ctrl gate PASS)', () => {
    const selected = runSelection(conversation);
    const ids = selected.map(s => s.id);
    expect(ids).toContain('g-pnpm');
  });

  it('skips the promoted session twin — only the global copy injects (dual pool)', () => {
    const selected = runSelection(conversation);
    const pnpmCopies = selected.filter(s => (s.id === 'g-pnpm' || s.id === 's-promoted'));
    expect(pnpmCopies).toHaveLength(1);
    expect(pnpmCopies[0]!.id).toBe('g-pnpm');
  });

  it('suppresses g-yarn (contradicted by s-conflict conflictWith)', () => {
    const ids = runSelection(conversation).map(s => s.id);
    expect(ids).not.toContain('g-yarn');
  });

  it('forces the due reminder via the lookahead channel (≤ maxSlots)', () => {
    // Snapshot with a live dueAt inside the 7-day lookahead window.
    const g = structuredClone(globalStore) as MemoryStore;
    g.entries.find(e => e.id === 'g-reminder')!.dueAt = new Date(Date.now() + 3 * 86400000).toISOString();
    const selected = runSelection(conversation, { store: g, session: structuredClone(sessionStore) as SessionMemoryStore });
    expect(selected.map(s => s.id)).toContain('g-reminder');
    expect(selected.filter(s => s.type === 'reminder').length).toBeLessThanOrEqual(2);
  });

  it('stays within the Top-8 / 1500-token budget', () => {
    const selected = runSelection(conversation, { maxMemories: 8 });
    expect(selected.length).toBeLessThanOrEqual(8);
    const tokens = selected.reduce((acc, s) => acc + Math.ceil(s.content.length / 4) + s.tags.length * 2, 0);
    expect(tokens).toBeLessThanOrEqual(1500);
  });

  it('returns nothing for a completely unrelated topic (recall gate)', () => {
    // priorityTags empty: no unconditional +5 lift; gate must stand on keywords.
    const selected = runSelection([{ role: 'user', content: '量子力学波函数坍缩与猫态观测问题' }], { priorityTags: [] });
    expect(selected).toHaveLength(0);
  });

  it('cold entries stay recallable by keyword (never evicted), but score low off-topic', () => {
    expect(isColdMemory(globalStore.entries.find(e => e.id === 'g-cold')!.lastInjectedAt, '2025-01-01T00:00:00.000Z')).toBe(true);
    const offTopic = runSelection([{ role: 'user', content: '帮忙看看 billing 服务的 legacy 迁移笔记' }]);
    expect(offTopic.map(s => s.id)).toContain('g-cold');
  });
});

describe('replay: switch toggles (§5.4 on/off matrix)', () => {
  it('expansion cache OFF default: no sync model call on the read path (no variants injected on first turn)', () => {
    // getCachedExpansionVariants returns null before any schedule call —
    // the read path never awaits a model.
    const { getCachedExpansionVariants } = require('../injector.ts') as typeof import('../injector.ts');
    expect(getCachedExpansionVariants([{ term: 'pnpm', weight: 2 }])).toBeNull();
  });

  it('decay knob: recency multiplier buckets remain stable', () => {
    const { recencyMultiplier } = require('../injector.ts') as typeof import('../injector.ts');
    const now = Date.now();
    expect(recencyMultiplier(new Date(now - 1 * 86400000).toISOString(), new Date(now - 300 * 86400000).toISOString())).toBe(1.0);
    expect(recencyMultiplier(new Date(now - 5 * 86400000).toISOString(), new Date(now - 300 * 86400000).toISOString())).toBe(1.5);
    expect(recencyMultiplier(new Date(now - 200 * 86400000).toISOString(), new Date(now - 300 * 86400000).toISOString())).toBe(0.4);
  });
});