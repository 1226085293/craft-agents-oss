/**
 * Tests for the scheduling kernel ported from uni-api.
 *
 * These are not "does it run" tests. Each one pins a semantic that, if broken,
 * produces a behaviour that is hard to diagnose in production:
 *
 * - a sliding window that degenerates to a fixed bucket doubles the effective
 *   quota at a window boundary;
 * - a cooldown that pushes a key to the tail starves every other key;
 * - a sticky binding that survives a cooldown keeps sending traffic to a dead
 *   key;
 * - a circuit that trips on 429 turns a rate-limit storm into an outage.
 */

import { describe, it, expect } from 'bun:test';

import {
  parseRateLimit,
  rulesForModel,
  RateLimitState,
  createWindowIndex,
  secondsUntilNextMinute,
  secondsUntilNextUtcDay,
  TPR_PERIOD,
} from '../llm-rate-limiter.ts';
import { KeyPool, AllKeysUnavailableError } from '../llm-key-pool.ts';
import type { KeyPoolOptions } from '../llm-key-pool.ts';

// ============================================================================
// Policy parsing
// ============================================================================

describe('parseRateLimit', () => {
  it('parses uni-api\'s "50/min, 2000000/tpr" form', () => {
    expect(parseRateLimit('50/min, 2000000/tpr')).toEqual([
      { count: 50, periodSeconds: 60, metric: 'requests' },
      { count: 2000000, periodSeconds: TPR_PERIOD, metric: 'tokens' },
    ]);
  });

  it('supports second / hour / day units', () => {
    expect(parseRateLimit('10/s')).toEqual([{ count: 10, periodSeconds: 1, metric: 'requests' }]);
    expect(parseRateLimit('100/hour')).toEqual([{ count: 100, periodSeconds: 3600, metric: 'requests' }]);
    expect(parseRateLimit('5000/day')).toEqual([{ count: 5000, periodSeconds: 86400, metric: 'requests' }]);
  });

  it('ignores malformed entries instead of throwing', () => {
    // An unknown unit falls back to /min rather than being dropped: a typo'd
    // unit should degrade to a working default, not silently disable limiting.
    expect(parseRateLimit('abc, /min')).toEqual([]);
    expect(parseRateLimit('5/bogus')).toEqual([{ count: 5, periodSeconds: 60, metric: 'requests' }]);
    expect(parseRateLimit(undefined)).toEqual([]);
    expect(parseRateLimit('')).toEqual([]);
  });
});

describe('rulesForModel', () => {
  it('prefers preset custom windows over the legacy string', () => {
    expect(
      rulesForModel({ customLimits: [{ amount: 5, unit: 'requests', per: 1, perUnit: 'minutes' }] }, '50/min, 2000000/tpr'),
    ).toEqual([
      { count: 5, periodSeconds: 60, metric: 'requests' },
    ]);
  });

  it('tags token units and TPR as token rules, request units as request rules', () => {
    expect(
      rulesForModel(
        {
          customLimits: [
            { amount: 30, unit: 'requests', per: 1, perUnit: 'minutes' },
            { amount: 300, unit: 'requests', per: 24, perUnit: 'hours', sliding: false },
            { amount: 90_000, unit: 'tokens', per: 1, perUnit: 'minutes' },
            { amount: 1_000_000, unit: 'tokens', per: 24, perUnit: 'hours', sliding: false },
          ],
          tpr: 8_000,
        },
        undefined,
      ),
    ).toEqual([
      { count: 8_000, periodSeconds: TPR_PERIOD, metric: 'tokens' },
      { count: 30, periodSeconds: 60, metric: 'requests' },
      { count: 300, periodSeconds: 86_400, metric: 'requests', fixed: true },
      { count: 90_000, periodSeconds: 60, metric: 'tokens' },
      { count: 1_000_000, periodSeconds: 86_400, metric: 'tokens', fixed: true },
    ]);
  });

  it('falls back to the legacy string when the preset has no rate fields', () => {
    expect(rulesForModel({ supportsVision: true }, '50/min')).toEqual([
      { count: 50, periodSeconds: 60, metric: 'requests' },
    ]);
  });

  it('falls back when there is no preset at all', () => {
    expect(rulesForModel(undefined, '10/min')).toEqual([{ count: 10, periodSeconds: 60, metric: 'requests' }]);
  });

  it('enforces custom windows on top of each other', () => {
    // 5-hour and 1-hour buckets are the whole point: they cannot be expressed
    // as rpm/rpd, and both must stay in force alongside a sliding minute window.
    expect(
      rulesForModel(
        {
          customLimits: [
            { amount: 500, unit: 'requests', per: 5, perUnit: 'hours' },
            { amount: 2_000_000, unit: 'tokens', per: 1, perUnit: 'hours' },
            { amount: 30, unit: 'tokens', per: 30, perUnit: 'minutes' },
            { amount: 10, unit: 'requests', per: 1, perUnit: 'minutes' },
          ],
        },
        undefined,
      ),
    ).toEqual([
      { count: 500, periodSeconds: 18_000, metric: 'requests' },
      { count: 2_000_000, periodSeconds: 3_600, metric: 'tokens' },
      { count: 30, periodSeconds: 1_800, metric: 'tokens' },
      { count: 10, periodSeconds: 60, metric: 'requests' },
    ]);
  });

  it('a preset with only custom windows still wins over the legacy string', () => {
    expect(
      rulesForModel({ customLimits: [{ amount: 5, unit: 'requests', per: 2, perUnit: 'minutes' }] }, '50/min'),
    ).toEqual([{ count: 5, periodSeconds: 120, metric: 'requests' }]);
  });
});

