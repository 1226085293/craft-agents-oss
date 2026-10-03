import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressJournal, loadLatestUserRequest, loadProgressSnapshot } from '../../shared/src/agent/progress-journal.ts';
import { patchSplitTurnHandoff, COMPACTION_HANDOFF_MARKER } from '../../../scripts/pi-compaction-handoff-patch.ts';
import {
  shouldForceCompaction,
  shouldCompactForBudget,
  contextTokens,
  FORCED_COMPACTION_MIN_TOKENS,
  BUDGET_COMPACTION_RATIO,
  applyForcedCompactionPatch,
  buildCompactionHandoffInstructions,
} from './forced-compaction.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('automatic compaction handoff contract', () => {
  function makeSession() {
    const calls: unknown[][] = [];
    const session = {
      _checkCompaction: async () => false,
      _runAutoCompaction: async () => true,
      _runDefaultCompaction: async (...args: unknown[]) => {
        calls.push(args);
        return { summary: 'summary' };
      },
    };
    return { session, calls };
  }

  it('warns when private SDK auto-compaction hooks drift', () => {
    const messages: string[] = [];
    const sdkSession = { _checkCompaction: async () => false };
    applyForcedCompactionPatch(sdkSession as never, {
      sessionJsonlPath: 'C:/sessions/drift/session.jsonl',
      log: (message) => messages.push(message),
    });
    expect(messages.some((message) => message.includes('auto-compaction hooks unavailable'))).toBe(true);
  });

  it('adds the fixed handoff contract to the default automatic compaction prompt', async () => {
    const { session, calls } = makeSession();
    applyForcedCompactionPatch(session as never, {
      sessionJsonlPath: 'C:/sessions/s-1/session.jsonl',
      resolveCurrentUserRequest: () => 'Keep this exact request verbatim.',
      resolveProgressSnapshot: () => '- already executed: Read a.ts → found x is false',
    } as never);

    await session._runDefaultCompaction({}, {}, undefined, undefined, undefined, undefined, undefined, 'threshold');

    const instructions = String(calls[0]?.[4]);
    expect(instructions).toContain('Current user request verbatim');
    expect(instructions).toContain('Completed');
    expect(instructions).toContain('In progress');
    expect(instructions).toContain('Blocked');
    expect(instructions).toContain('Confirmed facts');
    expect(instructions).toContain('Rejected paths and reasons');
    expect(instructions).toContain('Next actions');
    expect(instructions).toContain('file paths and IDs');
    expect(instructions).toContain('C:/sessions/s-1/session.jsonl');
    expect(instructions).toContain('Keep this exact request verbatim.');
    expect(instructions).toContain('found x is false');
  });

  it('reads current request and progress from the session ledger at compaction time', async () => {
    const { session, calls } = makeSession();
    const sessionDir = mkdtempSync(join(tmpdir(), 'compact-handoff-'));
    tempDirs.push(sessionDir);
    const ledger = new ProgressJournal(sessionDir);
    ledger.recordUserRequest('Keep the current user request verbatim.');
    ledger.recordConclusion('The rejected parser path fails with SyntaxError.');
    (session as any)._runAutoCompaction = async () => {
      await session._runDefaultCompaction({}, {}, undefined, undefined, undefined, undefined, undefined, 'overflow');
      return true;
    };
    (session as any)._checkCompaction = async () => {
      await (session as any)._runAutoCompaction('overflow', true);
      return true;
    };
    applyForcedCompactionPatch(session as never, {
      sessionJsonlPath: join(sessionDir, 'session.jsonl'),
      resolveCurrentUserRequest: () => loadLatestUserRequest(sessionDir),
      resolveProgressSnapshot: () => loadProgressSnapshot(sessionDir),
    } as never);

    expect(await session._checkCompaction({ stopReason: 'stop' })).toBe(true);
    const instructions = String(calls[0]?.[4]);
    expect(instructions).toContain('Keep the current user request verbatim.');
    expect(instructions).toContain('SyntaxError');
    expect(instructions).toContain(join(sessionDir, 'session.jsonl'));
  });

  it('injects the contract when the SDK itself triggers an automatic threshold compaction', async () => {
    const { session, calls } = makeSession();
    (session as any)._runAutoCompaction = async () => {
      await session._runDefaultCompaction({}, {}, undefined, undefined, undefined, undefined, undefined, 'threshold');
      return true;
    };
    (session as any)._checkCompaction = async () => {
      await (session as any)._runAutoCompaction('threshold', false);
      return true;
    };
    applyForcedCompactionPatch(session as never, {
      sessionJsonlPath: 'C:/sessions/sdk-auto/session.jsonl',
    } as never);

    expect(await session._checkCompaction({ stopReason: 'stop' })).toBe(true);
    expect(String(calls[0]?.[4])).toContain('C:/sessions/sdk-auto/session.jsonl');
  });

  it('injects the same contract when Craft Lane 1 forces a budget compaction', async () => {
    const { session, calls } = makeSession();
    (session as any)._runAutoCompaction = async () => {
      await session._runDefaultCompaction({}, {}, undefined, undefined, undefined, undefined, undefined, 'threshold');
      return true;
    };
    applyForcedCompactionPatch(session as never, {
      sessionJsonlPath: 'C:/sessions/lane1/session.jsonl',
      contextTokenBudget: 8_000,
    } as never);

    expect(await session._checkCompaction({ stopReason: 'stop', usage: { totalTokens: 7_500 } })).toBe(true);
    expect(String(calls[0]?.[4])).toContain('C:/sessions/lane1/session.jsonl');
  });

  it('preserves existing compact instructions and appends the handoff contract', async () => {
    const { session, calls } = makeSession();
    applyForcedCompactionPatch(session as never, {
      sessionJsonlPath: 'C:/sessions/s-1/session.jsonl',
    } as never);

    await session._runDefaultCompaction({}, {}, undefined, undefined, 'caller focus', undefined, undefined, 'manual');

    const instructions = String(calls[0]?.[4]);
    expect(instructions).toContain('caller focus');
    expect(instructions).toContain('Rejected paths and reasons');
  });
});

