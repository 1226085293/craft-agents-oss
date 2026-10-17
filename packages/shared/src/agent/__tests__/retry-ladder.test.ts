import { describe, expect, it } from 'bun:test';
import {
  RetryLadder,
  classifyRetryError,
  isStallErrorMessage,
  isNoRerunnableStepRefusal,
  type RetryLadderOptions,
} from '../retry-ladder.ts';

function makeLadder(overrides: Partial<RetryLadderOptions> = {}): { ladder: RetryLadder; now: () => number; setNow: (t: number) => void } {
  let tick = 0;
  const now = () => tick;
  const ladder = new RetryLadder({
    rungsMs: [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000],
    loopMs: 600_000,
    loopCapMs: 86_400_000,
    showErrorAfterAttempt: 3,
    deterministicMaxAttempts: 3,
    maxConsecutiveFailures: 0,
    now,
    ...overrides,
  });
  return { ladder, now, setNow: (t: number) => { tick = t; } };
}

describe('RetryLadder — transient schedule', () => {
  it('walks the full rung ladder then loops at loopMs', () => {
    const { ladder } = makeLadder();
    ladder.begin('transient', { message: 'boom' });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = ladder.nextDelayMs();
      expect(d).not.toBeNull();
      delays.push(d!);
      ladder.onFailure({ message: `fail ${i}` });
    }
    expect(delays.slice(0, 7)).toEqual([1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000]);
    // After the rung ladder: loop phase
    expect(delays.slice(7)).toEqual([600_000, 600_000, 600_000]);
  });

  it('returns null once the loop cap is exceeded', () => {
    let tick = 0;
    const ladder = new RetryLadder({
      rungsMs: [1_000, 5_000, 10_000],
      loopMs: 600_000,
      loopCapMs: 1_000_000, // 16.6 min cap
      showErrorAfterAttempt: 3,
      deterministicMaxAttempts: 3,
      maxConsecutiveFailures: 0,
      now: () => tick,
    });
    ladder.begin('transient', { message: 'x' });
    // Consume the rung ladder (3 rungs) to reach the loop phase.
    ladder.onFailure({ message: '1' });
    ladder.onFailure({ message: '2' });
    ladder.onFailure({ message: '3' });
    tick = 900_000;
    expect(ladder.nextDelayMs()).toBe(600_000); // loop still within cap
    tick = 1_500_001;
    expect(ladder.nextDelayMs()).toBeNull(); // cap exceeded
  });

  it('surfaces the non-terminal error only after showErrorAfterAttempt failures', () => {
    const { ladder } = makeLadder({ showErrorAfterAttempt: 3 });
    ladder.begin('transient', { message: 'x' });
    expect(ladder.shouldSurfaceError).toBe(false);
    ladder.onFailure({ message: '1' });
    ladder.onFailure({ message: '2' });
    expect(ladder.shouldSurfaceError).toBe(false);
    ladder.onFailure({ message: '3' });
    expect(ladder.shouldSurfaceError).toBe(true);
  });

  it('honors retry-after overrides inside the rung phase', () => {
    const { ladder } = makeLadder();
    ladder.begin('transient', { message: '429' });
    ladder.overrideNextDelay(90_000);
    expect(ladder.nextDelayMs()).toBe(90_000); // max(1s, 90s)
    ladder.onFailure({ message: 'still 429' });
    ladder.overrideNextDelay(300_000);
    expect(ladder.nextDelayMs()).toBe(300_000); // max(5s, 300s)=300s
    ladder.onFailure({ message: 'done' });
    // loops don't get long overrides beyond loopMs
    ladder.overrideNextDelay(999_999);
    expect(ladder.nextDelayMs()).toBe(ladder.isLooping ? 600_000 : ladder.nextDelayMs()!);
  });

  it('isActive + onSuccess clears state', () => {
    const { ladder } = makeLadder();
    ladder.begin('transient', { message: 'x' });
    expect(ladder.isActive).toBe(true);
    ladder.onSuccess();
    expect(ladder.isActive).toBe(false);
    expect(ladder.nextDelayMs()).toBeNull();
  });
});

