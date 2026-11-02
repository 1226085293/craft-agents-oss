import { fuzzyFilter } from '@craft-agent/shared/search'

export interface TextMatch {
  count: number
  /** Flat sequence of [start, end) pairs, suitable for composing highlighted spans. */
  ranges: number[]
  fuzzyScore: number
}

export function matchText(text: string, query: string): TextMatch | null {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return null

  const lowerText = text.toLowerCase()
  const lowerQuery = normalizedQuery.toLowerCase()
  const ranges: number[] = []
  let fromIndex = 0
  while (fromIndex <= lowerText.length - lowerQuery.length) {
    const index = lowerText.indexOf(lowerQuery, fromIndex)
    if (index < 0) break
    ranges.push(index, index + lowerQuery.length)
    fromIndex = index + lowerQuery.length
  }
  if (ranges.length > 0) {
    const count = ranges.length / 2
    return { count, ranges, fuzzyScore: count }
  }

  const fuzzy = fuzzyFilter([text], normalizedQuery, value => value)[0]
  if (!fuzzy) return null
  return {
    count: 1,
    ranges: fuzzy.ranges ?? [],
    fuzzyScore: fuzzy.score,
  }
}
