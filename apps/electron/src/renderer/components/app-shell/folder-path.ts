export interface FolderPathEntry {
  id: string
  name: string
  parentId: string | null
}

function getFolderChain(folders: readonly FolderPathEntry[], folderId: string | null): FolderPathEntry[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const chain: FolderPathEntry[] = []
  let cursor = folderId ? byId.get(folderId) : undefined
  while (cursor) {
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain
}

/** A breadcrumb path ordered from the selected folder back to its optional scope base. */
export function getFolderPathParts(
  folders: readonly FolderPathEntry[],
  folderId: string | null,
  base?: string,
): string[] {
  const folderParts = getFolderChain(folders, folderId).map(folder => folder.name)
  if (folderParts.length === 0) return base ? [base] : []
  return [...folderParts.reverse(), ...(base ? [base] : [])]
}

/** IDs in the departed folder branch when navigating from a child to its ancestor. */
export function getFolderIdsToCollapseOnAncestorNavigation(
  folders: readonly FolderPathEntry[],
  currentFolderId: string | null,
  targetFolderId: string | null,
): string[] {
  if (!currentFolderId) return []
  const chain = getFolderChain(folders, currentFolderId)
  if (targetFolderId === null) return chain.map(folder => folder.id).reverse()
  const targetIndex = chain.findIndex(folder => folder.id === targetFolderId)
  return targetIndex < 0 ? [] : chain.slice(targetIndex + 1).map(folder => folder.id).reverse()
}
