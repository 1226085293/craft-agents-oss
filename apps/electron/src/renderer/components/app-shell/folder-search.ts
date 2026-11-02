import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import { matchText } from '@/utils/text-matching'

/** Returns active folders in the current scope's tree, excluding archived branches. */
export function getFolderSubtreeIds(
  folders: readonly FolderConfig[],
  scopeId: string | null,
): Set<string> {
  const ids = new Set<string>()
  const childrenByParent = new Map<string | null, FolderConfig[]>()
  for (const folder of folders) {
    const parentId = folder.parentId ?? null
    const siblings = childrenByParent.get(parentId) ?? []
    siblings.push(folder)
    childrenByParent.set(parentId, siblings)
  }

  const visit = (parentId: string | null) => {
    for (const folder of childrenByParent.get(parentId) ?? []) {
      if (folder.archivedAt) continue
      ids.add(folder.id)
      visit(folder.id)
    }
  }
  visit(scopeId)
  return ids
}

/** Returns matching folders anywhere under the current scope, excluding archived branches. */
export function filterFolderSearchResults(
  folders: readonly FolderConfig[],
  scopeId: string | null,
  query?: string,
): FolderConfig[] {
  const normalizedQuery = query?.trim()
  if (!normalizedQuery) {
    return folders.filter((folder) =>
      !folder.archivedAt && (folder.parentId ?? null) === (scopeId ?? null),
    )
  }

  const subtreeIds = getFolderSubtreeIds(folders, scopeId)
  return folders.filter((folder) =>
    subtreeIds.has(folder.id) && matchText(folder.name, normalizedQuery),
  )
}
