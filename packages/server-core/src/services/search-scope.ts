import { join } from 'path'

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

export function buildSessionSearchPaths(
  sessionsDir: string,
  sessionIds?: readonly string[],
): string[] | undefined {
  if (sessionIds === undefined) return undefined
  return [...new Set(sessionIds)]
    .filter(sessionId => SAFE_SESSION_ID.test(sessionId))
    .map(sessionId => join(sessionsDir, sessionId, 'session.jsonl'))
}

export interface ScopedSearchResult {
  sessionId: string
}

export function filterSearchResultsBySessionIds<T extends ScopedSearchResult>(
  results: readonly T[],
  sessionIds?: readonly string[],
): T[] {
  if (sessionIds === undefined) return [...results]
  const allowedIds = new Set(sessionIds)
  return results.filter(result => allowedIds.has(result.sessionId))
}
