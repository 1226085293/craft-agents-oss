import { describe, expect, it } from 'bun:test';
import { runVerificationJudge } from './verification-judge.ts';

function harness(attemptResults: Array<string | null>, failWith?: Error) {
  let calls = 0;
  const skips: Array<{ attempt: number; total: number; reason: string }> = [];
  const delays: number[] = [];
  const outcome = runVerificationJudge(
    'judge prompt',
    {
      runAttempt: async () => {
        calls += 1;
        if (failWith) {
          const idx = calls - 1;
          if (idx >= attemptResults.length) throw failWith;
        }
        return attemptResults[calls - 1] ?? null;
      },
      onSkip: async (attempt, total, reason) => { skips.push({ attempt, total, reason }); },
      delay: async (ms) => { delays.push(ms); },
    },
  );
  return { outcome, skips, delays, count: () => calls };
}

describe('runVerificationJudge', () => {
  it('returns the verdict on the first successful attempt', async () => {
    const h = harness(['PASS']);
    const r = await h.outcome;
    expect(r).toEqual({ verdict: 'PASS', attemptsUsed: 1, lastFault: '' });
    expect(h.skips).toHaveLength(0);
    expect(h.delays).toHaveLength(0);
    expect(h.count()).toBe(1);
  });

  it('skips after transient faults then returns the verdict when the judge recovers', async () => {
    const h = harness([null, null, 'FAIL']);
    const r = await h.outcome;
    expect(r).toEqual({ verdict: 'FAIL', attemptsUsed: 3, lastFault: '' });
    expect(h.skips).toHaveLength(2);
    expect(h.skips[0]).toEqual({ attempt: 1, total: 3, reason: 'empty judge response' });
    expect(h.skips[1]).toEqual({ attempt: 2, total: 3, reason: 'empty judge response' });
    // Linear backoff: 1s then 2s.
    expect(h.delays).toEqual([1000, 2000]);
  });

  it('treats a thrown attempt as a fault and retries', async () => {
    const results = [null, null];
    const h = harness(results, new Error('queryLlm timed out after 115s'));
    // First call: attemptResults[0] === null → fault 'empty judge response'?? no:
    // with failWith set, every call at index >= attemptResults.length throws.
    // attemptResults.length = 2 → calls 1 and 2 return null, call 3 throws.
    const r = await h.outcome;
    expect(r.verdict).toBeNull();
    expect(r.attemptsUsed).toBe(3);
    expect(r.lastFault).toBe('queryLlm timed out after 115s');
    expect(h.skips).toHaveLength(2);
    expect(h.skips[0].reason).toBe('empty judge response');
    expect(h.skips[1].reason).toBe('empty judge response');
  });

  it('exhausts after maxAttempts when the judge never recovers (no fail-open)', async () => {
    const h = harness([null, null, null]);
    const r = await h.outcome;
    expect(r).toEqual({ verdict: null, attemptsUsed: 3, lastFault: 'empty judge response' });
    // onSkip fires only BEFORE retries — the final failed attempt reports nothing.
    expect(h.skips).toHaveLength(2);
    expect(h.count()).toBe(3);
  });

  it('honors custom maxAttempts and retryDelayMs', async () => {
    let calls = 0;
    const skips: Array<{ attempt: number; total: number; reason: string }> = [];
    const delays: number[] = [];
    const r = await runVerificationJudge('p', {
      runAttempt: async () => {
        if (calls++ < 1) return null;
        return 'PASS';
      },
      onSkip: async (attempt, total, reason) => { skips.push({ attempt, total, reason }); },
      delay: async (ms) => { delays.push(ms); },
      maxAttempts: 2,
      retryDelayMs: 250,
    });
    expect(r).toEqual({ verdict: 'PASS', attemptsUsed: 2, lastFault: '' });
    expect(skips).toHaveLength(1);
    expect(skips[0]).toEqual({ attempt: 1, total: 2, reason: 'empty judge response' });
    expect(delays).toEqual([250]);
  });
});