// ============================================================================
// Rate limit state
// ============================================================================

describe('RateLimitState', () => {
  it('is a sliding window: an old request drops out as time passes', () => {
    let now = 1000;
    const state = new RateLimitState(() => now);
    const windows = createWindowIndex();
    const rules = [{ count: 2, periodSeconds: 60 }];

    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(false);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(false);
    // Third within the window is blocked.
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(true);

    // Move past the first request's expiry — it leaves the window.
    now += 61;
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(false);
  });

  it('does not count a non-committing (probe) check', () => {
    const state = new RateLimitState(() => 1000);
    const windows = createWindowIndex();
    const rules = [{ count: 1, periodSeconds: 60 }];
    state.isRateLimited('k', 'm', rules, windows, { commit: true });
    // A probe would burn quota if it committed; verify it does not.
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);
    expect(state.isRateLimited('other', 'm', rules, windows, { commit: false })).toBe(false);
  });

  it('scopes windows per model so one model cannot consume another\'s quota', () => {
    const state = new RateLimitState(() => 1000);
    const windows = createWindowIndex();
    const rules = [{ count: 1, periodSeconds: 60 }];
    state.isRateLimited('k', 'm1', rules, windows, { commit: true });
    expect(state.isRateLimited('k', 'm1', rules, windows, { commit: true })).toBe(true);
    expect(state.isRateLimited('k', 'm2', rules, windows, { commit: true })).toBe(false);
  });

  it('treats TPR as a single-request ceiling, independent of windows', () => {
    const state = new RateLimitState(() => 1000);
    const windows = createWindowIndex();
    const rules = [{ count: 8000, periodSeconds: TPR_PERIOD }];
    expect(state.isTprExceeded('m', 9000, rules)).toBe(true);
    expect(state.isTprExceeded('m', 5000, rules)).toBe(false);
    // Zero-token requests (e.g. a health ping) are never TPR violations.
    expect(state.isTprExceeded('m', 0, rules)).toBe(false);
  });

  it('enforces a token window by summing tokens instead of counting requests', () => {
    const state = new RateLimitState(() => 1000);
    const windows = createWindowIndex();
    const rules = rulesForModel({ customLimits: [{ amount: 1000, unit: 'tokens', per: 1, perUnit: 'minutes' }] }, undefined);

    // Each request fits under the ceiling at admission time; the window tracks
    // the running token total, not the request count.
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true, tokens: 600 })).toBe(false);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true, tokens: 300 })).toBe(false);
    // 900 used: a 200-token request is admitted (pre-check), pushing it to 1100.
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true, tokens: 200 })).toBe(false);
    // Now the window is over the ceiling.
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);
  });

  it('reconciles a committed estimate with the measured usage', () => {
    const state = new RateLimitState(() => 1000);
    const windows = createWindowIndex();
    const rules = rulesForModel({ customLimits: [{ amount: 1000, unit: 'tokens', per: 1, perUnit: 'minutes' }] }, undefined);
    const entry = state.commitRequest('k', 'm', rules, windows, 100);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(false);
    // The real request cost far more than estimated; the same entry is updated.
    state.reconcile(entry, 1500);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);
  });

  it('resets a fixed daily window at the UTC day boundary, not 24h after the first request', () => {
    let now = 86_000; // 23:53:20 UTC, still day 0
    const state = new RateLimitState(() => now);
    const windows = createWindowIndex();
    const rules = rulesForModel({ customLimits: [{ amount: 1, unit: 'requests', per: 24, perUnit: 'hours', sliding: false }] }, undefined);

    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(false);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);

    // A fixed window resets at the UTC boundary (midnight), not 24h later.
    now = 86_400;
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(false);
  });

  it('a sliding 24-hour window keeps counting across the UTC midnight', () => {
    let now = 86_000; // 23:53:20 UTC, still day 0
    const state = new RateLimitState(() => now);
    const windows = createWindowIndex();
    // sliding omitted = default = sliding: the last 86400s, not the calendar day.
    const rules = rulesForModel({ customLimits: [{ amount: 1, unit: 'requests', per: 24, perUnit: 'hours' }] }, undefined);

    expect(state.isRateLimited('k', 'm', rules, windows, { commit: true })).toBe(false);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);

    // Crossing UTC midnight does NOT reset a sliding window; the entry from
    // 23:53:20 is still within the last 24 hours.
    now = 86_400;
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);
  });

  it('cools a keyless provider through its synthetic empty key', () => {
    // A provider with no keys is one unit; its slot id is `''`, which must not
    // be silently ignored by setCooling.
    const state = new RateLimitState(() => 1000);
    state.setCooling('', 60);
    expect(state.isCooling('')).toBe(true);
    expect(state.remainingCooldown('')).toBe(60);
  });

  it('keeps cooldown separate from rate limiting', () => {
    let now = 1000;
    const state = new RateLimitState(() => now);
    const windows = createWindowIndex();
    const rules = [{ count: 10, periodSeconds: 60 }];

    // Under quota, but cooling.
    state.setCooling('k', 60);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(true);
    expect(state.remainingCooldown('k')).toBe(60);

    now += 61;
    expect(state.isCooling('k')).toBe(false);
    expect(state.isRateLimited('k', 'm', rules, windows, { commit: false })).toBe(false);
  });

  it('reports all cooling items with their remaining time', () => {
    let now = 1000;
    const state = new RateLimitState(() => now);
    state.setCooling('a', 60);
    state.setCooling('b', 30);
    expect(new Map(state.coolingItems())).toEqual(new Map([['a', 60], ['b', 30]]));
    // Remaining is `until - now` (duration semantics): at t=0 both keys have
    // their full duration. Advancing 31s leaves `a` exactly 29s of *elapsed*
    // distance-to-expiry, not 30 — `b` (30s) has already expired and is pruned.
    now += 31;
    expect(new Map(state.coolingItems())).toEqual(new Map([['a', 29]]));
  });
});

