/**
 * Session Folder Storage
 *
 * Filesystem-backed folder trees for sessions. One tree per scope (D13):
 *
 *   {workspaceRootPath}/folders/config.json           ← 「所有会话」根树
 *   {workspaceRootPath}/projects/{slug}/folders.json  ← 项目私有树
 *
 * The tree is intentionally NOT seeded: an empty workspace has no folders.
 * Folder ids are slugs generated at creation time and never change afterwards,
 * so sessions/archived paths can reference them safely across renames.
 *
 * All mutations re-read the config from disk before writing (multi-window
 * safety) and persist through an atomic write.
 */

import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts'
import { generateUniqueSlug } from '../utils/slug.ts'
import { debug } from '../utils/debug.ts'
import { loadProjectById } from '../projects/storage.ts'
import {
  appendSortOrder,
  getDescendantFolderIds,
  getFolderById,
  getFolderPath,
  getFolderDepth,
  midpointSortOrder,
  subtreeHeight,
  validateFolderMove,
  type FolderMoveRejection,
} from './folder-tree.ts'

export interface FolderConfig {
  /** Slug generated at creation time. Immutable — renaming never changes it. */
  id: string
  name: string
  /** null = root level */
  parentId: string | null
  createdAt: number
  updatedAt: number
  // Archive (D22 / D28)
  /** Set when the folder itself (or an ancestor) was archived. */
  archivedAt?: number
  /** undefined = archived on its own; folder id / `project:{id}` = archived because an ancestor was. */
  archivedByParent?: string
  /** Snapshot of `parentId` at archive time (restore hint). */
  archivedParentId?: string | null
  /** Readable path of the parent at archive time. */
  archivedParentPath?: string[]
  // Ordering (D32 / D33)
  /** Fractional index; only compared among siblings of the same kind. */
  sortOrder?: string
  /** Non-null = pinned; pinned siblings sort first (most recent first). */
  pinnedAt?: number
}

export interface WorkspaceFolderConfig {
  version: 1
  folders: FolderConfig[]
}

/** One tree = one scope. `projectId: null` is the 「所有会话」 root tree. */
export interface FolderScope {
  projectId: string | null
}

const FOLDER_CONFIG_FILE = join('folders', 'config.json')
const PROJECT_FOLDER_CONFIG_FILE = 'folders.json'

export function emptyFolderConfig(): WorkspaceFolderConfig {
  return { version: 1, folders: [] }
}

/** Absolute path of the folder config backing this scope. Throws when the project is missing. */
export function getFolderConfigPath(workspaceRootPath: string, scope: FolderScope): string {
  if (!scope.projectId) {
    return join(workspaceRootPath, FOLDER_CONFIG_FILE)
  }
  const project = loadProjectById(workspaceRootPath, scope.projectId)
  if (!project) {
    throw new Error(`Cannot resolve folder config: project ${scope.projectId} not found`)
  }
  return join(workspaceRootPath, 'projects', project.config.slug, PROJECT_FOLDER_CONFIG_FILE)
}

export function loadFolderConfig(workspaceRootPath: string, scope: FolderScope): WorkspaceFolderConfig {
  const configPath = getFolderConfigPath(workspaceRootPath, scope)
  if (!existsSync(configPath)) return emptyFolderConfig()

  try {
    const config = readJsonFileSync<WorkspaceFolderConfig>(configPath)
    if (!config || !Array.isArray(config.folders)) return emptyFolderConfig()
    return { version: 1, folders: config.folders }
  } catch (error) {
    // Corrupt file: never destroy it silently — surface in debug log and start empty.
    debug('[loadFolderConfig] Failed to parse folder config:', error)
    return emptyFolderConfig()
  }
}

