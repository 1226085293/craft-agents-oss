/**
 * Time-limited model availability.
 *
 * The window is a scheduling rule, not a display hint: outside it the member is
 * removed from the plan. These pin the cases that are easy to get wrong — the
 * midnight crossing, the inclusive date bounds, and the fail-open behaviour that
 * keeps a typo from silently disabling a provider.
 */

import { describe, expect, test } from 'bun:test'
import { windowAllows, type ModelWindow } from '../model-window'

/** 2026-10-21 12:00 in Asia/Shanghai (UTC+8) → 04:00 UTC. */
const NOON_SH = Date.UTC(2026, 9, 21, 4, 0, 0)

const win = (over: Partial<ModelWindow> = {}): ModelWindow => ({
  tz: 'Asia/Shanghai',
  spans: [{ start: '09:00', end: '18:00' }],
  ...over,
})

describe('windowAllows — daily spans', () => {
  test('inside the span is allowed', () => {
    expect(windowAllows(win(), NOON_SH)).toBe(true)
  })

  test('outside the span is refused', () => {
    expect(windowAllows(win({ spans: [{ start: '13:00', end: '18:00' }] }), NOON_SH)).toBe(false)
  })

  test('the start is inclusive and the end exclusive', () => {
    expect(windowAllows(win({ spans: [{ start: '12:00', end: '13:00' }] }), NOON_SH)).toBe(true)
    expect(windowAllows(win({ spans: [{ start: '11:00', end: '12:00' }] }), NOON_SH)).toBe(false)
  })

  test('a span crossing midnight covers both sides of the day', () => {
    // 22:00–02:00 local: 23:30 allowed, 12:00 not.
    const late = Date.UTC(2026, 9, 21, 15, 30) // 23:30 SH
    expect(windowAllows(win({ spans: [{ start: '22:00', end: '02:00' }] }), late)).toBe(true)
    expect(windowAllows(win({ spans: [{ start: '22:00', end: '02:00' }] }), NOON_SH)).toBe(false)
  })

  test('several spans are OR-ed', () => {
    const w = win({ spans: [{ start: '08:00', end: '09:00' }, { start: '11:00', end: '14:00' }] })
    expect(windowAllows(w, NOON_SH)).toBe(true)
  })

  test('no spans means all day', () => {
    expect(windowAllows(win({ spans: [] }), NOON_SH)).toBe(true)
    expect(windowAllows({ tz: 'Asia/Shanghai' }, NOON_SH)).toBe(true)
  })
})

describe('windowAllows — dates and weekdays', () => {
  test('the from/to bounds are inclusive on the local date', () => {
    expect(windowAllows(win({ from: '2026-10-21', to: '2026-10-21' }), NOON_SH)).toBe(true)
    expect(windowAllows(win({ from: '2026-10-22' }), NOON_SH)).toBe(false)
    expect(windowAllows(win({ to: '2026-10-20' }), NOON_SH)).toBe(false)
  })

  test('the local date decides, not the UTC one', () => {
    // 2026-10-21 00:30 SH is still 2026-10-20 in UTC. A window starting on the
    // 21st must already be open.
    const justAfterMidnight = Date.UTC(2026, 9, 20, 16, 30)
    expect(windowAllows({ tz: 'Asia/Shanghai', from: '2026-10-21' }, justAfterMidnight)).toBe(true)
  })

  test('weekday filter uses the local weekday', () => {
    // 2026-10-21 is a Wednesday (ISO 3).
    expect(windowAllows(win({ days: [3] }), NOON_SH)).toBe(true)
    expect(windowAllows(win({ days: [1, 2] }), NOON_SH)).toBe(false)
  })

  test('a date-only window gates by date and stays open all day', () => {
    // The "free until the 31st" case: no daily slot at all, so the date bound is
    // the whole rule. 
    const w: ModelWindow = { tz: 'Asia/Shanghai', to: '2026-10-31' }
    expect(windowAllows(w, NOON_SH)).toBe(true)
    // 2026-11-01 12:00 SH (04:00 UTC) — one day past the bound.
    expect(windowAllows(w, Date.UTC(2026, 10, 1, 4, 0, 0))).toBe(false)
    // A future-only bound is closed until its date rather than always open.
    expect(windowAllows({ tz: 'Asia/Shanghai', from: '2026-10-22' }, NOON_SH)).toBe(false)
  })
})

describe('windowAllows — robustness', () => {
  test('no window at all is always allowed', () => {
    expect(windowAllows(undefined, NOON_SH)).toBe(true)
  })

  test('an unknown timezone fails open', () => {
    // A typo must not silently disable a working provider.
    expect(windowAllows({ tz: 'Not/AZone', spans: [{ start: '00:00', end: '00:01' }] }, NOON_SH)).toBe(true)
  })

  test('an unparseable span is ignored rather than refusing everything', () => {
    expect(windowAllows(win({ spans: [{ start: 'nope', end: '18:00' }] }), NOON_SH)).toBe(false)
  })

  test('a zero-length span never matches', () => {
    expect(windowAllows(win({ spans: [{ start: '12:00', end: '12:00' }] }), NOON_SH)).toBe(false)
  })
})
