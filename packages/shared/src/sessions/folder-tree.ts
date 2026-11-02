/**
 * Folder Tree Algorithms
 *
 * Pure, IO-free helpers for the session folder tree (`FolderConfig[]`).
 * Kept separate from `folders.ts` (storage) so both the server and the
 * renderer can share the exact same rules:
 *
 * - ancestry / descendant lookups (cycle prevention, path breadcrumbs)
 * - depth limit (≤ 5 levels, root = 0)
 * - manual ordering (string fractional index + pinning)
 * - archive subtree propagation
 * - drag-and-drop decisions
 *
 * All exports here must stay pure: no fs, no process state, no Date.now()
 * except via explicit parameters.
 */

import type { FolderConfig } from './folders.ts'

/** Hard nesting limit: root = 0, so `A/B/C/D/E` is depth 5 and is allowed. */
export const MAX_FOLDER_DEPTH = 5

/** ASCII-ordered alphabet — lexicographic order of the produced strings matches rank order. */
const BASE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function indexOfChar(char: string): number {
  const idx = BASE.indexOf(char)
  return idx < 0 ? 0 : idx
}

export function getFolderById(folders: readonly FolderConfig[], id: string | null | undefined): FolderConfig | undefined {
  if (!id) return undefined
  return folders.find((folder) => folder.id === id)
}

/** Return the requested name when free, otherwise the first available sibling suffix. */
export function getUniqueFolderName(
  name: string,
  folders: readonly FolderConfig[],
  parentId: string | null,
  excludeId?: string,
): string {
  const base = name.trim()
  const normalizedParentId = parentId ?? null
  const usedNames = new Set(folders
    .filter((folder) => folder.id !== excludeId && (folder.parentId ?? null) === normalizedParentId)
    .map((folder) => folder.name.toLowerCase()))
  if (!usedNames.has(base.toLowerCase())) return base
  let suffix = 2
  while (usedNames.has(`${base}-${suffix}`.toLowerCase())) suffix++
  return `${base}-${suffix}`
}

/** Ancestors from parent up to root (does not include `id` itself). Returns [] for root-level or unknown ids. */
export function getFolderAncestors(folders: readonly FolderConfig[], id: string | null | undefined): FolderConfig[] {
  const ancestors: FolderConfig[] = []
  let current = getFolderById(folders, id)
  const seen = new Set<string>()
  while (current?.parentId) {
    if (seen.has(current.parentId)) break // corrupt data: stop instead of looping forever
    seen.add(current.parentId)
    const parent = getFolderById(folders, current.parentId)
    if (!parent) break
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}

/** All descendant folder ids (children, grandchildren, …). Does not include `id`. */
export function getDescendantFolderIds(folders: readonly FolderConfig[], id: string): string[] {
  const result: string[] = []
  const queue = [id]
  const seen = new Set<string>([id])
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const folder of folders) {
      if (folder.parentId !== current || seen.has(folder.id)) continue
      seen.add(folder.id)
      result.push(folder.id)
      queue.push(folder.id)
    }
  }
  return result
}

export function isFolderAncestor(folders: readonly FolderConfig[], ancestorId: string, descendantId: string): boolean {
  if (ancestorId === descendantId) return false
  return getFolderAncestors(folders, descendantId).some((folder) => folder.id === ancestorId)
}

/** Depth of a folder: root-level = 1. Unknown ids return 0. */
export function getFolderDepth(folders: readonly FolderConfig[], id: string | null | undefined): number {
  if (!id) return 0
  const folder = getFolderById(folders, id)
  if (!folder) return 0
  return getFolderAncestors(folders, id).length + 1
}

/** Readable path from root to the folder itself, e.g. ['工程', 'Craft']. Unknown ids → []. */
export function getFolderPath(folders: readonly FolderConfig[], id: string | null | undefined): string[] {
  if (!id) return []
  const folder = getFolderById(folders, id)
  if (!folder) return []
  return [...getFolderAncestors(folders, id).reverse().map((f) => f.name), folder.name]
}

