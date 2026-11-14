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

/**
 * The schedule in words, for the places a person or a model reads it.
 *
 * `* * * * *` is a complete expression — every field is a wildcard, so it means every minute — but
 * printed bare it reads like a template whose value was never substituted. The record keeps the
 * literal expression (`expr` stays the source of truth, and `matchesCron` is what runs); this is only
 * the rendering. Anything not recognised returns the expression unchanged, because a wrong guess about
 * a schedule is worse than a terse one.
 *
 * Times are the minute the expression fires in, in the trigger's own timezone: cron has no notion of
 * "now", so nothing here resolves to an instant.
 */
export function describeCron(cronExpr: string): string {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return cronExpr;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const isEvery = (field: string) => field === '*' || field === '*/1';
  const asNumber = (field: string): number | null => {
    if (!/^\d+$/.test(field)) return null;
    const value = Number(field);
    return Number.isInteger(value) ? value : null;
  };
  const pad = (value: number) => String(value).padStart(2, '0');
  /** Interval forms (`*&#47;n`, `a-b&#47;n`) are read only in the plain `*&#47;n` shape below. */
  const everyN = (field: string): number | null => {
    const match = /^\*\/(\d+)$/.exec(field);
    const value = match ? Number(match[1]) : null;
    return value && value > 1 ? value : null;
  };

  const minuteEvery = everyN(minute);
  const hourEvery = everyN(hour);

  // Every minute: the case that started this.
  if (isEvery(minute) && isEvery(hour) && isEvery(day) && isEvery(month) && isEvery(weekday)) {
    return '每分钟';
  }
  if (minuteEvery && isEvery(hour) && isEvery(day) && isEvery(month) && isEvery(weekday)) {
    return `每 ${minuteEvery} 分钟`;
  }
  if (minute === '0' && isEvery(hour) && isEvery(day) && isEvery(month) && isEvery(weekday)) {
    return '每小时（整点）';
  }
  if (minute === '0' && hourEvery && isEvery(day) && isEvery(month) && isEvery(weekday)) {
    return `每 ${hourEvery} 小时（整点）`;
  }

  const minuteValue = asNumber(minute);
  const hourValue = asNumber(hour);
  const at = minuteValue !== null && hourValue !== null ? `${pad(hourValue)}:${pad(minuteValue)}` : null;
  // A specific time is what most schedules are; the day/month/weekday fields then qualify it.
  if (at && isEvery(day) && isEvery(month)) {
    if (isEvery(weekday)) return `每天 ${at}`;
    const weekdayValue = asNumber(weekday);
    if (weekdayValue !== null && weekdayValue >= 0 && weekdayValue <= 6) {
      return `每周${'日一二三四五六'[weekdayValue]} ${at}`;
    }
  }
  if (at && isEvery(month) && isEvery(weekday)) {
    const dayValue = asNumber(day);
    if (dayValue !== null && dayValue >= 1 && dayValue <= 31) return `每月 ${dayValue} 日 ${at}`;
  }
  if (at && isEvery(weekday)) {
    const dayValue = asNumber(day);
    const monthValue = asNumber(month);
    if (dayValue !== null && monthValue !== null) return `每年 ${monthValue} 月 ${dayValue} 日 ${at}`;
  }
  // Sub-hour intervals qualified by hour, e.g. `*/15 9-18 * * *` — say the minutes, keep the rest.
  if (minuteEvery && !isEvery(hour)) {
    return `每 ${minuteEvery} 分钟（${hour} 时）`;
  }
  return cronExpr;
}
