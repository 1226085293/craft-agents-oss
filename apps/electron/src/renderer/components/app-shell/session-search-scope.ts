export interface FolderScopedSession {
  folderId?: string | null
}

export function filterContentSearchResultsBySessionIds<T>(
  results: ReadonlyMap<string, T>,
  allowedSessionIds: ReadonlySet<string>,
): Map<string, T> {
  return new Map([...results].filter(([sessionId]) => allowedSessionIds.has(sessionId)))
}

export function filterSessionsByFolderSearchScope<T extends FolderScopedSession>(
  sessions: readonly T[],
  scopeId: string | null,
  descendantFolderIds: ReadonlySet<string>,
  validFolderIds: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => {
    const folderId = session.folderId ?? null
    const resolvedFolderId = folderId && validFolderIds.has(folderId) ? folderId : null
    if (resolvedFolderId === null) return scopeId === null
    return resolvedFolderId === scopeId || descendantFolderIds.has(resolvedFolderId)
  })
}

/** Filters sessions to one folder, treating ids outside the active tree as root sessions. */
export function filterSessionsByFolderScope<T extends FolderScopedSession>(
  sessions: readonly T[],
  scopeId: string | null,
  validFolderIds: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => {
    const folderId = session.folderId ?? null
    const resolvedFolderId = folderId && validFolderIds.has(folderId) ? folderId : null
    return resolvedFolderId === scopeId
  })
}
