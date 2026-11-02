import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { buildSessionSearchPaths, filterSearchResultsBySessionIds } from '../search-scope'

const results = [
  { sessionId: 'in-scope-a', matchCount: 3, matches: [] },
  { sessionId: 'outside-scope', matchCount: 12, matches: [] },
  { sessionId: 'in-scope-b', matchCount: 1, matches: [] },
]

describe('buildSessionSearchPaths', () => {
  it('builds exact session.jsonl paths for allowed session IDs', () => {
    expect(buildSessionSearchPaths('/workspace/sessions', ['session-a', 'session-b']))
      .toEqual([
        join('/workspace/sessions', 'session-a', 'session.jsonl'),
        join('/workspace/sessions', 'session-b', 'session.jsonl'),
      ])
  })

  it('preserves the unscoped default and returns no paths for empty/invalid scopes', () => {
    expect(buildSessionSearchPaths('/workspace/sessions')).toBeUndefined()
    expect(buildSessionSearchPaths('/workspace/sessions', [])).toEqual([])
    expect(buildSessionSearchPaths('/workspace/sessions', ['*', '../outside'])).toEqual([])
  })
})

describe('filterSearchResultsBySessionIds', () => {
  it('keeps only results from the current directory tree', () => {
    expect(filterSearchResultsBySessionIds(results, ['in-scope-b', 'in-scope-a']))
      .toEqual([results[0], results[2]])
  })

  it('returns no results for an empty current scope', () => {
    expect(filterSearchResultsBySessionIds(results, [])).toEqual([])
  })

  it('preserves all results when no scope constraint is provided', () => {
    expect(filterSearchResultsBySessionIds(results)).toEqual(results)
  })
})
