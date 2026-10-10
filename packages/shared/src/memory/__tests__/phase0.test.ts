/**
 *  Phase-0 tests: schema contract, idempotent migration, atomic write with
 * snapshot rotation, retention GC, and the write-lock queue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  foldLegacyMemoryType,
  normalizeTag,
  equalTag,
  memoryConfig,
  type MemoryStore,
} from '../types.ts';
import {
  loadMemoryStore,
  saveMemoryStore,
  migrateMemoryStore,
} from '../store.ts';
import { withMemoryWriteLock } from '../write-lock.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'memory-phase0-'));
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch {}
});

function legacyStore(): MemoryStore {
  return {
    version: 1,
    entries: [
      { id: 'e1', type: 'fact' as never, content: 'A', sourceSessionId: 's1', tags: ['pnpm', 'Dependencies'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'e2', type: 'context' as never, content: 'B', sourceSessionId: 's1', tags: ['pnpm'], confidence: 0.8, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'e3', type: 'preference' as never, content: 'C', sourceSessionId: 's2', tags: ['Git'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'e4', type: 'workflow' as never, content: 'D', sourceSessionId: 's2', tags: ['git'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
      { id: 'e5', type: 'reminder' as never, content: 'E', sourceSessionId: 's3', tags: ['due'], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
    ],
    trash: [],
    extractionHistory: [],
    totalInjectionTokens: 0,
  };
}

describe('foldLegacyMemoryType — three-class folding (【决策】)', () => {
  it('maps five-class to three-class', () => {
    expect(foldLegacyMemoryType('fact')).toBe('factual');
    expect(foldLegacyMemoryType('context')).toBe('factual');
    expect(foldLegacyMemoryType('preference')).toBe('behavioral');
    expect(foldLegacyMemoryType('workflow')).toBe('behavioral');
    expect(foldLegacyMemoryType('reminder')).toBe('reminder');
  });

  it('is idempotent on already-folded values', () => {
    expect(foldLegacyMemoryType('factual')).toBe('factual');
    expect(foldLegacyMemoryType('behavioral')).toBe('behavioral');
    expect(foldLegacyMemoryType('reminder')).toBe('reminder');
  });
});

describe('normalizeTag / equalTag', () => {
  it('trims, lowercases and folds English plurals', () => {
    expect(normalizeTag('  Dependencies ')).toBe('dependency');
    expect(normalizeTag('Git')).toBe('git');
    expect(normalizeTag('Boxes')).toBe('box');
    expect(normalizeTag('class')).toBe('class');   // 'ss' guard
    expect(normalizeTag('status')).toBe('status'); // 's'/'us' guard
  });

  it('equalTag compares across spelling variants', () => {
    expect(equalTag('Dependencies', 'dependency')).toBe(true);
    expect(equalTag('pnpm', 'PNPM')).toBe(true);
    expect(equalTag('git', 'github')).toBe(false);
  });
});

describe('equalTag semantics in L1 dedup (§3.1)', () => {
  it('isSemanticDuplicate treats plural-folded tags as an overlap', async () => {
    const { extractMemories } = await import('../extractor.ts')
    const store: MemoryStore = { version: 1, schemaVersion: 3, entries: [], trash: [], extractionHistory: [], totalInjectionTokens: 0, blocked: [], tagFrequency: {}, tagVocabulary: [], priorityTags: [], extractionRetryQueue: [], dedupBlockedCount: 0 }
    // 会话内两条近重复：内容相同、标签拼写不同（dependencies vs dependency）
    await extractMemories({ sessionId: 's-eq', messages: [{ role: 'user' as const, content: 'x' }], existingTags: [] }, store, {
      runMiniCompletion: async () => JSON.stringify([
        { type: 'fact', content: 'The user prefers pnpm for dependency management in monorepos', tags: ['dependencies'], confidence: 0.9 },
        { type: 'fact', content: 'The user prefers pnpm for dependency management in monorepos', tags: ['dependency'], confidence: 0.9 },
      ]),
      existingEntries: [],
      semanticDedup: true,
    })
    expect(store.entries).toHaveLength(1)
  })
})

describe('migrateMemoryStore — idempotent one-shot migration', () => {
  it('folds types, normalizes tags, bootstraps vocabulary + priorityTags, backfills', () => {
    const store = legacyStore();
    const migrated = migrateMemoryStore(store, workspace);
    expect(migrated).toBe(true);
    expect(store.schemaVersion).toBe(3);

    expect(store.entries.map(e => e.type)).toEqual(['factual', 'factual', 'behavioral', 'behavioral', 'reminder']);
    expect(store.entries[0]!.tags).toEqual(['pnpm', 'dependency']);
    expect(store.entries[3]!.tags).toEqual(['git']);

    // Vocabulary: frequency-sorted; 'pnpm' (2) first, 'dependency' (1), 'git' (2), 'due' (1)
    const vocab = store.tagVocabulary!;
    expect(vocab[0]).toBe('pnpm');
    expect(vocab).toContain('git');
    expect(vocab).toContain('dependency');
    expect(vocab).toContain('due');

    // priorityTags: top-5 by frequency → the two most frequent tags
    expect(store.priorityTags!.slice(0, 2)).toEqual(['pnpm', 'git']);

    for (const e of store.entries) {
      expect(e.promptVersion).toBe('legacy');
      expect(e.lastInjectedAt).toBeNull();
      expect(e.promoted).toBe(false);
    }
  });

  it('runs twice with zero diff (idempotent)', () => {
    const store = legacyStore();
    const before = JSON.stringify(store);
    expect(migrateMemoryStore(store, workspace)).toBe(true);
    const afterFirst = JSON.stringify(store);
    // Second call: returns false and changes nothing.
    expect(migrateMemoryStore(store, workspace)).toBe(false);
    expect(JSON.stringify(store)).toBe(afterFirst);
    expect(afterFirst).not.toBe(before);
  });

  it('loadMemoryStore persists migration and reloads cleanly', () => {
    writeFileSync(join(workspace, 'memory.json'), JSON.stringify(legacyStore()), 'utf-8');
    const loaded = loadMemoryStore(workspace);
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.entries[0]!.type).toBe('factual');
    // Reload → still v3, no double-migration artifacts.
    const reloaded = loadMemoryStore(workspace);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(loaded));
    expect(reloaded.priorityTags!.length).toBeLessThanOrEqual(5);
  });
});

describe('saveMemoryStore — atomic write + snapshot rotation + retention GC', () => {
  it('rotates memory.backup.N.json files up to retention.snapshots', () => {
    const store = loadMemoryStore(workspace);
    store.entries.push({ id: 'x', type: 'factual', content: 't', sourceSessionId: 's', tags: [], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 });
    for (let i = 0; i < 7; i++) {
      saveMemoryStore(workspace, store);
    }
    const backups = [0, 1, 2, 3, 4].map(n => join(workspace, `memory.backup.${n}.json`));
    expect(backups.every(p => existsSync(p))).toBe(true);
    expect(existsSync(join(workspace, 'memory.backup.5.json'))).toBe(false);
    expect(existsSync(join(workspace, 'memory.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(workspace, 'memory.json'), 'utf-8')).schemaVersion).toBe(3);
  });

  it('caps trash / blocked / history / retry queue at retention limits', () => {
    const store = loadMemoryStore(workspace);
    store.trash = Array.from({ length: 205 }, (_, i) => ({
      entry: { id: `t${i}`, type: 'factual' as const, content: `t${i}`, sourceSessionId: 's', tags: [], confidence: 0.9, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 },
      deletedAt: '2026-01-01T00:00:00.000Z',
    }));
    store.blocked = Array.from({ length: 350 }, (_, i) => ({
      candidateContent: `c${i}`, candidateType: 'factual' as const, sourceSessionId: 's', verdict: 'duplicate' as const,
      reason: 'r', shadow: false, blockedAt: '2026-01-01T00:00:00.000Z',
    }));
    store.extractionRetryQueue = Array.from({ length: 25 }, (_, i) => ({
      sessionId: `s${i}`, strategy: 'session_end' as const, throughMessageId: `m${i}`, reason: 't', attempts: 1, failedAt: '2026-01-01T00:00:00.000Z',
    }));
    saveMemoryStore(workspace, store);
    expect(store.trash!.length).toBe(200);
    expect(store.blocked!.length).toBe(300);
    expect(store.extractionRetryQueue!.length).toBe(20);
    expect(store.extractionHistory.length).toBe(0);
  });
});

describe('withMemoryWriteLock — promise-chain mutex', () => {
  it('serializes concurrent writers in call order', async () => {
    const order: number[] = [];
    const results = await Promise.all([
      withMemoryWriteLock(async () => { order.push(1); await new Promise(r => setTimeout(r, 20)); order.push(2); return 'a'; }),
      withMemoryWriteLock(async () => { order.push(3); return 'b'; }),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual(['a', 'b']);
  });

  it('does not poison the queue when a writer throws', async () => {
    await withMemoryWriteLock(() => { throw new Error('boom'); }).catch(() => {});
    let ran = false;
    await withMemoryWriteLock(() => { ran = true; });
    expect(ran).toBe(true);
  });

  it('applies settings format defaults', () => {
    expect(memoryConfig.schemaVersion).toBe(3);
    expect(memoryConfig.adjudication.shadow).toBe(true);
    expect(memoryConfig.safety.redact).toBe(true);
  });
});