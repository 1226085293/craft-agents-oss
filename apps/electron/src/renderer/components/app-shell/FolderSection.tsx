/**
 * FolderSection
 *
 * The folder tree that lives UNDER the "All Sessions" nav item in the left
 * panel: the recursive tree and a trailing "new folder" row, with inline
 * create/rename editing. (The folder context menu and the delete dialog were
 * removed — folder management now lives in the navigator panel.)
 *
 * Deliberately self-contained: the caller only provides the folder API, the
 * currently selected folder and a selection callback. Routing stays in AppShell.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getUniqueFolderName, type FolderTreeNode } from '@craft-agent/shared/sessions/folder-tree'
import type { UseFoldersResult } from '../../hooks/useFolders'
import { FolderTree } from './FolderTree'
import { dragState } from './dragState'

/** In-place rename draft (the row's label becomes an input). */
interface InlineRenameDraft {
  folderId: string
  value: string
}

/** Characters a folder name cannot contain (Windows rules — the data lives on disk). */
const INVALID_NAME_CHARS = /[\/:*?"<>|]/


/** Local draft of the inline "new folder" editor (callbacks are composed below). */
interface InlineCreateDraft {
  parentId: string | null
  value: string
}

export interface FolderSectionProps {
  foldersApi: UseFoldersResult
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
  /** Folder of the currently selected session — its ancestor chain is auto-expanded (D3). */
  highlightFolderId?: string | null
  /** Project scope of this tree; null = All Sessions. */
  folderScopeProjectId?: string | null
  /** Drop a session (dragged from the session list) onto a folder (D31). */
  onDropSession?: (sessionId: string, folderId: string) => void
  /** Move a folder across scopes into this tree's target parent. */
  onDropFolderAcrossScopes?: (folderId: string, fromProjectId: string | null, targetParentId: string) => void
  /** Folder a session currently lives in, so "drop into the folder it is already in" reads as invalid. */
  getSessionFolderId?: (sessionId: string) => string | null | undefined
  /** Folders holding unread sessions — sorted first among siblings and badged. */
  unreadFolderIds?: ReadonlySet<string>
}

export interface FolderSectionHandle {
  /** Opens the inline "new folder" editor at the given parent scope. */
  openCreate: (parentId?: string | null) => void
  /** Collapses the specified folder branches after navigating to an ancestor. */
  collapseFolders: (folderIds: readonly string[]) => void
}

export const FolderSection = React.forwardRef<FolderSectionHandle, FolderSectionProps>(
  function FolderSection({ foldersApi, selectedFolderId, onSelectFolder, highlightFolderId, onDropSession, getSessionFolderId, unreadFolderIds, folderScopeProjectId = null, onDropFolderAcrossScopes }, ref): React.ReactElement {
  const { t } = useTranslation()
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set())
  const [inlineCreate, setInlineCreate] = React.useState<InlineCreateDraft | null>(null)
  const [renaming, setRenaming] = React.useState<InlineRenameDraft | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const committingNameRef = React.useRef(false)

  // D3: keep the selected session's ancestors expanded — the caller passes only the
  // folder id today, so selecting a folder expands its own chain lazily on click.
  const toggle = React.useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // D3: when the selected session moves, expand and highlight its folder chain.
  const highlightIds = React.useMemo(() => {
    if (!highlightFolderId) return new Set<string>()
    const byId = new Map(foldersApi.folders.map((folder) => [folder.id, folder]))
    const chain = new Set<string>()
    let cursor = byId.get(highlightFolderId)
    while (cursor) {
      chain.add(cursor.id)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    return chain
  }, [highlightFolderId, foldersApi.folders])

  React.useEffect(() => {
    if (highlightIds.size === 0) return
    setExpandedIds((prev) => {
      const next = new Set(prev)
      for (const id of highlightIds) next.add(id)
      return next
    })
  }, [highlightIds])

  const run = React.useCallback(async (work: () => Promise<void>) => {
    try {
      setError(null)
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Drop target for sessions and folders, routing by the dragged item's source scope. */
  const handleDropOnFolder = React.useCallback((folderId: string, event: React.DragEvent) => {
    const sessionId = event.dataTransfer.getData('application/x-craft-session')
    if (sessionId) {
      // Same scope + same folder = nothing to move. Say so instead of leaving
      // the user staring at a drop that appears to do nothing.
      if (dragState.projectId === folderScopeProjectId && dragState.sessionFolderId === folderId) {
        toast.info(t('folders.alreadyInFolder'))
        return
      }
      onDropSession?.(sessionId, folderId)
      return
    }
    const draggedFolderId = event.dataTransfer.getData('application/x-craft-folder')
    if (!draggedFolderId) return
    const fromProjectId = dragState.projectId
    if (fromProjectId !== folderScopeProjectId) {
      onDropFolderAcrossScopes?.(draggedFolderId, fromProjectId, folderId)
      return
    }
    if (draggedFolderId === folderId) return
    const dragged = foldersApi.folders.find((folder) => folder.id === draggedFolderId)
    if (!dragged) return
    const name = getUniqueFolderName(dragged.name, foldersApi.folders, folderId, dragged.id)
    if (name !== dragged.name && !window.confirm(t('folders.duplicateNameConfirm', { name: dragged.name, suggestedName: name }))) return
    void run(async () => { await foldersApi.moveFolder(draggedFolderId, folderId, name) })
  }, [foldersApi, folderScopeProjectId, onDropFolderAcrossScopes, onDropSession, run, t])

  // The folder tree has no header of its own — creation is triggered through
  // this handle (the panel's folder list and the project tree).
  React.useImperativeHandle(ref, () => ({
    openCreate: (parentId: string | null = null) => {
      setInlineCreate({ parentId, value: '' })
    },
    collapseFolders: (folderIds: readonly string[]) => {
      if (folderIds.length === 0) return
      setExpandedIds(prev => {
        const next = new Set(prev)
        for (const folderId of folderIds) next.delete(folderId)
        return next
      })
    },
  }), [])

  /**
   * Commit an in-place rename. Invalid names (blank, containing path/OS-illegal
   * characters simply cancel the edit; a sibling collision asks before applying
   * the suggested numeric suffix.
   */
  const commitRename = React.useCallback(() => {
    const draft = renaming
    if (!draft || committingNameRef.current) return
    const folder = foldersApi.folders.find((f) => f.id === draft.folderId)
    const name = draft.value.trim()
    if (!folder || !name || INVALID_NAME_CHARS.test(name) || name === folder.name) { setRenaming(null); return }
    const suggestedName = getUniqueFolderName(name, foldersApi.folders, folder.parentId, folder.id)
    if (suggestedName !== name && !window.confirm(t('folders.duplicateNameConfirm', { name, suggestedName }))) {
      setRenaming(null)
      return
    }
    committingNameRef.current = true
    void run(async () => {
      try {
        await foldersApi.renameFolder(draft.folderId, suggestedName)
        setRenaming(null)
      } finally {
        committingNameRef.current = false
      }
    })
  }, [renaming, foldersApi, run])

  /**
   * Resolve the "new folder" editor: a valid name creates the folder, anything
   * else (blank or OS-illegal characters) cancels the edit — losing focus is
   * treated as "done". Sibling collisions ask before applying a numeric suffix.
   */
  const commitInlineCreate = React.useCallback(() => {
    const current = inlineCreate
    if (!current || committingNameRef.current) return
    const name = current.value.trim()
    if (!name || INVALID_NAME_CHARS.test(name)) { setInlineCreate(null); return }
    const suggestedName = getUniqueFolderName(name, foldersApi.folders, current.parentId)
    if (suggestedName !== name && !window.confirm(t('folders.duplicateNameConfirm', { name, suggestedName }))) {
      setInlineCreate(null)
      return
    }
    committingNameRef.current = true
    void run(async () => {
      try {
        const created = await foldersApi.createFolder(suggestedName, current.parentId)
        // New folders have no children yet: expand the parent, never the new leaf.
        setExpandedIds((prev) => {
          const next = new Set(prev)
          next.delete(created.id)
          if (current.parentId) next.add(current.parentId)
          return next
        })
        setInlineCreate(null)
      } finally {
        committingNameRef.current = false
      }
    })
  }, [inlineCreate, foldersApi, run])

  // `foldersApi.tree` is built with `includeArchived: true` (the archive view
  // needs those nodes), so filtering only the roots left archived CHILDREN under
  // a live parent visible — a second path to a folder that was archived. Prune
  // the whole subtree instead.
  const visibleTree = React.useMemo(() => {
    const prune = (nodes: FolderTreeNode[]): FolderTreeNode[] =>
      nodes
        .filter((node) => !node.folder.archivedAt)
        .map((node) => ({ folder: node.folder, children: prune(node.children) }))
    return prune(foldersApi.tree)
  }, [foldersApi.tree])

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <FolderTree
        nodes={visibleTree}
        selectedFolderId={selectedFolderId}
        expandedIds={expandedIds}
        onSelect={onSelectFolder}
        onToggle={toggle}
        onDropOnFolder={handleDropOnFolder}
        folderScopeProjectId={folderScopeProjectId}
        getSessionFolderId={getSessionFolderId}
        unreadFolderIds={unreadFolderIds}
        emptyLabel={foldersApi.isLoading ? t('folders.loading') : t('folders.empty')}
        renaming={renaming ? {
          ...renaming,
          onChange: (value: string) => setRenaming({ ...renaming, value }),
          onCommit: commitRename,
          onCancel: () => setRenaming(null),
        } : null}
        inlineCreate={inlineCreate ? {
          ...inlineCreate,
          placeholder: t('folders.namePlaceholder'),
          onChange: (value: string) => setInlineCreate({ ...inlineCreate, value }),
          onCommit: commitInlineCreate,
          onCancel: () => setInlineCreate(null),
        } : null}
      />

      {foldersApi.error || error ? (
        <div className="mt-1 px-1 text-[11px] text-destructive">{foldersApi.error ?? error}</div>
      ) : null}
    </div>
  )
}

)
