/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching. */
export type FilterMode = 'include' | 'exclude'

export interface InheritedNewSessionParams {
  status?: string
  label?: string
  project?: string
}

/** Minimal shape of the navigator filter the renderer uses to scope the session list. */
export interface NavigatorFilter {
  kind: string
  stateId?: string
  labelId?: string
  viewId?: string
}

const includeKeys = <K extends string>(m: Map<K, FilterMode>): K[] =>
  [...m.entries()].filter(([, mode]) => mode === 'include').map(([id]) => id)

/**
 * Resolve inheritance from the navigator's own filter (the list currently
 * shown in the sidebar). When the user creates a new session from a specific
 * status list (e.g. Backlog) or an individual label list, the new session
 * inherits that same status/label — so it lands in the current list instead of
 * jumping back to All Sessions.
 *
 * `labelId === '__all__'` (the "all labeled sessions" view) carries no single
 * label to inherit, so it returns null like every non-state non-label view.
 */
export function resolveInheritedNavigatorFilter(filter: NavigatorFilter | null | undefined): InheritedNewSessionParams | null {
  if (!filter) return null
  if (filter.kind === 'state' && filter.stateId) {
    return { status: filter.stateId }
  }
  if (filter.kind === 'label' && filter.labelId && filter.labelId !== '__all__') {
    return { label: filter.labelId }
  }
  return null
}

/**
 * Resolve the "inherit sole active filter" rule for new sessions.
 *
 * Only include-mode filters are inheritance candidates — an excluded
 * status/label/project must NEVER be inherited (#970: a lone `Done → exclude`
 * filter used to create new sessions as `Done`). Inherit only when exactly one
 * include filter is active across statuses + labels + projects; otherwise return
 * null and let the caller fall back to the workspace default status.
 */
export function resolveInheritedFilterParams<S extends string, L extends string, P extends string>(
  statusFilter: Map<S, FilterMode>,
  labelFilter: Map<L, FilterMode>,
  projectFilter: Map<P, FilterMode>
): InheritedNewSessionParams | null {
  const statusIncludes = includeKeys(statusFilter)
  const labelIncludes = includeKeys(labelFilter)
  const projectIncludes = includeKeys(projectFilter)
  const total = statusIncludes.length + labelIncludes.length + projectIncludes.length
  if (total !== 1) return null
  if (statusIncludes.length === 1) return { status: statusIncludes[0] }
  if (labelIncludes.length === 1) return { label: labelIncludes[0] }
  if (projectIncludes.length === 1) return { project: projectIncludes[0] }
  return null
}