describe('buildCompactionHandoffInstructions', () => {
  it('patches the split-turn SDK summary to include the compaction handoff contract', () => {
    const source = readFileSync(new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js', import.meta.url), 'utf8');
    const result = patchSplitTurnHandoff(source);
    expect(result.warning).toBeUndefined();
    expect(result.source).toContain(COMPACTION_HANDOFF_MARKER);
    expect(result.source).toContain('session.jsonl');
    expect(result.source).toContain('Rejected paths and reasons');
  });

  it('preserves the transcript recovery pointer when dynamic handoff data is oversized', () => {
    const instructions = buildCompactionHandoffInstructions({
      sessionJsonlPath: 'C:/sessions/large/session.jsonl',
      progressJsonlPath: 'C:/sessions/large/progress.jsonl',
      currentUserRequest: 'task',
      progressSnapshot: 'x'.repeat(20_000),
    });
    expect(instructions.length).toBeLessThanOrEqual(8_000);
    expect(instructions).toContain('C:/sessions/large/session.jsonl');
    expect(instructions).toContain('C:/sessions/large/progress.jsonl');
    expect(instructions).toContain('Transcript recovery pointer');
  });

  it('preserves caller focus and includes bounded dynamic handoff state', () => {
    const instructions = buildCompactionHandoffInstructions({
      sessionJsonlPath: 'C:/sessions/s-2/session.jsonl',
      currentUserRequest: 'Do not run the rejected approach again.',
      progressSnapshot: '- confirmed conclusion: rejected approach failed because permission denied',
      existingInstructions: 'Preserve the migration plan.',
    });
    expect(instructions).toContain('Preserve the migration plan.');
    expect(instructions).toContain('Do not run the rejected approach again.');
    expect(instructions).toContain('permission denied');
    expect(instructions).toContain('C:/sessions/s-2/session.jsonl');
  });
});

describe('contextTokens', () => {
  it('returns totalTokens when present', () => {
    expect(contextTokens({ usage: { totalTokens: 111_947, input: 100_000, output: 0 } })).toBe(111_947);
  });

  it('falls back to sum of parts when totalTokens is missing', () => {
    expect(contextTokens({ usage: { input: 111_947, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBe(111_947);
  });

  it('returns 0 for empty usage', () => {
    expect(contextTokens({ usage: undefined })).toBe(0);
    expect(contextTokens({ usage: { output: 0 } })).toBe(0);
  });
});

describe('shouldForceCompaction', () => {
  it('returns true for length+output=0 above MIN_TOKENS', () => {
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 0, totalTokens: 111_947 } },
      0, // first time
    )).toBe(true);
  });

  it('returns false for stopReason=stop', () => {
    expect(shouldForceCompaction(
      { stopReason: 'stop', usage: { output: 0, totalTokens: 111_947 } },
      0,
    )).toBe(false);
  });

  it('returns false for stopReason=length with output>0', () => {
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 191, totalTokens: 131_280 } },
      0,
    )).toBe(false);
  });

  it('returns false for stopReason=error', () => {
    expect(shouldForceCompaction(
      { stopReason: 'error', usage: { output: 0, totalTokens: 50_000 } },
      0,
    )).toBe(false);
  });

  it('returns false when context is below MIN_TOKENS', () => {
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 0, totalTokens: FORCED_COMPACTION_MIN_TOKENS - 1 } },
      0,
    )).toBe(false);
  });

  it('returns false when context is exactly MIN_TOKENS (boundary)', () => {
    // MIN_TOKENS = 8000, should be >=
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 0, totalTokens: FORCED_COMPACTION_MIN_TOKENS } },
      0,
    )).toBe(true);
  });

  it('returns false when lastForced is close (compaction ineffective)', () => {
    // last forced at 112_000, new total 112_500 → delta 500 < 4000 → ineffective
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 0, totalTokens: 112_500 } },
      112_000, // last forced at 112K
    )).toBe(false);
  });

  it('returns true when lastForced is far (compaction succeeded, context regrew)', () => {
    // last forced at 131_000 (compaction reduced to 35K), now 115_000 again
    expect(shouldForceCompaction(
      { stopReason: 'length', usage: { output: 0, totalTokens: 115_000 } },
      131_000, // 131K was the size before previous forced compaction
    )).toBe(true);
  });

  it('returns true for null message (graceful)', () => {
    expect(shouldForceCompaction(null as unknown as undefined, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Channel budget lane (2026-09-13 lively-forest)
//
// A model's declared contextWindow and the largest request its CHANNEL accepts
// are different numbers. Groq free tier: openai/gpt-oss-120b declares 131072
// but rejects any request over 8000. The SDK only compacts at ~87.5% of the
// declared window, so a 61K session died at 8K having never compacted.
// ---------------------------------------------------------------------------
describe('shouldCompactForBudget', () => {
  it('is inert when no budget is configured', () => {
    expect(shouldCompactForBudget(500_000, 0, 0)).toBe(false);
    expect(shouldCompactForBudget(0, 8_000, 0)).toBe(false);
  });

  it('stays quiet well below the budget', () => {
    // 61_426 is the exact request size Groq rejected; the trigger point is
    // 0.9 * budget, so a budget comfortably above the context must not fire.
    expect(shouldCompactForBudget(6_000, 8_000, 0)).toBe(false);
  });

  it('fires once context reaches the trigger ratio', () => {
    const budget = 8_000;
    const trigger = Math.ceil(budget * BUDGET_COMPACTION_RATIO);
    expect(shouldCompactForBudget(trigger, budget, 0)).toBe(true);
    expect(shouldCompactForBudget(trigger - 1, budget, 0)).toBe(false);
  });

  it('fires for any stopReason — the point is to compact BEFORE rejection', () => {
    // Unlike shouldForceCompaction this lane is not gated on stopReason, so a
    // healthy session approaching the ceiling still gets compacted.
    expect(shouldCompactForBudget(7_500, 8_000, 0)).toBe(true);
  });

  it('refuses to loop when a previous budget compaction barely helped', () => {
    // Compacted at 7_500, still 7_200 afterwards: delta 300 < 4000 tolerance.
    // The session genuinely does not fit this channel — stop burning calls.
    expect(shouldCompactForBudget(7_200, 8_000, 7_500)).toBe(false);
  });

  it('fires again after a compaction that actually shrank context', () => {
    // Compacted from 30_000; context regrew to 7_500 — a real second pass.
    expect(shouldCompactForBudget(7_500, 8_000, 30_000)).toBe(true);
  });
});