export function saveFolderConfig(
  workspaceRootPath: string,
  scope: FolderScope,
  config: WorkspaceFolderConfig,
): void {
  const configPath = getFolderConfigPath(workspaceRootPath, scope)
  const dir = dirname(configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  atomicWriteFileSync(configPath, JSON.stringify({ version: 1, folders: config.folders }, null, 2))
}

/** Re-read → mutate → write. Keeps concurrent windows from clobbering each other's trees. */
function mutateFolderConfig(
  workspaceRootPath: string,
  scope: FolderScope,
  mutate: (config: WorkspaceFolderConfig) => void,
): WorkspaceFolderConfig {
  const config = loadFolderConfig(workspaceRootPath, scope)
  mutate(config)
  saveFolderConfig(workspaceRootPath, scope, config)
  return config
}

function siblingsOf(config: WorkspaceFolderConfig, parentId: string | null): FolderConfig[] {
  return config.folders.filter((folder) => (folder.parentId ?? null) === parentId)
}

function assertUniqueSiblingName(
  folders: readonly FolderConfig[],
  name: string,
  parentId: string | null,
  excludeId?: string,
): void {
  const duplicate = folders.some((folder) =>
    folder.id !== excludeId
    && (folder.parentId ?? null) === (parentId ?? null)
    && folder.name.toLowerCase() === name.toLowerCase(),
  )
  if (duplicate) throw new Error(`Folder name already exists: ${name}`)
}

export interface CreateFolderInput {
  name: string
  parentId?: string | null
}

export function createFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  input: CreateFolderInput,
): FolderConfig {
  const parentId = input.parentId ?? null
  const name = input.name.trim()
  if (!name) throw new Error('Folder name is required')

  let created: FolderConfig | undefined
  mutateFolderConfig(workspaceRootPath, scope, (config) => {
    if (parentId) {
      const parent = getFolderById(config.folders, parentId)
      if (!parent) throw new Error(`Parent folder ${parentId} not found`)
      if (parent.archivedAt) throw new Error('Cannot create a folder inside an archived folder')
      if (getFolderDepth(config.folders, parentId) >= 5) {
        throw new Error('Folder nesting limit reached (max 5 levels)')
      }
    }
    assertUniqueSiblingName(config.folders, name, parentId)
    const existingSlugs = new Set(config.folders.map((folder) => folder.id))
    const now = Date.now()
    created = {
      id: generateUniqueSlug(name, existingSlugs, 'folder'),
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
      sortOrder: appendSortOrder(siblingsOf(config, parentId)),
    }
    config.folders.push(created)
  })

  return created!
}

export function renameFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
  name: string,
): FolderConfig {
  const nextName = name.trim()
  if (!nextName) throw new Error('Folder name is required')

  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const folder = getFolderById(next.folders, id)
    if (!folder) throw new Error(`Folder ${id} not found`)
    assertUniqueSiblingName(next.folders, nextName, folder.parentId, id)
    folder.name = nextName
    folder.updatedAt = Date.now()
  })

  return getFolderById(config.folders, id)!
}

export type MoveFolderResult =
  | { ok: true; folder: FolderConfig }
  | { ok: false; reason: FolderMoveRejection }

export function moveFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
  parentId: string | null,
  name?: string,
): MoveFolderResult {
  const existing = loadFolderConfig(workspaceRootPath, scope)
  const validation = validateFolderMove(existing.folders, id, parentId, name)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const existingFolder = getFolderById(existing.folders, id)!
  const nextName = (name ?? existingFolder.name).trim()
  if (validation.noop) return { ok: true, folder: existingFolder }

  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const folder = getFolderById(next.folders, id)
    if (!folder) throw new Error(`Folder ${id} not found`)
    assertUniqueSiblingName(next.folders, nextName, parentId, id)
    folder.parentId = parentId
    folder.name = nextName
    folder.updatedAt = Date.now()
    // Moving into a new parent places it at the end of that folder group (D36).
    folder.sortOrder = appendSortOrder(siblingsOf(next, parentId).filter((f) => f.id !== id))
  })

  return { ok: true, folder: getFolderById(config.folders, id)! }
}

/**
 * Move a folder subtree across scopes (D13): the subtree is removed from the
 * source scope's config file and re-rooted (parentId: null, sortOrder appended)
 * in the target scope's config file. Sessions are rebound by the caller
 * (SessionManager) — this function only rewrites the two config files.
 */
