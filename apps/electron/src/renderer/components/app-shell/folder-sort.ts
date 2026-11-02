/**
 * Folder ordering for the sidebar.
 *
 * Priority, in order:
 * 1. pinned folders (most recently pinned first) — pinning always wins
 * 2. folders that contain unread sessions (at any depth)
 * 3. folder name, then id (stable)
 *
 * The tree builder sorts structurally (name only); unread state lives in the
 * renderer, so the ordering that depends on it is applied here, at render time.
 */

import type { FolderTreeNode } from '@craft-agent/shared/sessions/folder-tree'

export function compareFolderNodes(
  a: FolderTreeNode,
  b: FolderTreeNode,
  unreadFolderIds: ReadonlySet<string>,
): number {
  const aPinned = a.folder.pinnedAt ?? 0
  const bPinned = b.folder.pinnedAt ?? 0
  if (aPinned !== bPinned) return bPinned - aPinned

  const aUnread = unreadFolderIds.has(a.folder.id) ? 1 : 0
  const bUnread = unreadFolderIds.has(b.folder.id) ? 1 : 0
  if (aUnread !== bUnread) return bUnread - aUnread

  const byName = a.folder.name.localeCompare(b.folder.name)
  return byName !== 0 ? byName : a.folder.id.localeCompare(b.folder.id)
}

/** Same ordering for a flat list of folders (the second column's rows). */
export function compareFolders(
  a: { id: string; name: string; pinnedAt?: number },
  b: { id: string; name: string; pinnedAt?: number },
  unreadFolderIds: ReadonlySet<string>,
): number {
  const aPinned = a.pinnedAt ?? 0
  const bPinned = b.pinnedAt ?? 0
  if (aPinned !== bPinned) return bPinned - aPinned

  const aUnread = unreadFolderIds.has(a.id) ? 1 : 0
  const bUnread = unreadFolderIds.has(b.id) ? 1 : 0
  if (aUnread !== bUnread) return bUnread - aUnread

  const byName = a.name.localeCompare(b.name)
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

/** Sorts one level of the tree; children are sorted when their own level renders. */
export function sortFolderNodes(
  nodes: FolderTreeNode[],
  unreadFolderIds: ReadonlySet<string>,
): FolderTreeNode[] {
  return [...nodes].sort((a, b) => compareFolderNodes(a, b, unreadFolderIds))
}


/**
 * Session ordering for the list.
 *
 * 1. pinned sessions (most recently pinned first) — pinning outranks unread
 * 2. sessions with unread activity
 * 3. most recent message
 */
export interface OrderableSession {
  id: string
  pinnedAt?: number
  hasUnread?: boolean
  lastMessageAt?: number
}

export function compareSessions(a: OrderableSession, b: OrderableSession): number {
  const aPinned = a.pinnedAt ?? 0
  const bPinned = b.pinnedAt ?? 0
  if (aPinned !== bPinned) return bPinned - aPinned

  const aUnread = a.hasUnread ? 1 : 0
  const bUnread = b.hasUnread ? 1 : 0
  if (aUnread !== bUnread) return bUnread - aUnread

  const byTime = (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
}

export function orderSessions<T extends OrderableSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareSessions)
}
