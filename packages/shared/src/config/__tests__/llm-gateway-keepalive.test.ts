/**
 * Cooldown-wait keepalive vs the session client's first-byte watchdog.
 *
 * `cooldownSleep` writes the SSE response headers and then sends `: keepalive`
 * comments while a request waits out a key/provider cooldown. The subprocess
 * wraps every response body in `withFirstByteWatchdog`
 * (`unified-network-interceptor.ts`), which arms a 45 s timer when the body
 * opens and aborts a stream whose FIRST chunk never arrives.
 *
 * 2026-11-17 (261110-brave-titanium), twice: the first heartbeat used to wait
 * 60 s — 15 s PAST the watchdog — so a 134 s cooldown wait died client-side
 * at its 45 s mark and the retry budget was spent on a request nobody was
 * reading. The +10 s prelude still misfired at 22:32 that evening (a 59.66 s
 * wait committed its headers at +10 s yet the client aborted at +45 s), so
 * the cadence is now thresholded:
 *
 *  - waits of at least `KEEPALIVE_PRELUDE_THRESHOLD_SECONDS` (30 s) commit
 *    the 200 prelude plus the FIRST `: keepalive` byte atomically at t=0 —
 *    the watchdog is armed and cleared in the same delivery, so it cannot
 *    misfire mid-wait;
 *  - shorter waits keep the `KEEPALIVE_FIRST_MS` (+10 s) deferred first
 *    beat — a sub-threshold wait cannot outlive the watchdog, so there is
 *    nothing to protect against;
 *  - subsequent beats go out every `KEEPALIVE_INTERVAL_MS` (15 s), well
 *    inside the watchdog.
 *
 * These are invariants, not preferences: keep the prelude threshold below
 * the watchdog with room for scheduling jitter.
 */

import { describe, it, expect } from 'bun:test';

import { LlmGateway } from '../llm-gateway.ts';

/** Mirrors the default in `unified-network-interceptor.ts` (env-overridable). */
const CLIENT_FIRST_BYTE_WATCHDOG_MS = 45_000;

describe('gateway cooldown keepalive cadence', () => {
  it('preludes long waits at t=0, with the threshold below the client first-byte watchdog', () => {
    // Waits at/above the threshold commit 200 + the first `: keepalive`
    // atomically at wait start: the client's 45 s watchdog is armed when
    // the body opens and cleared by that first chunk, so arming and
    // clearing coincide. A threshold at or above the watchdog would leave
    // a window where a long wait commits nothing and the client dies
    // mid-wait (the 2026-11-17 22:32 incident).
    expect(LlmGateway.KEEPALIVE_PRELUDE_THRESHOLD_SECONDS * 1000).toBeLessThan(
      CLIENT_FIRST_BYTE_WATCHDOG_MS,
    );
  });

  it('deferred short-wait prelude lands well before the client first-byte watchdog', () => {
    expect(LlmGateway.KEEPALIVE_FIRST_MS).toBeLessThan(CLIENT_FIRST_BYTE_WATCHDOG_MS);
    // Margin for a slow socket / timer jitter: at least half the watchdog.
    expect(LlmGateway.KEEPALIVE_FIRST_MS).toBeLessThanOrEqual(CLIENT_FIRST_BYTE_WATCHDOG_MS / 2);
  });

  it('keeps a cooldown wait under a minute of client-side silence', () => {
    // The steadier cadence must also stay inside the watchdog, otherwise a
    // second consecutive miss would trip it even after the first heartbeat.
    expect(LlmGateway.KEEPALIVE_INTERVAL_MS).toBeLessThan(CLIENT_FIRST_BYTE_WATCHDOG_MS);
  });

  it('still lets sub-threshold cooldowns resolve without committing the response to SSE', () => {
    // Short waits stay header-less on purpose: an ordinary request should not
    // pay for an SSE-shaped response it never needed.
    expect(LlmGateway.KEEPALIVE_FIRST_MS).toBeGreaterThanOrEqual(5_000);
  });
});