export function moveFolderToScope(
  workspaceRootPath: string,
  fromScope: FolderScope,
  id: string,
  toScope: FolderScope,
  parentId: string | null = null,
  name?: string,
): MoveFolderResult & { folderIdMap?: Record<string, string> } {
  if (fromScope.projectId === toScope.projectId) {
    // Same scope: plain reparent-to-root is the closest equivalent, but the
    // caller never needs it — refuse to keep the contract sharp.
    return { ok: false, reason: 'target-is-same-scope' }
  }

  const source = loadFolderConfig(workspaceRootPath, fromScope)
  const moved = getFolderById(source.folders, id)
  if (!moved) return { ok: false, reason: 'not-found' }
  if (moved.archivedAt) return { ok: false, reason: 'folder-archived' }

  const target = loadFolderConfig(workspaceRootPath, toScope)
  let targetParent: FolderConfig | undefined
  if (parentId) {
    targetParent = getFolderById(target.folders, parentId)
    if (!targetParent) return { ok: false, reason: 'target-not-found' }
    if (targetParent.archivedAt) return { ok: false, reason: 'target-archived' }
  }

  const subtreeIds = new Set([id, ...getDescendantFolderIds(source.folders, id)])
  const subtree = source.folders.filter((folder) => subtreeIds.has(folder.id))
  const targetDepth = parentId ? getFolderDepth(target.folders, parentId) : 0
  if (targetDepth + subtreeHeight(source.folders, id) > 5) return { ok: false, reason: 'depth' }
  const nextName = (name ?? moved.name).trim()
  if (!nextName) throw new Error('Folder name is required')
  if (siblingsOf(target, parentId).some((folder) => folder.name.toLowerCase() === nextName.toLowerCase())) {
    return { ok: false, reason: 'duplicate-name' }
  }

  // Folder IDs are unique only within a scope; populate this from the freshly
  // re-read target config inside mutateFolderConfig to avoid a race with another window.
  const folderIdMap: Record<string, string> = {}

  // Append into the destination first. This way a target write failure cannot
  // remove the source subtree and leave the folder missing from both trees.
  let movedRoot: FolderConfig | undefined
  mutateFolderConfig(workspaceRootPath, toScope, (next) => {
    let targetParentNow: FolderConfig | undefined
    if (parentId) {
      targetParentNow = getFolderById(next.folders, parentId)
      if (!targetParentNow) throw new Error(`Parent folder ${parentId} not found`)
      if (targetParentNow.archivedAt) throw new Error('Cannot move a folder inside an archived folder')
    }
    const targetDepthNow = parentId ? getFolderDepth(next.folders, parentId) : 0
    if (targetDepthNow + subtreeHeight(source.folders, id) > 5) throw new Error('Folder nesting limit reached (max 5 levels)')
    assertUniqueSiblingName(next.folders, nextName, parentId)
    const usedIds = new Set(next.folders.map((folder) => folder.id))
    for (const folder of subtree) {
      const nextId = usedIds.has(folder.id) ? generateUniqueSlug(folder.id, usedIds, 'folder') : folder.id
      folderIdMap[folder.id] = nextId
      usedIds.add(nextId)
    }
    for (const folder of subtree) {
      const isSubtreeRoot = folder.id === id
      const mapped: FolderConfig = {
        ...folder,
        id: folderIdMap[folder.id]!,
        name: isSubtreeRoot ? nextName : folder.name,
        parentId: isSubtreeRoot ? parentId : (folder.parentId ? folderIdMap[folder.parentId] ?? folder.parentId : null),
        archivedByParent: folder.archivedByParent ? folderIdMap[folder.archivedByParent] ?? folder.archivedByParent : undefined,
        archivedParentId: isSubtreeRoot ? undefined : folder.archivedParentId ? folderIdMap[folder.archivedParentId] ?? folder.archivedParentId : folder.archivedParentId,
        archivedParentPath: isSubtreeRoot ? undefined : folder.archivedParentPath,
        pinnedAt: isSubtreeRoot ? undefined : folder.pinnedAt,
        sortOrder: isSubtreeRoot ? appendSortOrder(siblingsOf(next, parentId)) : folder.sortOrder,
        updatedAt: Date.now(),
      }
      next.folders.push(mapped)
      if (isSubtreeRoot) movedRoot = mapped
    }
    // Guard the whole target tree, not just the subtree: duplicate folder IDs
    // would make the tree ambiguous (getFolderById picks the first match) and
    // render the same branch twice. Throwing here aborts before the write.
    const uniqueIds = new Set<string>()
    for (const folder of next.folders) {
      if (uniqueIds.has(folder.id)) throw new Error(`Folder ID collision: ${folder.id}`)
      uniqueIds.add(folder.id)
    }
  })

  try {
    mutateFolderConfig(workspaceRootPath, fromScope, (next) => {
      next.folders = next.folders.filter((folder) => !subtreeIds.has(folder.id))
    })
  } catch (error) {
    const movedIds = new Set(Object.values(folderIdMap))
    mutateFolderConfig(workspaceRootPath, toScope, (next) => {
      next.folders = next.folders.filter((folder) => !movedIds.has(folder.id))
    })
    throw error
  }

  return { ok: true, folder: movedRoot!, folderIdMap }
}

export function pinFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
  pinned: boolean,
): FolderConfig {
  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const folder = getFolderById(next.folders, id)
    if (!folder) throw new Error(`Folder ${id} not found`)
    folder.pinnedAt = pinned ? Date.now() : undefined
    folder.updatedAt = Date.now()
    // Pinning never clears sortOrder: unpinning must restore the previous slot (D33).
  })
  return getFolderById(config.folders, id)!
}

export function reorderFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
  sortOrder: string,
): FolderConfig {
  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const folder = getFolderById(next.folders, id)
    if (!folder) throw new Error(`Folder ${id} not found`)
    folder.sortOrder = sortOrder
    folder.updatedAt = Date.now()
  })
  return getFolderById(config.folders, id)!
}

/** Sort key for dropping a folder between two siblings (either bound may be undefined). */
export function folderSortOrderBetween(prev?: string, next?: string): string {
  return midpointSortOrder(prev, next)
}

