import { describe, expect, it } from 'bun:test'
import { computeReorderSortOrder } from '../folder-tree.ts'

const siblings = (...orders: (string | undefined)[]) =>
  orders.map((sortOrder, index) => ({ id: `s${index}`, sortOrder }))

describe('computeReorderSortOrder', () => {
  it('inserting at the head lands before the first sibling', () => {
    const next = computeReorderSortOrder(siblings('B', 'C'), 0)
    expect(next < 'B').toBe(true)
  })

  it('inserting in the middle lands strictly between the neighbours', () => {
    const next = computeReorderSortOrder(siblings('A', 'C'), 1)
    expect(next > 'A').toBe(true)
    expect(next < 'C').toBe(true)
  })

  it('inserting at the tail lands after the last sibling', () => {
    const next = computeReorderSortOrder(siblings('A', 'C'), 2)
    expect(next > 'C').toBe(true)
  })

  it('an empty group still produces a usable key', () => {
    expect(typeof computeReorderSortOrder([], 0)).toBe('string')
    expect(computeReorderSortOrder([], 0).length).toBeGreaterThan(0)
  })

  it('clamps out-of-range indexes instead of producing an open bound', () => {
    const list = siblings('A', 'C')
    expect(computeReorderSortOrder(list, -5) < 'A').toBe(true)
    expect(computeReorderSortOrder(list, 99) > 'C').toBe(true)
  })

  it('falls back to the next bound when the previous sibling has no key', () => {
    const next = computeReorderSortOrder(siblings(undefined, 'C'), 1)
    expect(next < 'C').toBe(true)
  })
})