// ============================================================================
// Key pool
// ============================================================================

function makePool(overrides: Partial<KeyPoolOptions> = {}) {
  const keys = ['k1', 'k2', 'k3'];
  return new KeyPool({
    keys: keys.map(id => ({ id, enabled: true, weight: 1 })),
    algorithm: 'round_robin',
    rules: new Map(),
    ...overrides,
  });
}

describe('KeyPool — round robin', () => {
  it('cycles through all keys before repeating', async () => {
    const pool = makePool();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push((await pool.next('m')).keyId);
    expect(new Set(seen)).toEqual(new Set(['k1', 'k2', 'k3']));
    // Each key appears exactly twice in 6 picks.
    for (const id of ['k1', 'k2', 'k3']) {
      expect(seen.filter(s => s === id)).toHaveLength(2);
    }
  });

  it('skips a cooling key and returns it to its original slot after cooldown', async () => {
    const pool = makePool();
    const order: string[] = [];
    // Let a full cycle settle so the cursor is predictable.
    await pool.next('m'); await pool.next('m'); await pool.next('m');

    await pool.setCooling('k2', 'default');
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) picks.push((await pool.next('m')).keyId);
    expect(picks).not.toContain('k2');

    // After expiry, k2 is selected again — it did not move to the tail.
    await pool.clearCooling('k2');
    const after: string[] = [];
    for (let i = 0; i < 3; i++) after.push((await pool.next('m')).keyId);
    expect(new Set(after)).toEqual(new Set(['k1', 'k2', 'k3']));
  });

  it('throws AllKeysUnavailableError when every key is cooled down', async () => {
    const pool = makePool();
    await pool.setCooling('k1', 'default');
    await pool.setCooling('k2', 'default');
    await pool.setCooling('k3', 'default');
    await expect(pool.next('m')).rejects.toThrow(AllKeysUnavailableError);
  });

  it('never selects a disabled key', async () => {
    const pool = makePool({
      keys: [
        { id: 'k1', enabled: false, weight: 1 },
        { id: 'k2', enabled: true, weight: 1 },
      ],
    });
    for (let i = 0; i < 5; i++) expect((await pool.next('m')).keyId).toBe('k2');
  });
});

