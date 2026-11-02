/**
 * FolderSection
 *
 * The folder tree that lives UNDER the "All Sessions" nav item in the left
 * panel: the recursive tree, a trailing "new folder" row, a lightweight context
 * menu and inline create/rename/delete dialogs.
 *
 * Deliberately self-contained: the caller only provides the folder API, the
 * currently selected folder and a selection callback. Routing stays in AppShell.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FolderPlus } from 'lucide-react'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import { getUniqueFolderName } from '@craft-agent/shared/sessions/folder-tree'
import type { UseFoldersResult } from '../../hooks/useFolders'
import { FolderTree } from './FolderTree'
import { claimMenu, releaseMenu, subscribeMenu } from './menuRegistry'
import { dragState } from './dragState'

type DialogState =
  | { type: 'delete'; folder: FolderConfig; confirmValue: string }
  | null

/** In-place rename draft (the row's label becomes an input). */
interface InlineRenameDraft {
  folderId: string
  value: string
}

/** Characters a folder name cannot contain (Windows rules — the data lives on disk). */
const INVALID_NAME_CHARS = /[\/:*?"<>|]/


interface MenuState {
  x: number
  y: number
  folder: FolderConfig
}

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
  /** Opens the create dialog (used by the "New Folder" context-menu action). */
  openCreate: (parentId?: string | null) => void
  /** Collapses the specified folder branches after navigating to an ancestor. */
  collapseFolders: (folderIds: readonly string[]) => void
}

export const FolderSection = React.forwardRef<FolderSectionHandle, FolderSectionProps>(
  function FolderSection({ foldersApi, selectedFolderId, onSelectFolder, highlightFolderId, onDropSession, getSessionFolderId, unreadFolderIds, folderScopeProjectId = null, onDropFolderAcrossScopes }, ref): React.ReactElement {
  const { t } = useTranslation()
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set())
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [inlineCreate, setInlineCreate] = React.useState<InlineCreateDraft | null>(null)
  const [renaming, setRenaming] = React.useState<InlineRenameDraft | null>(null)
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const [busy, setBusy] = React.useState(false)
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

  const closeMenu = React.useCallback(() => setMenu(null), [])

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

  React.useEffect(() => {
    if (!menu) return
    // A menu opened by right-clicking while another one closes can receive that
    // other menu's dismissal events; ignore anything in the first few frames.
    const openedAt = Date.now()
    const handler = () => { if (Date.now() - openedAt < 150) return; closeMenu() }
    window.addEventListener('click', handler)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('click', handler)
      window.removeEventListener('keydown', handler)
    }
  }, [menu, closeMenu])
  // Only one menu in the app may be open: this menu claims the slot while it is
  // visible, and any other menu claiming it closes this one.
  const menuId = React.useId()

  React.useEffect(() => {
    if (!menu) return
    claimMenu(menuId)
    return () => releaseMenu(menuId)
  }, [menu, menuId])

  React.useEffect(() => subscribeMenu((activeId) => {
    // null = "the slot freed up" — that includes this menu re-opening (its own
    // release fires before the re-claim), so only react to a *different* menu.
    if (activeId && activeId !== menuId) setMenu(null)
  }), [menuId])

  const run = React.useCallback(async (work: () => Promise<void>) => {
    try {
      setBusy(true)
      setError(null)
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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

  const submitDialog = React.useCallback(() => {
    if (!dialog) return
    if (dialog.type === 'delete') {
      void run(async () => {
        await foldersApi.deleteFolder(dialog.folder.id)
        if (selectedFolderId === dialog.folder.id) onSelectFolder(null)
        setDialog(null)
      })
    }
  }, [dialog, foldersApi, onSelectFolder, run, selectedFolderId, t])

  // The folder tree has no header of its own any more — creation is triggered from
  // the "All Sessions" context menu, which calls this handle.
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

  const visibleTree = foldersApi.tree.filter((node) => !node.folder.archivedAt)

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <FolderTree
        nodes={visibleTree}
        selectedFolderId={selectedFolderId}
        expandedIds={expandedIds}
        onSelect={onSelectFolder}
        onToggle={toggle}
        onContextMenu={(folder, event) => setMenu({ x: event.clientX, y: event.clientY, folder })}
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

      {menu ? createPortal((
        <div
          className="fixed z-[100] min-w-[160px] overflow-hidden rounded-md border border-foreground/10 bg-popover p-1 text-sm text-popover-foreground shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <MenuItem onClick={() => { setInlineCreate({ parentId: menu.folder.id, value: '' }); closeMenu() }}>{t('folders.newChild')}</MenuItem>
          <MenuItem onClick={() => { setRenaming({ folderId: menu.folder.id, value: menu.folder.name }); closeMenu() }}>{t('folders.rename')}</MenuItem>
          <MenuItem onClick={() => { void run(async () => { await foldersApi.pinFolder(menu.folder.id, !menu.folder.pinnedAt) }); closeMenu() }}>
            {menu.folder.pinnedAt ? t('folders.unpin') : t('folders.pin')}
          </MenuItem>
          <MenuItem onClick={() => { void run(async () => { await foldersApi.archiveFolder(menu.folder.id) }); closeMenu() }}>{t('folders.archive')}</MenuItem>
          <MenuItem
            destructive
            onClick={() => { setDialog({ type: 'delete', folder: menu.folder, confirmValue: '' }); closeMenu() }}
          >
            {t('folders.delete')}
          </MenuItem>
        </div>
      ), document.body) : null}

      {dialog ? createPortal((
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setDialog(null)}>
          <div className="w-[320px] rounded-lg border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 text-sm font-medium">
              {t('folders.deleteTitle', { name: dialog.folder.name })}
            </div>

            <p className="mb-3 text-xs text-muted-foreground">{t('folders.deleteBody')}</p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => setDialog(null)}
              >
                {t('folders.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 disabled:opacity-50"
                onClick={submitDialog}
              >
                {t('folders.deleteForever')}
              </button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </div>
  )
}

)

function MenuItem({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode
  onClick: () => void
  destructive?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
        destructive ? 'text-destructive' : '',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
