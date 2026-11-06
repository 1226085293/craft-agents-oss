/**
 * Cron matching.
 *
 * One function, one job: does this expression fire in the minute `at` falls in?
 * Used by the task scheduler (cron-triggered tasks) and by the page refresh
 * loop. Deliberately not a scheduler — no timers here, callers own the cadence.
 */

import { Cron } from 'croner';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('cron');

/**
 * Check if a cron expression matches the minute containing `at`.
 *
 * @param cronExpr - 5-field expression (minute hour day-of-month month day-of-week)
 * @param timezone - Optional IANA timezone
 * @param at - The instant to evaluate (defaults to now); pass a tick timestamp
 *   so callers are deterministic in tests
 */
export function matchesCron(cronExpr: string, timezone?: string, at?: Date): boolean {
  try {
    const options = timezone ? { timezone } : {};
    const job = new Cron(cronExpr, options);
    const now = at ?? new Date();

    // Floor to the start of the minute: croner resolves to second precision, and
    // a tick can land anywhere inside the minute it represents.
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);

    const nextRun = job.nextRun(new Date(startOfMinute.getTime() - 1000));
    if (!nextRun) return false;

    return (
      nextRun.getTime() >= startOfMinute.getTime() &&
      nextRun.getTime() < startOfMinute.getTime() + 60_000
    );
  } catch (error) {
    // A malformed expression is a config error, not a crash.
    log.warn(`[cron] invalid expression "${cronExpr}"`, { error });
    return false;
  }
}
