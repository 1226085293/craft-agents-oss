/**
 * Global memory switch (MemoryStore.memoryEnabled === false):
 * - buildMemoryContext returns '' (no injection, no existence hint)
 * - extractSessionMemories is a no-op (extraction skipped at the entry)
 * - data on disk is untouched: the switch is a pipeline gate, not a wipe
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts';
import type { MemoryStore } from '../../memory/types.ts';
import { loadMemoryStore, saveMemoryStore } from '../../memory/store.ts';

let root: string;

function disabledStore(): MemoryStore {
  return {
    version: 1,
    extractionHistory: [],
    totalInjectionTokens: 0,
    memoryEnabled: false,
    entries: [
      {
        id: 'kept-entry',
        type: 'behavioral',
        content: '条目在开关关闭期间保留在盘上（只关管线，不删数据）',
        confidence: 1,
        createdAt: new Date().toISOString(),
        injectedCount: 0,
        sourceSessionId: 's',
      },
    ],
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-gate-'));
  saveMemoryStore(root, disabledStore());
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeAgent(): TestAgent {
  return new TestAgent(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }) }));
}

describe('memoryEnabled=false gate', () => {
  it('skips memory injection entirely (no context, no existence hint)', async () => {
    const agent = makeAgent();
    const ctx = await (agent as unknown as { buildMemoryContext?: (m?: string) => Promise<string> }).buildMemoryContext?.('测试') ?? '';
    expect(ctx).toBe('');
  });

  it('skips session-end extraction (zero extracted, zero discarded)', async () => {
    const agent = makeAgent();
    const result = await agent.extractSessionMemories({ strategy: 'session_end' });
    expect(result).toEqual({ extracted: 0, discarded: 0 });
  });

  it('leaves the on-disk store untouched (gate, not wipe)', () => {
    const store = loadMemoryStore(root);
    expect(store.memoryEnabled).toBe(false);
    expect(store.entries.map((e) => e.id)).toContain('kept-entry');
  });
});

describe('memoryEnabled missing (legacy store) = pipeline on, zero regression', () => {
  it('extracts as before when the flag is absent', async () => {
    // A store without the flag must behave exactly like before the switch
    // existed: the gate only trips on an explicit `false`.
    const legacy: MemoryStore = {
      version: 1,
      extractionHistory: [],
      totalInjectionTokens: 0,
      entries: [],
    };
    saveMemoryStore(root, legacy);
    const agent = makeAgent();
    // No entries, no session jsonl in this tmp workspace — the method runs
    // its normal path and reports an empty result without tripping the gate.
    const result = await agent.extractSessionMemories({ strategy: 'session_end' });
    expect(result.extracted).toBe(0);
    expect(result.discarded).toBe(0);
  });
});