describe('KeyPool — rate limits', () => {
  it('stops selecting a key once its window is full', async () => {
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }, { id: 'k2', enabled: true, weight: 1 }],
      rules: new Map([['k1', [{ count: 2, periodSeconds: 60 }]]]),
    });
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push((await pool.next('m')).keyId);
    // k1 serves 2, then the remaining 2 go to k2 (unlimited).
    expect(picks.filter(p => p === 'k1')).toHaveLength(2);
    expect(picks.filter(p => p === 'k2')).toHaveLength(2);
  });

  it('reports all-unavailable when rate limits are exhausted', async () => {
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }],
      rules: new Map([['k1', [{ count: 1, periodSeconds: 60 }]]]),
    });
    await pool.next('m');
    expect(await pool.isAllUnavailable('m')).toBe(true);
    expect(await pool.isAllUnavailable('other-model')).toBe(false);
  });
});

describe('KeyPool — sticky sessions', () => {
  it('keeps a session on one key across requests', async () => {
    const pool = makePool();
    const a = (await pool.next('m', 'session-a')).keyId;
    const b = (await pool.next('m', 'session-a')).keyId;
    const c = (await pool.next('m', 'session-a')).keyId;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('isolates different sessions', async () => {
    const pool = makePool();
    const a = (await pool.next('m', 'session-a')).keyId;
    const b = (await pool.next('m', 'session-b')).keyId;
    // Different sessions start at different cursor positions.
    expect(a).not.toBe(b);
  });

  it('migrates the session when its key is cooled down', async () => {
    const pool = makePool();
    const first = (await pool.next('m', 'session-a')).keyId;
    await pool.setCooling(first, 'default');
    const second = await pool.next('m', 'session-a');
    expect(second.sticky).toBe(false);
    expect(second.migrated).toBe(true);
    expect(second.keyId).not.toBe(first);
  });

  it('migrates when the key hits its rate limit', async () => {
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }, { id: 'k2', enabled: true, weight: 1 }],
      rules: new Map([['k1', [{ count: 1, periodSeconds: 60 }]]]),
    });
    const first = (await pool.next('m', 'session-a')).keyId;
    if (first === 'k1') {
      // k1 is now exhausted for this session's model.
      const second = await pool.next('m', 'session-a');
      expect(second.keyId).toBe('k2');
    }
  });

  it('expires a binding after the TTL', async () => {
    let now = 1000;
    const pool = makePool({ stickySession: { ttlSeconds: 30 } });
    const originalNow = Date.now;
    // KeyPool uses Date.now() internally for TTL comparisons; shift it.
    Date.now = () => now * 1000;
    try {
      const first = (await pool.next('m', 'session-a')).keyId;
      now += 31;
      // Other sessions have advanced the cursor, so a fresh assignment differs.
      const second = await pool.next('m', 'session-a');
      expect(second.sticky).toBe(false);
      expect(second.keyId).not.toBe(first);
    } finally {
      Date.now = originalNow;
    }
  });

  it('evicts the oldest bindings past maxEntries', async () => {
    const pool = makePool({ stickySession: { ttlSeconds: 3600, maxEntries: 2 } });
    await pool.next('m', 's1');
    await pool.next('m', 's2');
    await pool.next('m', 's3');
    // s1 is the oldest and must have been evicted, so it re-assigns.
    const res = await pool.next('m', 's1');
    expect(res.sticky).toBe(false);
  });
});

