/**
 * One-shot guard strategy keying + batch semantic dedup (2026-10-03 review):
 *
 * 1) The per-session one-shot guard is keyed by (sessionId, strategy), so an
 *    early compaction pass can no longer consume the session-end slot (or
 *    vice versa). Legacy callers without a strategy keep the old
 *    "any extraction from this session" behavior.
 * 2) semanticDedup compares each candidate against the LIVE store, so two
 *    near-identical candidates from a single extraction batch dedup against
 *    each other.
 */
import { describe, it, expect } from 'bun:test';
import { extractMemories } from '../extractor.ts';
import type { MemoryStore } from '../types.ts';

const makeStore = (): MemoryStore => ({
  version: 1,
  entries: [],
  extractionHistory: [],
  totalInjectionTokens: 0,
});

const historyRecord = (
  sessionId: string,
  strategy?: 'compaction' | 'session_end',
) => ({
  sessionId,
  timestamp: new Date().toISOString(),
  factsExtracted: 1,
  factsDiscarded: 0,
  newEntryIds: [],
  ...(strategy ? { strategy } : {}),
});

const runOpts = (
  strategy?: 'compaction' | 'session_end',
  extra: Partial<{ semanticDedup: boolean; existingEntries: MemoryStore['entries'] }> = {},
) => ({
  runMiniCompletion: async () =>
    '[{"type":"fact","content":"The build runs on Bun 1.3 with pnpm workspaces","tags":["build"],"confidence":0.9}]',
  existingEntries: extra.existingEntries ?? [],
  semanticDedup: extra.semanticDedup ?? false,
  ...(strategy ? { strategy } : {}),
});

const input = {
  sessionId: 's1',
  messages: [{ role: 'user' as const, content: 'use bun + pnpm here' }],
};

describe('extractMemories — strategy-keyed one-shot guard', () => {
  it('does not record a successful pass when the model returns no response', async () => {
    const store = { version: 1 as const, sessionId: 'session-empty', entries: [], extractionHistory: [] }
    await expect(extractMemories({ sessionId: 'session-empty', messages: [], existingTags: [] }, store, {
      runMiniCompletion: async () => null,
      existingEntries: [],
    })).rejects.toThrow('empty response')
    expect(store.extractionHistory).toHaveLength(0)
  })

  it('an earlier compaction pass does NOT block the session_end slot', async () => {
    const store = makeStore();
    store.extractionHistory.push(historyRecord('s1', 'compaction'));

    // Pre-fix: alreadyExtracted matched on sessionId alone → LLM never called.
    let llmCalls = 0;
    const result = await extractMemories(input, store, {
      ...runOpts('session_end'),
      runMiniCompletion: async () => {
        llmCalls++;
        return '[{"type":"fact","content":"Late fact learned near session end","tags":["late"],"confidence":0.9}]';
      },
    });
    expect(llmCalls).toBe(1);
    expect(result.factsExtracted).toBe(1);
    // The pass is recorded under its own strategy slot.
    expect(store.extractionHistory.at(-1)?.strategy).toBe('session_end');
  });

  it('a second session_end pass in the same session is still one-shot', async () => {
    const store = makeStore();
    store.extractionHistory.push(historyRecord('s1', 'session_end'));

    let llmCalls = 0;
    const result = await extractMemories(input, store, {
      ...runOpts('session_end'),
      runMiniCompletion: async () => { llmCalls++; return '[]'; },
    });
    expect(llmCalls).toBe(0);
    expect(result.factsExtracted).toBe(0);
  });

  it('compaction vs compaction is one-shot too', async () => {
    const store = makeStore();
    await extractMemories(input, store, {
      ...runOpts('compaction'),
      runMiniCompletion: async () =>
        '[{"type":"fact","content":"Compaction fact one","tags":["compaction"],"confidence":0.9}]',
    });
    let llmCalls = 0;
    await extractMemories(input, store, {
      ...runOpts('compaction'),
      runMiniCompletion: async () => { llmCalls++; return '[]'; },
    });
    expect(llmCalls).toBe(0); // second compaction pass gated
  });

  it('legacy callers without a strategy keep the original any-extraction guard', async () => {
    const store = makeStore();
    store.extractionHistory.push(historyRecord('s1')); // no strategy field (legacy)

    let llmCalls = 0;
    await extractMemories(input, store, {
      ...runOpts(),
      runMiniCompletion: async () => { llmCalls++; return '[]'; },
    });
    expect(llmCalls).toBe(0);
  });
});

describe('extractMemories — batch-internal semantic dedup', () => {
  it('two near-identical candidates from one batch dedup against each other', async () => {
    const store = makeStore();
    const result = await extractMemories(input, store, {
      runMiniCompletion: async () => JSON.stringify([
        { type: 'fact', content: 'The build pipeline uses Bun with pnpm workspaces for every package', tags: ['build'], confidence: 0.9 },
        { type: 'fact', content: 'The build pipeline uses Bun with pnpm workspaces for every package except the cli app', tags: ['build'], confidence: 0.9 },
      ]),
      existingEntries: [],
      semanticDedup: true,
    });
    // Pre-fix: the second candidate was compared against the pre-call
    // snapshot (empty) and slipped in. Now the live store contains the
    // first entry, so the near-identical second one is dropped.
    // (Note: result.factsExtracted reports candidates PARSED, not kept —
    // the durable assertion is the store itself.)
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]!.content).toBe(
      'The build pipeline uses Bun with pnpm workspaces for every package',
    );
  });
});
