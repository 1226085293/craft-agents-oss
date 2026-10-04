import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SHELL_TIMEOUT_S,
  MAX_SHELL_TIMEOUT_S,
  normalizeShellTimeout,
} from './shell-timeout.ts';

/**
 * Regression contract for the 2026-10-04 incident: a bash call with
 * `timeout: 120000` (model intent: 120 s in ms) was interpreted by the Pi
 * SDK as 120 000 SECONDS (~33 hours), so no per-call timeout ever fired and
 * the 60-min turn guardrail was the only thing that eventually stopped it.
 *
 * The wrapper in index.ts must normalize every model-supplied timeout:
 *   - values >= 1000 are almost certainly milliseconds → divide by 1000
 *   - the result is clamped to [1, MAX_SHELL_TIMEOUT_S]
 *   - missing/invalid → DEFAULT_SHELL_TIMEOUT_S
 */
describe('normalizeShellTimeout', () => {
  it('applies the default ceiling when no timeout is passed', () => {
    expect(normalizeShellTimeout(undefined)).toBe(DEFAULT_SHELL_TIMEOUT_S);
  });

  it('passes through sane second values unchanged', () => {
    expect(normalizeShellTimeout(120)).toBe(120);
    expect(normalizeShellTimeout(300)).toBe(300);
    expect(normalizeShellTimeout(1)).toBe(1);
  });

  it('recovers millisecond values (the 120000 incident)', () => {
    expect(normalizeShellTimeout(120000)).toBe(120);
    expect(normalizeShellTimeout(1000)).toBe(1);
    expect(normalizeShellTimeout(300000)).toBe(300);
  });

  it('never exceeds the hard ceiling', () => {
    // 3_600_000 "ms" → 3600 s → clamped
    expect(normalizeShellTimeout(3_600_000)).toBe(MAX_SHELL_TIMEOUT_S);
    // A genuine second value above the ceiling is also clamped
    expect(normalizeShellTimeout(900)).toBe(MAX_SHELL_TIMEOUT_S);
  });

  it('falls back to the default for invalid values', () => {
    expect(normalizeShellTimeout(0)).toBe(DEFAULT_SHELL_TIMEOUT_S);
    expect(normalizeShellTimeout(-5)).toBe(DEFAULT_SHELL_TIMEOUT_S);
    expect(normalizeShellTimeout(Number.NaN)).toBe(DEFAULT_SHELL_TIMEOUT_S);
    expect(normalizeShellTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SHELL_TIMEOUT_S);
  });
});