/**
 * Resolve a readable path back to a folder id, deepest match first.
 * Used when un-archiving after the original parent was deleted/renamed.
 * Same-name ambiguity resolves to the shallowest candidate (stable, predictable).
 */
export function resolveDeepestExistingAncestor(folders: readonly FolderConfig[], path: readonly string[]): string | null {
  if (path.length === 0) return null

  // Walk top-down keeping every candidate chain; at the end take the deepest.
  let candidates: FolderConfig[] = folders.filter((folder) => folder.name === path[0] && !folder.parentId)
  let best: FolderConfig | null = candidates[0] ?? null

  for (let depth = 1; depth < path.length; depth++) {
    const name = path[depth]
    const next: FolderConfig[] = []
    for (const candidate of candidates) {
      for (const folder of folders) {
        if (folder.parentId === candidate.id && folder.name === name) next.push(folder)
      }
    }
    if (next.length === 0) break
    candidates = next
    best = next[0] ?? best
  }

  return best?.id ?? null
}

/** A folder is "archived" when its own `archivedAt` is set (children inherit via propagation, not via this check). */
export function isFolderArchived(folder: Pick<FolderConfig, 'archivedAt'> | undefined): boolean {
  return !!folder?.archivedAt
}

export type FolderMoveRejection =
  | 'not-found'
  | 'target-not-found'
  | 'target-archived'
  | 'folder-archived'
  | 'target-is-same-scope'
  | 'duplicate-name'
  | 'cycle'
  | 'depth'

export type FolderMoveValidation = { ok: true; noop: boolean } | { ok: false; reason: FolderMoveRejection }

/** Validate a folder re-parent request. `newParentId === null` means "move to root". */
export function validateFolderMove(
  folders: readonly FolderConfig[],
  id: string,
  newParentId: string | null,
  newName?: string,
): FolderMoveValidation {
  const folder = getFolderById(folders, id)
  if (!folder) return { ok: false, reason: 'not-found' }

  if (newParentId) {
    const target = getFolderById(folders, newParentId)
    if (!target) return { ok: false, reason: 'target-not-found' }
    if (isFolderArchived(target)) return { ok: false, reason: 'target-archived' }
    if (newParentId === id || isFolderAncestor(folders, id, newParentId)) {
      return { ok: false, reason: 'cycle' }
    }
  }

  const targetName = (newName ?? folder.name).trim()
  const normalizedParentId = newParentId ?? null
  const nameCollision = folders.some((candidate) =>
    candidate.id !== id
    && (candidate.parentId ?? null) === normalizedParentId
    && candidate.name.toLowerCase() === targetName.toLowerCase(),
  )
  if (nameCollision) return { ok: false, reason: 'duplicate-name' }

  const noop = (folder.parentId ?? null) === normalizedParentId && folder.name === targetName
  if (noop) return { ok: true, noop: true }

  const parentDepth = newParentId ? getFolderDepth(folders, newParentId) : 0
  const subtreeDepth = subtreeHeight(folders, id)
  if (parentDepth + subtreeDepth > MAX_FOLDER_DEPTH) return { ok: false, reason: 'depth' }

  return { ok: true, noop: false }
}

/** Height of a subtree: a leaf is 1. */
export function subtreeHeight(folders: readonly FolderConfig[], id: string): number {
  const children = folders.filter((folder) => folder.parentId === id)
  if (children.length === 0) return 1
  return 1 + Math.max(...children.map((child) => subtreeHeight(folders, child.id)))
}

// ---------------------------------------------------------------------------
// Manual ordering (D32 / D33 / D36)
// ---------------------------------------------------------------------------

export type SiblingKind = 'folder' | 'session'

export interface SortableSibling {
  id: string
  sortOrder?: string
  pinnedAt?: number
  /** Folder fallback */
  name?: string
  /** Session fallback */
  lastMessageAt?: number
  createdAt?: number
}

