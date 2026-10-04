/**
 * Shell tool timeout normalization.
 *
 * The Pi SDK's bash `timeout` parameter is in SECONDS, but models routinely
 * supply millisecond values (e.g. 120000 intending 120 s). Passing those
 * through unchecked gives a ~33-hour "timeout" that never fires (2026-10-04
 * incident: only the 60-min turn guardrail ended the call). Every value
 * flowing into the SDK is normalized here:
 *
 *   - undefined / 0 / negative / non-finite → DEFAULT_SHELL_TIMEOUT_S
 *   - value >= 1000 → treated as milliseconds, divided by 1000
 *   - result clamped to [1, MAX_SHELL_TIMEOUT_S]
 */
export const DEFAULT_SHELL_TIMEOUT_S = 300;
export const MAX_SHELL_TIMEOUT_S = 300;

export function normalizeShellTimeout(timeout: number | undefined): number {
  let seconds = timeout ?? DEFAULT_SHELL_TIMEOUT_S;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SHELL_TIMEOUT_S;
  // A value >= 1000 "seconds" is almost certainly a millisecond value.
  if (seconds >= 1000) seconds = Math.round(seconds / 1000);
  return Math.min(Math.max(seconds, 1), MAX_SHELL_TIMEOUT_S);
}
