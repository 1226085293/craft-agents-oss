import { describe, expect, it } from 'bun:test';

import { describeCron } from '../cron.ts';

/**
 * `describeCron` is a rendering, not a parser.
 *
 * The rule that matters: it must never claim a cadence the expression does not have. Anything it does
 * not recognise comes back unchanged, so a wrong label can only ever be a missing one.
 */

describe('describeCron', () => {
  it('says 每分钟 for the every-minute expression', () => {
    // The case that started this: `* * * * *` is complete — every field is a wildcard — but printed
    // bare it read like a template whose value was never substituted.
    expect(describeCron('* * * * *')).toBe('每分钟');
    expect(describeCron('*/1 * * * *')).toBe('每分钟');
  });

  it('says the interval when the minutes are a step', () => {
    expect(describeCron('*/5 * * * *')).toBe('每 5 分钟');
    expect(describeCron('*/15 * * * *')).toBe('每 15 分钟');
  });

  it('says the hour when the schedule is hourly', () => {
    expect(describeCron('0 * * * *')).toBe('每小时（整点）');
    expect(describeCron('0 */2 * * *')).toBe('每 2 小时（整点）');
  });

  it('says the clock time for a daily schedule', () => {
    expect(describeCron('0 9 * * *')).toBe('每天 09:00');
    expect(describeCron('30 18 * * *')).toBe('每天 18:30');
  });

  it('names the weekday', () => {
    expect(describeCron('0 9 * * 1')).toBe('每周一 09:00');
    expect(describeCron('0 9 * * 0')).toBe('每周日 09:00');
  });

  it('says the day of month and of year', () => {
    expect(describeCron('0 9 1 * *')).toBe('每月 1 日 09:00');
    expect(describeCron('0 9 1 6 *')).toBe('每年 6 月 1 日 09:00');
  });

  it('returns the expression when it does not recognise the shape', () => {
    // A near-miss must not be guessed at: a wrong cadence in words is worse than a terse expression.
    expect(describeCron('0 9 * * 1-5')).toBe('0 9 * * 1-5');
    expect(describeCron('0 9 1-15 * *')).toBe('0 9 1-15 * *');
    expect(describeCron('not a cron')).toBe('not a cron');
    expect(describeCron('0 9 * *')).toBe('0 9 * *');
  });

  it('keeps the interval visible when hours are narrowed', () => {
    // 「每 15 分钟」 alone would be a lie here: it only fires inside 9–18.
    expect(describeCron('*/15 9-18 * * *')).toBe('每 15 分钟（9-18 时）');
  });
});
