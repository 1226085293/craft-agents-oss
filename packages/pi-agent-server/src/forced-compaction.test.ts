import { describe, expect, it } from 'bun:test';
import {
  shouldForceCompaction,
  shouldCompactForBudget,
  contextTokens,
  FORCED_COMPACTION_MIN_TOKENS,
  BUDGET_COMPACTION_RATIO,
} from './forced-compaction.ts';

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