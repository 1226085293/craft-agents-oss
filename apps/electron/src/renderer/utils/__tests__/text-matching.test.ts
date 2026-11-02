import { describe, expect, it } from 'bun:test'
import { matchText } from '../text-matching'

describe('matchText', () => {
  it('counts all non-overlapping Chinese literal matches and returns highlight ranges', () => {
    expect(matchText('你好你好', '你好')).toEqual({
      count: 2,
      ranges: [0, 2, 2, 4],
      fuzzyScore: 2,
    })
  })

  it('returns fuzzy character ranges when exact literal matching misses', () => {
    expect(matchText('My Project', 'M Project')).toEqual({
      count: 1,
      ranges: [0, 1, 3, 10],
      fuzzyScore: 1,
    })
  })

  it('returns null when text does not match', () => {
    expect(matchText('Project', '你好')).toBeNull()
  })
})
