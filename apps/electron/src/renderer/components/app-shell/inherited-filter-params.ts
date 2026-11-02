/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching. */
export type FilterMode = 'include' | 'exclude'

export interface InheritedNewSessionParams {
  project?: string
  /** Folder scope the user is currently browsing; new sessions land inside it. */
  folder?: string
}

/**
 * Resolve the "inherit sole active filter" rule for new sessions.
 *
 * Only include-mode filters are inheritance candidates — an excluded
 * project must NEVER be inherited (#970: a lone `Done → exclude` filter used
 * to create new sessions as `Done`). Inherit only when exactly one include
 * filter is active; otherwise return null and let the caller fall back to the
 * workspace defaults.
 *
 * Folder scope is inherited independently: creating from a folder-scoped list
 * must keep the session in that folder, otherwise the list it was created from
 * filters it out immediately.
 */
export function resolveInheritedFilterParams<P extends string>(
  projectFilter: Map<P, FilterMode>,
  folderScope?: { folderId: string | null; projectId?: string | null },
): InheritedNewSessionParams | null {
  const projectIncludes = [...projectFilter.entries()]
    .filter(([, mode]) => mode === 'include')
    .map(([id]) => id)
  const inheritedProject = projectIncludes.length === 1 ? projectIncludes[0] : undefined

  if (folderScope?.folderId) {
    // Folder ids are scope-local, so the owning project must travel with it.
    const project = folderScope.projectId ?? inheritedProject
    return project ? { project, folder: folderScope.folderId } : { folder: folderScope.folderId }
  }

  return inheritedProject ? { project: inheritedProject } : null
}