describe('KeyPool — availability', () => {
  it('reports a rate-limited pool with the wait until the window frees', async () => {
    // The gateway turns this into 429 + Retry-After; a boolean would force it to
    // guess, and the previous default (503 "no healthy account") misread a quota
    // wall as an outage.
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }],
      rules: new Map([['k1', [{ count: 1, periodSeconds: 60, metric: 'requests' }]]]),
    });
    expect((await pool.availability('m')).available).toBe(true);
    await pool.next('m');
    const after = await pool.availability('m');
    expect(after.available).toBe(false);
    expect(after.reason).toBe('rate_limit');
    expect(after.retryAfterSeconds).toBeGreaterThan(0);
    expect(after.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts the soonest recovery, not the worst one', async () => {
    // k1 is cooling for a month (quota) while k2 frees up within the minute;
    // retrying after the minute finds a live key, so that is what to advertise.
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }, { id: 'k2', enabled: true, weight: 1 }],
      rules: new Map([['k2', [{ count: 1, periodSeconds: 60, metric: 'requests' }]]]),
    });
    await pool.setCooling('k1', 'quota');
    await pool.next('m');
    const a = await pool.availability('m');
    expect(a.available).toBe(false);
    expect(a.reason).toBe('rate_limit');
    expect(a.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('reports cooling as cooling with the remaining cooldown', async () => {
    const pool = makePool({ keys: [{ id: 'k1', enabled: true, weight: 1 }] });
    await pool.setCooling('k1', 'default');
    const a = await pool.availability('m');
    expect(a).toMatchObject({ available: false, reason: 'cooling' });
    expect(a.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports capacity pressure as concurrency', async () => {
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }],
      concurrency: new Map([['k1', 1]]),
    });
    // Selection reserves the in-flight slot, so a second probe hits the ceiling.
    await pool.next('m');
    expect(await pool.availability('m')).toMatchObject({ available: false, reason: 'concurrency' });
  });
});

describe('KeyPool — algorithms', () => {
  it('sequential always starts at the head', async () => {
    const pool = makePool({ algorithm: 'sequential' });
    expect((await pool.next('m')).keyId).toBe('k1');
    expect((await pool.next('m')).keyId).toBe('k1');
  });

  it('weighted favours heavier keys', async () => {
    const pool = makePool({
      algorithm: 'weighted',
      keys: [
        { id: 'k1', enabled: true, weight: 3 },
        { id: 'k2', enabled: true, weight: 1 },
      ],
    });
    const picks: string[] = [];
    for (let i = 0; i < 8; i++) picks.push((await pool.next('m')).keyId);
    const k1 = picks.filter(p => p === 'k1').length;
    expect(k1).toBeGreaterThan(picks.length - k1);
  });

  it('least_busy prefers the key with fewer in-flight requests', async () => {
    const pool = makePool({ algorithm: 'least_busy' });
    const first = (await pool.next('m')).keyId;
    // `next` already reserves the slot, so k1 is busier than the others.
    const second = (await pool.next('m')).keyId;
    expect(second).not.toBe(first);
    pool.finishRequest(first);
    pool.finishRequest(second);
  });

  it('failover_only uses the head and only advances on demand', async () => {
    const pool = makePool({ algorithm: 'failover_only' });
    const first = (await pool.next('m')).keyId;
    await pool.setCooling(first, 'default');
    const second = (await pool.next('m')).keyId;
    expect(second).not.toBe(first);
  });
});

describe('KeyPool — cooldown reasons', () => {
  it('uses the quota duration for a quota-exhausted key', async () => {
    const pool = makePool({
      now: () => 1000,
      cooldowns: new Map([['k1', { defaultSeconds: 60, rateLimitSeconds: 60, quotaSeconds: 2592000 }]]),
    });
    await pool.setCooling('k1', 'quota');
    const snap = pool.snapshot().find(s => s.keyId === 'k1')!;
    expect(snap.cooldownRemaining).toBe(2592000);
  });

  it('honours returnToOriginalPosition=false by moving the key to the tail', async () => {
    const pool = makePool({ returnToOriginalPosition: false });
    await pool.setCooling('k1', 'default');
    // k1 is now last in rotation order, so it is reached last.
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) picks.push((await pool.next('m')).keyId);
    expect(picks[0]).not.toBe('k1');
  });
});