export interface ArchiveFolderResult {
  /** The archived folder itself. */
  folder: FolderConfig
  /** Folder ids flipped to archived (includes the root of the subtree). */
  folderIds: string[]
  /** Readable path of the folder itself, for UI/event payloads. */
  path: string[]
}

/**
 * Archive a folder and its whole subtree (D22).
 * Sessions are NOT touched here — SessionManager archives them so it can run the
 * full event/persistence pipeline. `archivedByParent` records *why* each child is
 * archived, so un-archiving only restores what this call swept up (D23).
 */
export function archiveFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
): ArchiveFolderResult {
  const before = loadFolderConfig(workspaceRootPath, scope)
  const root = getFolderById(before.folders, id)
  if (!root) throw new Error(`Folder ${id} not found`)

  const path = getFolderPath(before.folders, id)
  const now = Date.now()

  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const foldersToArchive = [id, ...getDescendantFolderIds(next.folders, id)]
    for (const folderId of foldersToArchive) {
      const folder = getFolderById(next.folders, folderId)
      if (!folder || folder.archivedAt) continue
      folder.archivedAt = now
      folder.archivedByParent = folderId === id ? undefined : id
      folder.updatedAt = now
      if (folderId === id) {
        folder.archivedParentId = folder.parentId
        folder.archivedParentPath = getFolderPath(next.folders, folder.parentId)
      }
    }
  })

  return {
    folder: getFolderById(config.folders, id)!,
    folderIds: [id, ...getDescendantFolderIds(config.folders, id)],
    path,
  }
}

export interface UnarchiveFolderResult {
  folder: FolderConfig
  /** Folders restored by this call (excludes ones archived independently). */
  folderIds: string[]
}

/**
 * Un-archive a folder (D23): only children whose `archivedByParent` points at this
 * folder are restored. `parentId` falls back to root when the original parent is
 * gone or still archived (Q8).
 */
export function unarchiveFolder(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
): UnarchiveFolderResult {
  const before = loadFolderConfig(workspaceRootPath, scope)
  const root = getFolderById(before.folders, id)
  if (!root) throw new Error(`Folder ${id} not found`)

  const parent = root.archivedParentId ? getFolderById(before.folders, root.archivedParentId) : undefined
  const targetParentId = parent && !parent.archivedAt ? parent.id : null

  const config = mutateFolderConfig(workspaceRootPath, scope, (next) => {
    const restored: string[] = []
    for (const folder of next.folders) {
      const isRoot = folder.id === id
      const sweptByThis = folder.archivedByParent === id
      if (!isRoot && !sweptByThis) continue
      folder.archivedAt = undefined
      folder.archivedByParent = undefined
      folder.updatedAt = Date.now()
      if (isRoot) {
        folder.parentId = targetParentId
        folder.archivedParentId = undefined
        folder.archivedParentPath = undefined
        // Restore the folder to its previous position when possible: same parent
        // and no sort-key collision with a live sibling. Fall back to appending
        // only when the original slot is gone, so unarchive stays idempotent
        // across fail/retry cycles instead of drifting on every restore.
        const siblings = siblingsOf(next, targetParentId).filter((f) => f.id !== id)
        const sameParent = (root.archivedParentId ?? null) === targetParentId
        const previousOrder = folder.sortOrder
        const collides = previousOrder
          ? siblings.some((sibling) => sibling.sortOrder === previousOrder)
          : true
        folder.sortOrder = sameParent && previousOrder && !collides
          ? previousOrder
          : appendSortOrder(siblings)
      }
      restored.push(folder.id)
    }
  })

  return {
    folder: getFolderById(config.folders, id)!,
    folderIds: [id, ...getDescendantFolderIds(config.folders, id)].filter((folderId) => {
      const folder = getFolderById(config.folders, folderId)
      return !!folder && !folder.archivedAt
    }),
  }
}

/**
 * Remove a folder subtree from the config. Sessions are deleted by SessionManager
 * (D2) — this only drops the structural entries, children first.
 */
export function deleteFolderConfig(
  workspaceRootPath: string,
  scope: FolderScope,
  id: string,
): { deletedFolderIds: string[] } {
  const before = loadFolderConfig(workspaceRootPath, scope)
  if (!getFolderById(before.folders, id)) throw new Error(`Folder ${id} not found`)

  const deletedFolderIds = [id, ...getDescendantFolderIds(before.folders, id)]
  const toDelete = new Set(deletedFolderIds)

  mutateFolderConfig(workspaceRootPath, scope, (next) => {
    next.folders = next.folders.filter((folder) => !toDelete.has(folder.id))
  })

  return { deletedFolderIds }
}

/** All known folder ids for a scope — used by SessionManager to normalize dangling folderId (D17). */
export function getFolderIdSet(workspaceRootPath: string, scope: FolderScope): Set<string> {
  return new Set(loadFolderConfig(workspaceRootPath, scope).folders.map((folder) => folder.id))
}
