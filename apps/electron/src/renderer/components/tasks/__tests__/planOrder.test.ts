import { describe, expect, it } from 'bun:test'

/**
 * Plan rows are displayed by id path, not by insertion order.
 *
 * A worker appends as it discovers: the outline first, then one sub-step per
 * section when it gets there. The stored array therefore reads
 * `1, 2, 3, 4, 1.1, 2.1, 3.1, 4.1`, and rendering it verbatim put `1.1` under
 * section 4 — which reads as "the plan is structured wrong" when it is only stored
 * in a different order than it is meant to be read.
 */
function byPath(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  const depth = Math.max(left.length, right.length)
  for (let i = 0; i < depth; i += 1) {
    const x = left[i] ?? -1
    const y = right[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

describe('plan display order', () => {
  it('puts each sub-step under its own outline', () => {
    const stored = ['1', '2', '3', '4', '1.1', '2.1', '3.1', '4.1']
    expect([...stored].sort(byPath)).toEqual(['1', '1.1', '2', '2.1', '3', '3.1', '4', '4.1'])
  })

  it('sorts numerically, not lexically', () => {
    // `10` must come after `9`; a string sort would put it after `1`.
    expect(['10', '2', '1', '9'].sort(byPath)).toEqual(['1', '2', '9', '10'])
  })

  it('keeps deeper steps after their parent', () => {
    expect(['1.2', '1', '1.10', '1.1'].sort(byPath)).toEqual(['1', '1.1', '1.2', '1.10'])
  })

  it('does not depend on the input already being ordered', () => {
    const shuffled = ['3.1', '1', '2.1', '3', '1.1', '2']
    expect([...shuffled].sort(byPath)).toEqual(['1', '1.1', '2', '2.1', '3', '3.1'])
  })
})