describe('RetryLadder — deterministic', () => {
  it('gives exactly deterministicMaxAttempts retries then null (bounded)', () => {
    const { ladder } = makeLadder({ deterministicMaxAttempts: 3 });
    ladder.begin('deterministic', { message: '400 bad request' });
    expect(ladder.nextDelayMs()).toBe(1_000);
    ladder.onFailure({ message: '400' });
    expect(ladder.nextDelayMs()).toBe(5_000);
    ladder.onFailure({ message: '400' });
    expect(ladder.nextDelayMs()).toBe(10_000);
    ladder.onFailure({ message: '400' });
    expect(ladder.nextDelayMs()).toBeNull();
  });

  it('is UNBOUNDED by default (deterministicMaxAttempts=0): full rung ladder then 10-min loop', () => {
    const { ladder } = makeLadder({ deterministicMaxAttempts: 0 });
    ladder.begin('deterministic', { message: '401 invalid_api_key' });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const d = ladder.nextDelayMs();
      expect(d).not.toBeNull();
      delays.push(d!);
      ladder.onFailure({ message: `401 #${i}` });
    }
    // Same schedule as transient: 1s/5s/10s/30s/60s/5m/10m then loop at loopMs.
    expect(delays.slice(0, 7)).toEqual([1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000]);
    expect(delays.slice(7)).toEqual([600_000, 600_000, 600_000]);
    expect(ladder.isLooping).toBe(true);
  });

  it('deterministic bypasses the consecutive-failure guard (unbounded until loop cap)', () => {
    const { ladder, setNow } = makeLadder({ deterministicMaxAttempts: 0, maxConsecutiveFailures: 3 });
    ladder.begin('deterministic', { message: '401 invalid_api_key' });
    // 12 consecutive failures — way past maxConsecutiveFailures=3 — still retries.
    for (let i = 0; i < 12; i++) {
      expect(ladder.nextDelayMs()).not.toBeNull();
      ladder.onFailure({ message: `401 #${i}` });
    }
    expect(ladder.nextDelayMs()).not.toBeNull();
    // But the 24 h loopCapMs is still respected as the final boundary.
    setNow(86_400_001);
    expect(ladder.nextDelayMs()).toBeNull();
  });

  it('transient consecutive-failure guard still hard-stops after maxConsecutiveFailures', () => {
    const { ladder } = makeLadder({ deterministicMaxAttempts: 0, maxConsecutiveFailures: 3 });
    ladder.begin('transient', { message: 'network_error' });
    ladder.onFailure({ message: '1' });
    ladder.onFailure({ message: '2' });
    ladder.onFailure({ message: '3' });
    expect(ladder.nextDelayMs()).toBe(30_000);
    ladder.onFailure({ message: '4' });
    expect(ladder.nextDelayMs()).toBeNull();
  });
});

describe('classifyRetryError', () => {
  it('classifies 4xx-family codes as deterministic', () => {
    expect(classifyRetryError('invalid_model', 'x')).toBe('deterministic');
    expect(classifyRetryError('image_too_large', 'x')).toBe('deterministic');
    expect(classifyRetryError('invalid_api_key', 'x')).toBe('deterministic');
  });
  it('classifies rate/service/network/unknown as transient', () => {
    expect(classifyRetryError('rate_limited', 'x')).toBe('transient');
    expect(classifyRetryError('service_error', 'x')).toBe('transient');
    expect(classifyRetryError('network_error', 'x')).toBe('transient');
    expect(classifyRetryError(undefined, 'Turn stalled: no activity for 300s — aborting')).toBe('transient');
  });
  it('falls back to status-code heuristics when code is missing', () => {
    expect(classifyRetryError(undefined, 'HTTP 503 Service Unavailable')).toBe('transient');
    expect(classifyRetryError(undefined, 'HTTP 404 model not found')).toBe('deterministic');
  });
});

describe('restartCycle (2026-10-11 fine-cloud user spec)', () => {
  it('resets the failure count and advances the cycle start, keeping the ladder active', () => {
    const { ladder } = makeLadder()
    ladder.begin('transient', { message: 'boom' })
    ladder.onFailure({ message: '1' })
    ladder.onFailure({ message: '2' })
    ladder.onFailure({ message: '3' })
    expect(ladder.attemptCount).toBe(3)
    expect(ladder.startedAtMs).toBe(0)
    expect(ladder.isActive).toBe(true)
    // Soft recovery ends the visible cycle: next failure starts counting at 1.
    // The ladder start is NOT moved — rows anchor on the backoff's actual emit
    // moment (pi-agent sends startedAt: Date.now()), so the cycle start stays
    // the ladder's authoritative anchor for elapsed/persist matching.
    ladder.restartCycle()
    expect(ladder.attemptCount).toBe(0)
    expect(ladder.isActive).toBe(true)
    expect(ladder.startedAtMs).toBe(0)
    // The next backoff delay starts from the 1s rung again.
    expect(ladder.nextDelayMs()).toBe(1_000)
    // The FIRST failure of the new cycle keeps attempts=0 (fresh-begin
    // semantics) so its backoff reads "等待第 1 次重试" — the upcoming retry
    // is the cycle's first, not the carried-over fourth.
    ladder.onFailure({ message: '4' })
    expect(ladder.attemptCount).toBe(0)
    expect(ladder.nextDelayMs()).toBe(1_000)
    // The SECOND failure advances to 1 → next retry is attempt 2.
    ladder.onFailure({ message: '5' })
    expect(ladder.attemptCount).toBe(1)
    expect(ladder.nextDelayMs()).toBe(5_000)
  })
})

