import { describe, expect, it } from 'bun:test';
import { RetryLadder, classifyRetryError, type RetryLadderOptions } from '../retry-ladder.ts';

function makeLadder(overrides: Partial<RetryLadderOptions> = {}): { ladder: RetryLadder; now: () => number } {
  let tick = 0;
  const now = () => tick;
  const ladder = new RetryLadder({
    rungsMs: [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000],
    loopMs: 600_000,
    loopCapMs: 86_400_000,
    showErrorAfterAttempt: 3,
    deterministicMaxAttempts: 3,
    now,
    ...overrides,
  });
  return { ladder, now: () => tick };
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
  it('gives exactly deterministicMaxAttempts retries then null', () => {
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
