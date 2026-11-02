/**
 * Folders hook
 *
 * Loads the folder tree for one scope (`projectId: null` = 「所有会话」root tree),
 * keeps it in sync through the `folders:changed` broadcast, and wraps the mutations
 * so components never talk to IPC directly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildFolderTree, type FolderTreeNode } from '@craft-agent/shared/sessions/folder-tree'
import type { FolderConfig, FolderScope } from '@craft-agent/shared/sessions/folders'

export interface UseFoldersResult {
  folders: FolderConfig[]
  tree: FolderTreeNode[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  createFolder: (name: string, parentId?: string | null) => Promise<FolderConfig>
  renameFolder: (id: string, name: string) => Promise<void>
  moveFolder: (id: string, parentId: string | null, name?: string) => Promise<void>
  archiveFolder: (id: string) => Promise<void>
  unarchiveFolder: (id: string) => Promise<void>
  deleteFolder: (id: string) => Promise<{ deletedFolders: string[]; deletedSessions: string[]; archivedSessions: string[] }>
  pinFolder: (id: string, pinned: boolean) => Promise<void>
  reorderFolder: (id: string, sortOrder: string) => Promise<void>
}

export function useFolders(workspaceId: string | null, scope: FolderScope): UseFoldersResult {
  const projectId = scope.projectId
  const [folders, setFolders] = useState<FolderConfig[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setFolders([])
      return
    }
    try {
      setIsLoading(true)
      const next = await window.electronAPI.listFolders(workspaceId, { projectId })
      setFolders(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId, projectId])

  // Load on mount / scope change.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Converge with other windows (D16). Only the matching scope triggers a reload.
  useEffect(() => {
    if (!workspaceId) return
    const cleanup = window.electronAPI.onFoldersChanged((changedWorkspaceId, changedScope) => {
      if (changedWorkspaceId !== workspaceId) return
      if ((changedScope?.projectId ?? null) !== projectId) return
      void refresh()
    })
    return cleanup
  }, [workspaceId, projectId, refresh])

  const tree = useMemo(() => {
    try {
      return buildFolderTree(folders, { includeArchived: true })
    } catch {
      return []
    }
  }, [folders])

  const createFolder = useCallback(async (name: string, parentId: string | null = null) => {
    if (!workspaceId) throw new Error('No workspace selected')
    const created = await window.electronAPI.createFolder(workspaceId, { projectId }, { name, parentId })
    await refresh()
    return created
  }, [workspaceId, projectId, refresh])

  const renameFolder = useCallback(async (id: string, name: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.renameFolder(workspaceId, { projectId }, { id, name })
    await refresh()
  }, [workspaceId, projectId, refresh])

  const moveFolder = useCallback(async (id: string, parentId: string | null, name?: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.moveFolder(workspaceId, { projectId }, { id, parentId, ...(name ? { name } : {}) })
    await refresh()
  }, [workspaceId, projectId, refresh])

  const archiveFolder = useCallback(async (id: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.archiveFolder(workspaceId, { projectId }, { id })
    await refresh()
  }, [workspaceId, projectId, refresh])

  const unarchiveFolder = useCallback(async (id: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.unarchiveFolder(workspaceId, { projectId }, { id })
    await refresh()
  }, [workspaceId, projectId, refresh])

  const deleteFolder = useCallback(async (id: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    const result = await window.electronAPI.deleteFolder(workspaceId, { projectId }, { id })
    await refresh()
    return result
  }, [workspaceId, projectId, refresh])

  const pinFolder = useCallback(async (id: string, pinned: boolean) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.pinFolder(workspaceId, { projectId }, { id, pinned })
    await refresh()
  }, [workspaceId, projectId, refresh])

  const reorderFolder = useCallback(async (id: string, sortOrder: string) => {
    if (!workspaceId) throw new Error('No workspace selected')
    await window.electronAPI.reorderFolder(workspaceId, { projectId }, { id, sortOrder })
    await refresh()
  }, [workspaceId, projectId, refresh])

  return {
    folders,
    tree,
    isLoading,
    error,
    refresh,
    createFolder,
    renameFolder,
    moveFolder,
    archiveFolder,
    unarchiveFolder,
    deleteFolder,
    pinFolder,
    reorderFolder,
  }
}