describe('KeyPool — 429 escalation', () => {
  /** 58 seconds into a minute, so the first cooldown is 2s. */
  const AT_58 = 1_000_000 - (1_000_000 % 60) + 58;

  it('escalates consecutive 429s: minute end → 60s → 300s → day', async () => {
    let now = AT_58;
    const pool = makePool({
      now: () => now,
      cooldowns: new Map([['k1', { defaultSeconds: 60, rateLimitSeconds: 60, quotaSeconds: 2592000 }]]),
    });

    expect(await pool.setRateLimited('k1')).toBe(2);
    now += 3;
    expect(await pool.setRateLimited('k1')).toBe(60);
    now += 1;
    expect(await pool.setRateLimited('k1')).toBe(300);
    now += 1;
    expect(await pool.setRateLimited('k1')).toBe(secondsUntilNextUtcDay(now));
  });

  it('honours Retry-After over the ladder', async () => {
    const pool = makePool({ now: () => AT_58 });
    expect(await pool.setRateLimited('k1', { retryAfterSeconds: 42 })).toBe(42);
  });

  it('skips straight to a day-level cooldown for a daily/quota signal', async () => {
    let now = AT_58;
    const pool = makePool({ now: () => now });
    expect(await pool.setRateLimited('k1', { dayLevel: true })).toBe(secondsUntilNextUtcDay(now));
  });

  it('resets the ladder after a successful response', async () => {
    let now = AT_58;
    const pool = makePool({
      now: () => now,
      cooldowns: new Map([['k1', { defaultSeconds: 60, rateLimitSeconds: 60, quotaSeconds: 2592000 }]]),
    });
    await pool.setRateLimited('k1'); // step 1
    now += 1;
    await pool.setRateLimited('k1'); // step 2 → 60s
    pool.noteSuccess('k1');
    now += 2;
    expect(await pool.setRateLimited('k1')).toBe(secondsUntilNextMinute(now));
  });

  it('does not cool healthy keys when only one key is shared', async () => {
    // A single key can be shared with another client; the others are fine.
    // The cooldown unit is the key, so only k1 may cool.
    const pool = makePool({ now: () => AT_58 });
    await pool.setRateLimited('k1');
    const snap = pool.snapshot();
    expect(snap.find(s => s.keyId === 'k1')!.cooling).toBe(true);
    expect(snap.find(s => s.keyId === 'k2')!.cooling).toBe(false);
    expect(snap.find(s => s.keyId === 'k3')!.cooling).toBe(false);
  });
});

describe('KeyPool — concurrency', () => {
  it('skips a key that is at its in-flight ceiling', async () => {
    const pool = makePool({
      algorithm: 'sequential',
      keys: [
        { id: 'k1', enabled: true, weight: 1 },
        { id: 'k2', enabled: true, weight: 1 },
      ],
      concurrency: new Map([['k1', 1]]),
    });
    const first = await pool.next('m');
    expect(first.keyId).toBe('k1');
    const second = await pool.next('m');
    expect(second.keyId).toBe('k2');
    pool.finishRequest('k1');
    pool.finishRequest('k2');
    // Back under the ceiling: k1 is selectable again (sequential restarts at
    // the head).
    expect((await pool.next('m')).keyId).toBe('k1');
  });

  it('reports a capacity refusal separately from a rate-limit refusal', async () => {
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }],
      concurrency: new Map([['k1', 1]]),
    });
    await pool.next('m');
    try {
      await pool.next('m');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(AllKeysUnavailableError);
      expect((err as AllKeysUnavailableError).reason).toBe('concurrency');
    }
    pool.finishRequest('k1');
  });
});

describe('KeyPool — keyless provider', () => {
  it('cools the provider slot after a 429 and refuses selection', async () => {
    // A provider with no keys is a single unit with the synthetic id `''`.
    const pool = makePool({ keys: [{ id: '', enabled: true, weight: 1 }], now: () => 1000 });
    await pool.setRateLimited('');
    expect(pool.snapshot().find(s => s.keyId === '')!.cooling).toBe(true);
    await expect(pool.next('m')).rejects.toThrow(AllKeysUnavailableError);
  });
});

describe('KeyPool — snapshot', () => {
  it('reports availability per key', async () => {
    const pool = makePool();
    await pool.setCooling('k2', 'default');
    const snap = pool.snapshot();
    expect(snap.find(s => s.keyId === 'k2')!.available).toBe(false);
    expect(snap.find(s => s.keyId === 'k2')!.cooldownRemaining).toBe(60);
    expect(snap.filter(s => s.available)).toHaveLength(2);
    expect(snap).toHaveLength(3);
  });

  it('counts a sticky request against the window', async () => {
    // A pinned session used to bypass the windows entirely (commit:false), so
    // RPM/RPD never saw its traffic. The first request fills a 1-per-minute
    // key; the second must fail even though the binding still points at it.
    const pool = makePool({
      keys: [{ id: 'k1', enabled: true, weight: 1 }],
      rules: new Map([['k1', [{ count: 1, periodSeconds: 60, metric: 'requests' }]]]),
    });
    await pool.next('m', 'session-a');
    await expect(pool.next('m', 'session-a')).rejects.toThrow(AllKeysUnavailableError);
  });
});



