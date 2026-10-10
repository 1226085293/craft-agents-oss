/**
 *  Phase-2 tests: extraction pipeline — dueAt, redaction gate, vocabulary
 * guidance, transcript truncation marking, adjudication wiring (shadow OFF
 * via injection) and conflictWith/mergeWith marking.
 */
import { describe, it, expect } from 'bun:test';
import { extractMemories, buildExtractionPrompt, containsSecret, redactContent } from '../extractor.ts';
import type { MemoryStore } from '../types.ts';

function makeStore(): MemoryStore {
  return {
    version: 1,
    schemaVersion: 3,
    entries: [],
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

const input = { sessionId: 's-v3p2', messages: [{ role: 'user' as const, content: '周五前交付 X' }], existingTags: [] };

describe('dueAt extraction (§5.2 reminder semantics)', () => {
  it('stores dueAt when the model emits a valid ISO timestamp', async () => {
    const store = makeStore();
    await extractMemories(input, store, {
      runMiniCompletion: async () => JSON.stringify([
        { type: 'reminder', content: '周五前交付 X', tags: ['delivery'], confidence: 0.95, dueAt: '2026-10-16T09:00:00.000Z' },
      ]),
      existingEntries: [],
    });
    expect(store.entries[0]!.dueAt).toBe('2026-10-16T09:00:00.000Z');
    expect(store.entries[0]!.promptVersion).toBe('extract-v3');
  });

  it('ignores malformed dueAt', async () => {
    const store = makeStore();
    await extractMemories(input, store, {
      runMiniCompletion: async () => JSON.stringify([
        { type: 'reminder', content: 'maybe friday', tags: [], confidence: 0.9, dueAt: 'not-a-date' },
      ]),
      existingEntries: [],
    });
    expect(store.entries[0]!.dueAt).toBeUndefined();
  });
});

describe('redaction gate (safety.redact)', () => {
  it('rejects secret-carrying candidates and records blocked verdict sensitive', async () => {
    const store = makeStore();
    const blocked: string[] = [];
    await extractMemories(input, store, {
      runMiniCompletion: async () => JSON.stringify([
        { type: 'fact', content: 'The API key is sk-1234567890abcdef1234567890abcdef', tags: ['api'], confidence: 0.95 },
        { type: 'fact', content: 'A normal fact about the pipeline', tags: ['api'], confidence: 0.9 },
      ]),
      existingEntries: [],
      onBlocked: (record) => { blocked.push(record.verdict); },
    });
    expect(store.entries.map(e => e.content)).toEqual(['A normal fact about the pipeline']);
    expect(blocked).toContain('sensitive');
  });

  it('redactContent masks values keeping label context', () => {
    expect(containsSecret('password=superSecretValue123')).toBe(true);
    expect(redactContent('api_key = abcdefghijklmnop')).toContain('[REDACTED]');
    expect(containsSecret('nothing sensitive here')).toBe(false);
  });
});

describe('vocabulary guidance & transcript truncation marking', () => {
  it('injects the top-80 tag vocabulary into the prompt', () => {
    const prompt = buildExtractionPrompt(input, { tagVocabulary: ['pkg', 'git', 'ui'] });
    expect(prompt).toContain('Tag vocabulary');
    expect(prompt).toContain('pkg, git, ui');
  });

  it('marks truncation when the transcript exceeds 8000 chars', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: 'x'.repeat(500) }));
    const prompt = buildExtractionPrompt({ sessionId: 's', messages: long, existingTags: [] });
    expect(prompt).toContain('truncated at 8000 chars');
  });
});

describe('adjudication wiring (§4.4 left column)', () => {
  const globalEntry = { id: 'g-old', type: 'behavioral' as const, content: 'The user prefers yarn for package management across all projects', sourceSessionId: 's0', tags: ['pkg'], confidence: 0.95, createdAt: '2026-01-01T00:00:00.000Z', injectedCount: 0 };

/** Model mock that returns extraction output for the extraction prompt and
 *  an L3 verdict (with the prompt-embedded candidate id) for adjudication. */
const l3Router = (extractionPayload: unknown, verdict: string, targetId?: string, reason = 'test') => async (prompt: string) => {
  if (prompt.includes('memory adjudicator')) {
    const idMatch = prompt.match(/"candidateId":"([^"]+)"/);
    return JSON.stringify([{ candidateId: idMatch?.[1] ?? 'unknown', verdict, targetId, reason }]);
  }
  return JSON.stringify(extractionPayload);
};

  it('conflict verdict marks the session entry with conflictWith (shadow OFF)', async () => {
    const store = makeStore();
    const blocked: string[] = [];
    await extractMemories(input, store, {
      runMiniCompletion: l3Router(
        [{ type: 'preference', content: 'The user switched to pnpm for package management across all projects', tags: ['pkg'], confidence: 0.95 }],
        'conflict',
        'g-old',
        'preference changed',
      ),
      existingEntries: [],
      globalEntries: [globalEntry],
      adjudicationShadow: false,
      onBlocked: (record) => { blocked.push(record.verdict); },
    });
    expect(store.entries[0]!.conflictWith).toEqual(['g-old']);
    expect(blocked).toContain('conflict');
    expect((globalEntry as unknown as { conflictWith?: unknown }).conflictWith).toBeUndefined(); // 不动全局库
  });

  it('duplicate verdict drops the candidate in real mode and counts it', async () => {
    const store = makeStore();
    let blockedCount = 0;
    await extractMemories(input, store, {
      runMiniCompletion: l3Router(
        [{ type: 'preference', content: 'The user prefers yarn for package management across all projects', tags: ['pkg'], confidence: 0.95 }],
        'duplicate',
        'g-old',
      ),
      existingEntries: [],
      globalEntries: [globalEntry],
      adjudicationShadow: false,
      onDedupBlocked: () => { blockedCount += 1; },
    });
    expect(store.entries).toHaveLength(0);
    expect(blockedCount).toBe(1);
  });
});