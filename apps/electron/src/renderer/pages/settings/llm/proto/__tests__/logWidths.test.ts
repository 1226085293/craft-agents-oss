/**
 * Column sizing rules for the log table. These pin the arithmetic that the
 * component used to carry inline, where a wrong bound showed up only as a
 * screenshot anomaly (columns locked at their max, or squeezed to "gp…").
 */

import { describe, test, expect } from 'bun:test'
import {
  columnLimits,
  displayWidths,
  fillerWidth,
  HARD_MAX,
  HARD_MIN,
  MAX_SLACK,
  type WidthLimits,
} from '../logWidths'

/** min/fit/max triple with the derived max filled in. */
const lim = (min: number, fit: number, max = Math.round(fit * MAX_SLACK)): WidthLimits => ({
  min,
  fit,
  max,
})

describe('columnLimits', () => {
  test('min is the shortest value, fit the longest, max 1.5x fit', () => {
    const limits = columnLimits({ header: 46, values: [72, 129, 108] })
    expect(limits.min).toBe(72)
    expect(limits.fit).toBe(129)
    expect(limits.max).toBe(194)
  })

  test('max is exactly MAX_SLACK x fit, not the raw longest value', () => {
    const limits = columnLimits({ header: 46, values: [200, 400] })
    expect(limits.fit).toBe(400)
    expect(limits.max).toBe(Math.round(400 * MAX_SLACK))
    expect(limits.max).toBe(600)
  })

  test('every bound stays ordered: min <= fit <= max', () => {
    for (const values of [[10], [10, 10], [40, 900], [300, 12], []]) {
      const l = columnLimits({ header: 46, values })
      expect(l.min).toBeLessThanOrEqual(l.fit)
      expect(l.fit).toBeLessThanOrEqual(l.max)
    }
  })

  test('a column whose values are all the same length: min == fit, still draggable', () => {
    // Every request hits the same model: no width truncates some rows and not
    // others, so min == fit is correct. max is still 1.5x, so the column can be
    // widened — it is not locked.
    const limits = columnLimits({ header: 46, values: [129, 129, 129] })
    expect(limits.min).toBe(129)
    expect(limits.fit).toBe(129)
    expect(limits.max).toBe(194)
  })

  test('the heading wins when it is wider than every value', () => {
    // "状态码" (39px) is wider than "200" (30px): the title must not truncate.
    const limits = columnLimits({ header: 59, values: [50, 50] })
    expect(limits.min).toBe(59)
    expect(limits.fit).toBe(59)
    expect(limits.max).toBe(89)
  })

  test('a short value never pulls min below the heading', () => {
    const limits = columnLimits({ header: 59, values: [20, 300] })
    expect(limits.min).toBe(59)
    expect(limits.fit).toBe(300)
    expect(limits.max).toBe(450)
  })

  test('no rows: the heading defines the bounds', () => {
    const limits = columnLimits({ header: 46, values: [] })
    expect(limits.min).toBe(46)
    expect(limits.fit).toBe(46)
    expect(limits.max).toBe(69)
  })

  test('never reports a fit below its min, nor a max below fit', () => {
    const limits = columnLimits({ header: 200, values: [50] })
    expect(limits.fit).toBeGreaterThanOrEqual(limits.min)
    expect(limits.max).toBeGreaterThanOrEqual(limits.fit)
  })

  test('stays inside the sanity bounds', () => {
    expect(columnLimits({ header: 5, values: [5] }).min).toBe(HARD_MIN)
    const huge = columnLimits({ header: 1, values: [5000] })
    expect(huge.fit).toBe(HARD_MAX)
    expect(huge.max).toBe(HARD_MAX)
  })

  test('slack never pushes max past the hard cap', () => {
    const limits = columnLimits({ header: 1, values: [600] })
    expect(limits.fit).toBe(600)
    expect(limits.max).toBe(HARD_MAX)
  })

  test('fractions round up so nothing is clipped by a subpixel', () => {
    const limits = columnLimits({ header: 46.2, values: [72.4, 129.1] })
    expect(limits.min).toBe(73)
    expect(limits.fit).toBe(130)
    expect(limits.max).toBe(195)
  })
})