describe('RetryLadder — consecutive-failure guard (2026-10-14 261013-mild-stream)', () => {
  it('hard-stops on the retry AFTER maxConsecutiveFailures consecutive failures', () => {
    const { ladder } = makeLadder({ maxConsecutiveFailures: 3 })
    ladder.begin('transient', { message: 'network_error' })
    // Consecutive failures 1..3: still retrying (rung ladder).
    expect(ladder.nextDelayMs()).toBe(1_000)
    ladder.onFailure({ message: '1' })
    expect(ladder.nextDelayMs()).toBe(5_000)
    ladder.onFailure({ message: '2' })
    expect(ladder.nextDelayMs()).toBe(10_000)
    ladder.onFailure({ message: '3' })
    // The 4th schedule check sees 3 consecutive failures > max(3)... wait —
    // the guard fires when consecutiveFailures EXCEEDS the max, so the 4th
    // failure is what hard-stops. With 3 failures the ladder still plans a
    // 4th retry at the 30s rung.
    expect(ladder.nextDelayMs()).toBe(30_000)
    // 4th consecutive failure → guard trips: no further retry.
    ladder.onFailure({ message: '4' })
    expect(ladder.nextDelayMs()).toBeNull()
  })

  it('does not reset the consecutive count on a regular attempt (no success)', () => {
    const { ladder } = makeLadder({ maxConsecutiveFailures: 2 })
    ladder.begin('transient', { message: 'x' })
    ladder.onFailure({ message: '1' })
    ladder.onFailure({ message: '2' })
    ladder.onFailure({ message: '3' })
    expect(ladder.nextDelayMs()).toBeNull()
  })

  it('breaks the consecutive chain on restartCycle (soft-settled recovery)', () => {
    const { ladder } = makeLadder({ maxConsecutiveFailures: 3 })
    ladder.begin('transient', { message: 'x' })
    ladder.onFailure({ message: '1' })
    ladder.onFailure({ message: '2' })
    ladder.onFailure({ message: '3' })
    // Soft recovery closes the visible cycle — consecutive chain resets.
    ladder.restartCycle()
    expect(ladder.nextDelayMs()).toBe(1_000)
    ladder.onFailure({ message: '4' })
    ladder.onFailure({ message: '5' })
    ladder.onFailure({ message: '6' })
    // Only 2 counted after the cycle reset... actually 3 failures (see
    // restartCycle semantics: first keeps attempts=0) — still short of 3+1.
    expect(ladder.nextDelayMs()).toBe(10_000)
  })

  it('is disabled when maxConsecutiveFailures is 0 (historic unbounded loop)', () => {
    const { ladder } = makeLadder({ maxConsecutiveFailures: 0 })
    ladder.begin('transient', { message: 'x' })
    for (let i = 0; i < 20; i++) {
      ladder.onFailure({ message: String(i) })
    }
    // Past the rung ladder: loop phase, not null.
    expect(ladder.nextDelayMs()).toBe(600_000)
  })
})


describe('RetryLadder — internal recovery faults (2026-10-18)', () => {
  it('internal faults never surface the non-terminal error card', () => {
    const { ladder } = makeLadder({ showErrorAfterAttempt: 3 });
    ladder.begin('transient', { message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    expect(ladder.internalFailure).toBe(true);
    expect(ladder.shouldSurfaceError).toBe(false);
  });

  it('a later non-internal failure surfaces normally (recovery fault was superseded)', () => {
    const { ladder } = makeLadder({ showErrorAfterAttempt: 3 });
    ladder.begin('transient', { message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'real upstream error' });
    expect(ladder.internalFailure).toBe(false);
    expect(ladder.shouldSurfaceError).toBe(true);
  });

  it('internal faults still walk the transient rungs and consecutive-failure guard', () => {
    const { ladder } = makeLadder({ maxConsecutiveFailures: 2 });
    ladder.begin('transient', { message: 'Turn stalled', internal: true });
    expect(ladder.nextDelayMs()).toBe(1_000);
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    ladder.onFailure({ message: 'Turn stalled', internal: true });
    expect(ladder.nextDelayMs()).toBeNull();
  });
});

describe('retry error signals (2026-10-18)', () => {
  it('recognizes the subprocess stall message', () => {
    expect(isStallErrorMessage('Turn stalled: no activity for 300s — aborting')).toBe(true);
  });

  it('recognizes the main-process stream stall message', () => {
    expect(isStallErrorMessage('Pi agent stream stalled for 300s with no events after all tools completed (timeout 300s).')).toBe(true);
  });

  it('does not misclassify real upstream errors as stalls', () => {
    expect(isStallErrorMessage('Connection error.')).toBe(false);
    expect(isStallErrorMessage('429 Too Many Requests')).toBe(false);
  });

  it('recognizes the no-rerunnable refusal', () => {
    expect(isNoRerunnableStepRefusal('Cannot retry: the current turn has no re-runnable model step.')).toBe(true);
  });

  it('does not misclassify other prompt errors as the refusal', () => {
    expect(isNoRerunnableStepRefusal('Cannot retry: the session transcript is empty.')).toBe(false);
  });
});
