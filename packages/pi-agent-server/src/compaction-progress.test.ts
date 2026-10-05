import { describe, expect, it } from 'bun:test';
import {
  COMPACTION_PROGRESS_INTERVAL_MS,
  DEFAULT_COMPACTION_PROGRESS_CAP_MS,
  createCompactionProgressHeartbeat,
  getCompactionProgressCapMs,
} from './compaction-progress.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Regression contract for the 2026-10-04 incident: a 3m40s threshold
 * compaction false-positived the PiAgent's then-120s turn-idle watchdog because
 * the main stream is silent for the whole SDK summary call. The server-side
 * heartbeat keeps the watchdog fed; it must be BOUNDED so a dead
 * compaction still trips the capped deadline instead of being silenced
 * forever (amber-plain class of silent hangs).
 */
describe('createCompactionProgressHeartbeat', () => {
  it('emits ticks every intervalMs while the compaction is in flight', async () => {
    const events: { elapsedMs: number }[] = [];
    const hb = createCompactionProgressHeartbeat({
      emit: (e) => events.push(e),
      intervalMs: 20,
      capMs: 10_000,
    });
    hb.start();
    await sleep(140);
    hb.stop();

    // ~5 ticks at 20ms, but allow for coarse event-loop timing (Windows
    // timer resolution) — the contract is: multiple ticks flow while in
    // flight, never one shot, never zero.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.length).toBeLessThanOrEqual(8);
    // elapsedMs is monotonic and starts near zero
    const elapsed = events.map((e) => e.elapsedMs);
    expect(elapsed[0]).toBeGreaterThanOrEqual(10); // first tick ~one interval in
    for (let i = 1; i < elapsed.length; i++) expect(elapsed[i]).toBeGreaterThan(elapsed[i - 1]);
  });

  it('stops emitting once the cap is reached (bounded heartbeat)', async () => {
    const events: { elapsedMs: number }[] = [];
    const hb = createCompactionProgressHeartbeat({
      emit: (e) => events.push(e),
      intervalMs: 20,
      capMs: 80,
    });
    hb.start();
    await sleep(200); // 3x past the cap — the timer must be dead by now
    const countAtCap = events.length;
    expect(countAtCap).toBeGreaterThan(0);
    expect(events[events.length - 1].elapsedMs).toBeLessThan(200);

    await sleep(100);
    expect(events.length).toBe(countAtCap); // no growth after cap
  });

  it('stop() is idempotent and start() restarts the cadence', async () => {
    const events: { elapsedMs: number }[] = [];
    const hb = createCompactionProgressHeartbeat({
      emit: (e) => events.push(e),
      intervalMs: 10,
      capMs: 10_000,
    });
    hb.start();
    await sleep(30);
    hb.stop();
    const atStop = events.length;
    await sleep(50);
    expect(events.length).toBe(atStop);

    hb.start(); // restart resets the clock
    await sleep(30);
    expect(events.length).toBeGreaterThan(atStop);
    hb.stop();
  });
});

describe('getCompactionProgressCapMs', () => {
  it('defaults to the 5-minute shared cap', () => {
    const prev = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS;
    delete process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS;
    try {
      expect(getCompactionProgressCapMs()).toBe(DEFAULT_COMPACTION_PROGRESS_CAP_MS);
      expect(getCompactionProgressCapMs()).toBe(5 * 60 * 1000);
    } finally {
      if (prev !== undefined) process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = prev;
    }
  });

  it('honors a positive env override and falls back on garbage', () => {
    const prev = process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS;
    try {
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = '600000';
      expect(getCompactionProgressCapMs()).toBe(600000);
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = 'not-a-number';
      expect(getCompactionProgressCapMs()).toBe(DEFAULT_COMPACTION_PROGRESS_CAP_MS);
      process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = '-5';
      expect(getCompactionProgressCapMs()).toBe(DEFAULT_COMPACTION_PROGRESS_CAP_MS);
    } finally {
      if (prev !== undefined) process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS = prev;
      else delete process.env.CRAFT_PI_COMPACTION_IDLE_TIMEOUT_MS;
    }
  });

  it('keeps the default heartbeat cadence at 30s', () => {
    expect(COMPACTION_PROGRESS_INTERVAL_MS).toBe(30_000);
  });
});