describe('displayWidths', () => {
  const limits: Record<string, WidthLimits> = {
    time: lim(113, 113),
    model: lim(72, 129),
    session: lim(46, 103),
  }
  const ids = ['time', 'model', 'session']

  test('returns the stored widths when the container is unmeasured', () => {
    const widths = { time: 113, model: 129, session: 103 }
    expect(displayWidths({ widths, limits, ids, touched: [], containerW: 0 })).toEqual(widths)
  })

  test('auto-fill stops at fit — the content width, not the 1.5x ceiling', () => {
    // 300px of slack, but auto-fill only ever grows a column to its fit.
    const out = displayWidths({
      widths: { time: 113, model: 72, session: 103 },
      limits,
      ids,
      touched: [],
      containerW: 600,
    })
    expect(out.model).toBe(129)
    expect(out.time).toBe(113)
    expect(out.session).toBe(103)
  })

  test('auto-fill never uses the 1.5x headroom on its own', () => {
    const wide = displayWidths({
      widths: { time: 113, model: 72, session: 103 },
      limits,
      ids,
      touched: [],
      containerW: 1200,
    })
    expect(wide.model).toBe(129)
    expect(wide.time).toBe(113)
    expect(wide.session).toBe(103)
  })

  test('splits slack across the columns that have headroom', () => {
    const wide = { a: lim(50, 100), b: lim(50, 200) }
    const out = displayWidths({
      widths: { a: 50, b: 50 },
      limits: wide,
      ids: ['a', 'b'],
      touched: [],
      containerW: 200,
    })
    // 100px slack, headroom 50 vs 150 -> a += 25, b += 75.
    expect(out.a).toBe(75)
    expect(out.b).toBe(125)
  })

  test('a dragged column keeps exactly the width the user gave it', () => {
    const out = displayWidths({
      widths: { time: 113, model: 60, session: 103 },
      limits,
      ids,
      touched: ['model'],
      containerW: 800,
    })
    expect(out.model).toBe(60)
  })

  test('slack goes to the remaining columns when one was dragged', () => {
    const out = displayWidths({
      widths: { a: 50, b: 50 },
      limits: { a: lim(50, 200), b: lim(50, 200) },
      ids: ['a', 'b'],
      touched: ['a'],
      containerW: 200,
    })
    expect(out.a).toBe(50)
    expect(out.b).toBe(150)
  })

  test('overflowing the container leaves every width untouched', () => {
    const widths = { time: 113, model: 129, session: 103 }
    expect(displayWidths({ widths, limits, ids, touched: [], containerW: 200 })).toEqual(widths)
  })

  test('no headroom anywhere: nothing is stretched', () => {
    const fixed = { a: lim(100, 100), b: lim(100, 100) }
    const out = displayWidths({
      widths: { a: 100, b: 100 },
      limits: fixed,
      ids: ['a', 'b'],
      touched: [],
      containerW: 900,
    })
    expect(out).toEqual({ a: 100, b: 100 })
  })

  test('a hidden column contributes no width and gets no slack', () => {
    const out = displayWidths({
      widths: { time: 113, model: 72, session: 103 },
      limits,
      ids: ['time', 'model'],
      touched: [],
      containerW: 400,
    })
    expect(out.session).toBe(103)
    expect(out.model).toBe(129)
  })
})

describe('fillerWidth', () => {
  test('absorbs whatever the columns left over', () => {
    expect(fillerWidth({ a: 100, b: 100 }, ['a', 'b'], 500)).toBe(300)
  })

  test('is zero when the table already fills or overflows', () => {
    expect(fillerWidth({ a: 300, b: 300 }, ['a', 'b'], 500)).toBe(0)
  })

  test('ignores columns that are not visible', () => {
    expect(fillerWidth({ a: 100, b: 999 }, ['a'], 500)).toBe(400)
  })
})