/**
 * The one and only sibling comparator.
 * 1) pinned items first (most recently pinned on top)
 * 2) explicit sortOrder
 * 3) deterministic fallback (folder name asc / session lastMessage desc)
 */
export function compareSiblings(a: SortableSibling, b: SortableSibling, kind: SiblingKind): number {
  if (a.pinnedAt && b.pinnedAt && a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt
  if (a.pinnedAt && !b.pinnedAt) return -1
  if (!a.pinnedAt && b.pinnedAt) return 1

  if (a.sortOrder && b.sortOrder && a.sortOrder !== b.sortOrder) {
    return a.sortOrder < b.sortOrder ? -1 : 1
  }
  if (a.sortOrder && !b.sortOrder) return -1
  if (!a.sortOrder && b.sortOrder) return 1

  if (kind === 'folder') {
    const byName = (a.name ?? '').localeCompare(b.name ?? '')
    return byName !== 0 ? byName : a.id.localeCompare(b.id)
  }
  const aTime = a.lastMessageAt ?? a.createdAt ?? 0
  const bTime = b.lastMessageAt ?? b.createdAt ?? 0
  if (aTime !== bTime) return bTime - aTime
  return a.id.localeCompare(b.id)
}

/**
 * Build a fractional index strictly between `prev` and `next`.
 * Both bounds are optional (undefined = open end). Never throws, never exhausts.
 */
export function midpointSortOrder(prev?: string, next?: string): string {
  const lo = prev ?? ''
  const hi = next ?? ''
  let result = ''
  let index = 0
  // Guard against pathological inputs (non-terminating) — 64 chars is plenty.
  while (index < 64) {
    const lowDigit = index < lo.length ? indexOfChar(lo[index]!) : 0
    const highDigit = index < hi.length ? indexOfChar(hi[index]!) : BASE.length
    if (highDigit - lowDigit > 1) {
      return result + BASE[Math.floor((lowDigit + highDigit) / 2)]!
    }
    result += BASE[lowDigit]!
    index++
  }
  return result + BASE[Math.floor(BASE.length / 2)]!
}

/** Sort key for appending an item to the end of its type group. */
export function appendSortOrder(siblings: readonly Pick<SortableSibling, 'sortOrder'>[]): string {
  let last: string | undefined
  for (const sibling of siblings) {
    const order = sibling.sortOrder
    if (order && (!last || order > last)) last = order
  }
  return midpointSortOrder(last, undefined)
}

/**
 * Turn a drop position into the `sortOrder` the dragged sibling should carry.
 *
 * `ordered` is the target group **without** the dragged item, already in display
 * order; `insertIndex` is the gap it should land in (`0` = before the first
 * sibling, `ordered.length` = after the last one). Reordering is a pure
 * fractional-index computation so the UI never rewrites its neighbours.
 */
export function computeReorderSortOrder(
  ordered: readonly Pick<SortableSibling, 'sortOrder'>[],
  insertIndex: number,
): string {
  const index = Math.max(0, Math.min(insertIndex, ordered.length))
  const prev = index > 0 ? ordered[index - 1]?.sortOrder : undefined
  const next = index < ordered.length ? ordered[index]?.sortOrder : undefined

  if (prev && next) return midpointSortOrder(prev, next)
  if (next) return midpointSortOrder(undefined, next)
  if (prev) return midpointSortOrder(prev, undefined)
  return appendSortOrder(ordered.slice(0, index))
}

/**
 * Ordered children of one parent: folders group first, sessions group second (D32).
 * Group boundaries are structural — never derived from sortOrder.
 */
/** Ordered children of one parent: folders group first, sessions group second (D32). */
export interface FolderTreeNode {
  folder: FolderConfig
  children: FolderTreeNode[]
}

/**
 * Build the nested folder tree. Archived folders are excluded from the active tree
 * by default; the archive tree asks for them explicitly.
 */
export function buildFolderTree(
  folders: readonly FolderConfig[],
  options?: { includeArchived?: boolean },
): FolderTreeNode[] {
  const includeArchived = options?.includeArchived ?? false
  const visible = folders.filter((folder) => includeArchived || !folder.archivedAt)
  const nodes = new Map<string, FolderTreeNode>()
  for (const folder of visible) nodes.set(folder.id, { folder, children: [] })

  const roots: FolderTreeNode[] = []
  for (const node of nodes.values()) {
    const parentId = node.folder.parentId
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortNodes = (list: FolderTreeNode[]) => {
    list.sort((a, b) => compareSiblings(
      { id: a.folder.id, sortOrder: a.folder.sortOrder, pinnedAt: a.folder.pinnedAt, name: a.folder.name },
      { id: b.folder.id, sortOrder: b.folder.sortOrder, pinnedAt: b.folder.pinnedAt, name: b.folder.name },
      'folder',
    ))
    for (const node of list) sortNodes(node.children)
  }
  sortNodes(roots)
  return roots
}

/** Minimal session shape the archive tree needs. */
export interface ArchiveSessionLike {
  id: string
  name?: string
  folderId?: string | null
  isArchived?: boolean
  archivedAt?: number
  archivedByParent?: string
  archivedFolderPath?: string[]
  projectId?: string
  sortOrder?: string
  pinnedAt?: number
  lastMessageAt?: number
  createdAt?: number
}

export interface ArchiveProjectLike {
  id: string
  name: string
  /** true when ProjectConfig.archivedAt is set */
  archived?: boolean
}

export interface ArchiveTreeNode {
  kind: 'project' | 'folder'
  /** Namespaced key — folder ids are only unique inside one scope (D35). */
  key: string
  id: string
  name: string
  projectId: string | null
  /** Original readable path, shown as a tooltip when the parents are not archived. */
  path?: string[]
  children: ArchiveTreeNode[]
  sessions: ArchiveSessionLike[]
}

export interface ArchiveTreeResult {
  /** Archived projects first, then archived folders with no archived ancestor. */
  nodes: ArchiveTreeNode[]
  /** Archived sessions that do not live under an archived container. */
  sessions: ArchiveSessionLike[]
}

/**
 * Build the mixed「已归档」tree (D10/D24): archived projects act as root folders,
 * archived folders nest when their ancestors are archived too, and sessions attach
 * to the nearest archived ancestor — otherwise they fall back to the archive root.
 */
export function buildArchiveTree(input: {
  projects: readonly ArchiveProjectLike[]
  foldersByScope: readonly { projectId: string | null; folders: readonly FolderConfig[] }[]
  sessions: readonly ArchiveSessionLike[]
}): ArchiveTreeResult {
  const archivedProjects = new Map<string, ArchiveProjectLike>()
  for (const project of input.projects) if (project.archived) archivedProjects.set(project.id, project)

  const nodes = new Map<string, ArchiveTreeNode>()
  const folderScope = new Map<string, string | null>() // folder key → projectId
  const foldersById = new Map<string, FolderConfig>()

  for (const scope of input.foldersByScope) {
    for (const folder of scope.folders) {
      const key = `${scope.projectId ?? 'root'}:${folder.id}`
      folderScope.set(key, scope.projectId ?? null)
      foldersById.set(key, folder)
    }
  }

  for (const project of archivedProjects.values()) {
    nodes.set(`project:${project.id}`, {
      kind: 'project',
      key: `project:${project.id}`,
      id: project.id,
      name: project.name,
      projectId: project.id,
      children: [],
      sessions: [],
    })
  }

  const findAncestorNode = (folder: FolderConfig, projectId: string | null): ArchiveTreeNode | null => {
    let parentId = folder.parentId
    while (parentId) {
      const key = `${projectId ?? 'root'}:${parentId}`
      const node = nodes.get(key)
      if (node) return node
      const parent = foldersById.get(key)
      if (!parent) return null
      parentId = parent.parentId
    }
    return null
  }

  const sortedFolders = [...foldersById.entries()]
    .map(([key, folder]) => ({ key, projectId: folderScope.get(key) ?? null, folder }))
    .filter(({ folder }) => !!folder.archivedAt)
    .sort((a, b) => compareSiblings(
      { id: a.folder.id, sortOrder: a.folder.sortOrder, pinnedAt: a.folder.pinnedAt, name: a.folder.name },
      { id: b.folder.id, sortOrder: b.folder.sortOrder, pinnedAt: b.folder.pinnedAt, name: b.folder.name },
      'folder',
    ))

  const pathForKey = (key: string): string[] => {
    const scopePrefix = `${folderScope.get(key) ?? 'root'}:`
    const parts: string[] = []
    const seen = new Set<string>()
    let cursor = foldersById.get(key)
    while (cursor && !seen.has(`${scopePrefix}${cursor.id}`)) {
      seen.add(`${scopePrefix}${cursor.id}`)
      parts.unshift(cursor.name)
      cursor = cursor.parentId ? foldersById.get(`${scopePrefix}${cursor.parentId}`) : undefined
    }
    return parts
  }

  for (const { key, projectId, folder } of sortedFolders) {
    if (nodes.has(key)) continue
    nodes.set(key, {
      kind: 'folder',
      key,
      id: folder.id,
      name: folder.name,
      projectId,
      path: pathForKey(key),
      children: [],
      sessions: [],
    })
  }

  // Link each archived folder to its nearest archived ancestor, a project node, or the root.
  const roots: ArchiveTreeNode[] = []
  for (const [key, node] of nodes) {
    if (node.kind !== 'folder') continue
    const folder = foldersById.get(key)!
    const ancestor = findAncestorNode(folder, node.projectId)
    if (ancestor) {
      ancestor.children.push(node)
    } else if (node.projectId && archivedProjects.has(node.projectId)) {
      nodes.get(`project:${node.projectId}`)?.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Project nodes whose root has no archived folder still belong in the tree.
  for (const [key, node] of nodes) {
    if (node.kind === 'project' && !roots.includes(node) && !hasAncestorInRoots(node)) {
      roots.push(node)
    }
  }

  const rootSessions: ArchiveSessionLike[] = []
  for (const session of input.sessions) {
    if (!session.isArchived) continue
    let target: ArchiveTreeNode | null = null
    let cursor = session.folderId ?? null
    while (cursor) {
      const key = `${session.projectId ?? 'root'}:${cursor}`
      target = nodes.get(key) ?? null
      if (target) break
      const folder = foldersById.get(key)
      cursor = folder?.parentId ?? null
    }
    if (!target && session.projectId && archivedProjects.has(session.projectId)) {
      target = nodes.get(`project:${session.projectId}`) ?? null
    }
    if (target) target.sessions.push(session)
    else rootSessions.push(session)
  }

  const sortNode = (node: ArchiveTreeNode) => {
    node.sessions.sort((a, b) => (b.archivedAt ?? b.lastMessageAt ?? 0) - (a.archivedAt ?? a.lastMessageAt ?? 0))
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of node.children) sortNode(child)
  }
  for (const node of roots) sortNode(node)
  rootSessions.sort((a, b) => (b.archivedAt ?? b.lastMessageAt ?? 0) - (a.archivedAt ?? a.lastMessageAt ?? 0))

  return { nodes: roots, sessions: rootSessions }

  function hasAncestorInRoots(node: ArchiveTreeNode): boolean {
    return roots.some((root) => root.children.includes(node))
  }
}

export function buildOrderedChildren<TFolder extends SortableSibling, TSession extends SortableSibling>(
  folders: readonly TFolder[],
  sessions: readonly TSession[],
): { folders: TFolder[]; sessions: TSession[] } {
  const byFolder = [...folders].sort((a, b) => compareSiblings(a, b, 'folder'))
  const bySession = [...sessions].sort((a, b) => compareSiblings(a, b, 'session'))
  return { folders: byFolder, sessions: bySession }
}

// ---------------------------------------------------------------------------
// Drag & drop decisions (D31)
// ---------------------------------------------------------------------------

export type DragItem =
  | {
      kind: 'session'
      id: string
      folderId?: string | null
      projectId?: string | null
      archived?: boolean
    }
  | {
      kind: 'folder'
      id: string
      parentId: string | null
      projectId?: string | null
      archived?: boolean
    }

export type DropTarget =
  | { kind: 'folder'; id: string; projectId?: string | null; archived?: boolean }
  | { kind: 'list'; parentId: string | null; projectId?: string | null; archived?: boolean }
  | { kind: 'archive' }

export type DropAction = 'move' | 'reorder' | 'archive' | 'unarchive'

export type DropDecision =
  | { ok: true; action: DropAction; toFolderId: string | null; changesArchive: boolean }
  | { ok: false; reason: 'session-as-parent' | 'cycle' | 'depth' | 'not-found' | 'archived-target' }

/**
 * Single source of truth for the drag-and-drop matrix.
 * The UI must call this and render only the returned action; it must not
 * re-implement any of these rules.
 */
export function canDrop(
  item: DragItem,
  target: DropTarget,
  folders: readonly FolderConfig[],
): DropDecision {
  const itemArchived = !!item.archived

  if (target.kind === 'archive') {
    if (itemArchived) return { ok: false, reason: 'archived-target' }
    return { ok: true, action: 'archive', toFolderId: null, changesArchive: true }
  }

  const targetArchived = !!target.archived

  if (item.kind === 'folder') {
    if (target.kind === 'folder' && target.id === item.id) {
      return { ok: false, reason: 'cycle' }
    }
    if (target.kind === 'folder' && isFolderAncestor(folders, item.id, target.id)) {
      return { ok: false, reason: 'cycle' }
    }
    const parentId = target.kind === 'folder' ? target.id : target.parentId
    const validation = validateFolderMove(folders, item.id, parentId)
    if (!validation.ok) {
      if (validation.reason === 'depth') return { ok: false, reason: 'depth' }
      if (validation.reason === 'cycle') return { ok: false, reason: 'cycle' }
      return { ok: false, reason: 'not-found' }
    }
    return {
      ok: true,
      action: itemArchived && !targetArchived ? 'unarchive' : 'move',
      toFolderId: parentId,
      changesArchive: itemArchived !== targetArchived,
    }
  }

  // Sessions can never become a parent — dropping onto a session is handled by the list
  // as a reorder gesture, never as a nesting operation.
  if (target.kind === 'folder' && item.folderId && item.folderId === target.id && itemArchived === targetArchived) {
    return { ok: true, action: 'reorder', toFolderId: target.id, changesArchive: false }
  }

  return {
    ok: true,
    action: itemArchived && !targetArchived ? 'unarchive' : 'move',
    toFolderId: target.kind === 'folder' ? target.id : target.parentId,
    changesArchive: itemArchived !== targetArchived,
  }
}

/**
 * Collect the archive subtree for a folder (D22).
 * Returns folder ids that must be flipped to archived and the sessions
 * belonging to those folders (caller decides which sessions are already archived).
 */
export function collectArchiveSubtree(
  folders: readonly FolderConfig[],
  folderId: string,
): { folderIds: string[]; sessionFolderIds: string[] } {
  const folderIds = [folderId, ...getDescendantFolderIds(folders, folderId)]
  return { folderIds, sessionFolderIds: folderIds }
}

/** Ids that un-archiving should restore: only children that were archived through this ancestor (D23). */
export function collectUnarchiveSubtree(
  folders: readonly FolderConfig[],
  folderId: string,
): string[] {
  return getDescendantFolderIds(folders, folderId).filter((id) => {
    const folder = getFolderById(folders, id)
    return folder?.archivedByParent === folderId
  })
}
