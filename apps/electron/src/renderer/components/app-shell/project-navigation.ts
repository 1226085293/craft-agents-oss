export interface ProjectNavigationEntry {
  id: string
  slug: string
}

/**
 * Keep an entered project scope alive while opening that same project's detail
 * route from the mode-2 settings action.
 */
export function getEnteredProjectDetailScopeId(
  enteredProjectId: string | null,
  detailProjectSlug: string | null | undefined,
  projects: readonly ProjectNavigationEntry[],
): string | null {
  if (!enteredProjectId || !detailProjectSlug) return null
  const enteredProject = projects.find(project => project.id === enteredProjectId)
  return enteredProject?.slug === detailProjectSlug ? enteredProject.id : null
}
