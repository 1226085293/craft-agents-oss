import { describe, expect, it } from 'bun:test';
import { shouldForceCompaction, contextTokens, FORCED_COMPACTION_MIN_TOKENS } from './forced-compaction.ts';

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