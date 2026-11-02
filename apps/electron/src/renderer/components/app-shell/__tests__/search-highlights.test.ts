import { describe, expect, it } from 'bun:test'
import { splitSearchHighlights } from '../search-highlights'

describe('splitSearchHighlights', () => {
  it('marks the first search occurrence active after ranges are collected', () => {
    const ranges = ['first', 'second', 'third']
    expect(splitSearchHighlights(ranges, 0)).toEqual({
      active: 'first',
      passive: ['second', 'third'],
    })
  })

  it('moves active styling to the selected occurrence', () => {
    expect(splitSearchHighlights(['first', 'second'], 1)).toEqual({
      active: 'second',
      passive: ['first'],
    })
  })

  it('keeps all ranges passive when the index is out of range', () => {
    expect(splitSearchHighlights(['first'], 5)).toEqual({
      active: null,
      passive: ['first'],
    })
  })
})
