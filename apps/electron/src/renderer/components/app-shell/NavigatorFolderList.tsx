/**
 * NavigatorFolderList
 *
 * The folders that live directly inside the current folder scope, shown at the
 * top of the second column (the session list). These are the folders you can
 * step into from here — a breadcrumb goes up, this goes down.
 *
 * Interaction:
 * - click a row        → scope the session list to that folder
 * - right click a row  → rename / pin / archive / delete (everything the left
 *                        tree offers except "new subfolder", which only makes
 *                        sense where the tree shows structure)
 * - drop a session     → file it into that folder
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder as FolderIcon, Pin } from 'lucide-react'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import { getUniqueFolderName } from '@craft-agent/shared/sessions/folder-tree'
import type { UseFoldersResult } from '../../hooks/useFolders'
import { beginFolderDrag, dragState, endDrag } from './dragState'
import { compareFolders } from './folder-sort'
import { filterFolderSearchResults } from './folder-search'
import { rankFolderSearchResults } from './search-ranking'
import { highlightMatch } from '@/utils/session'
import { claimMenu, releaseMenu, subscribeMenu } from './menuRegistry'
import { Separator } from '@/components/ui/separator'

/** Characters a folder name cannot contain (Windows rules — the data lives on disk). */
const INVALID_NAME_CHARS = /[\/:*?"<>|]/

const ROW_CLASS =
  // Vertical padding chosen so a folder row is exactly as tall as a session
  // row (EntityRow), and the two read as one continuous list.
  'group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-3 text-sm text-left cursor-default select-none overflow-hidden transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface MenuState {
  x: number
  y: number
  folder: FolderConfig
}

export interface NavigatorFolderListProps {
  foldersApi: UseFoldersResult
  /** Project scope of this list; null = All Sessions. */
  folderScopeProjectId?: string | null
  /** Current scope: null = root. Only its direct children are listed. */
  scopeId: string | null
  /** Optional search query; limits folder rows to matching folders under the current scope. */
  searchQuery?: string
  /** Enter a folder (scope the session list to it). */
  onEnterFolder: (folderId: string) => void
  /** Session counts per folder id, for the trailing badge. */
  sessionCounts?: ReadonlyMap<string, number>
  /** Drop a session onto a folder row. */
  onDropSession?: (sessionId: string, folderId: string) => void
  /** Folder a session currently lives in (same-folder drops are not a move). */
  getSessionFolderId?: (sessionId: string) => string | null | undefined
  /** Folders holding unread sessions — sorted first and badged. */
  unreadFolderIds?: ReadonlySet<string>
}

export interface NavigatorFolderListHandle {
  /** Starts the inline "new folder" editor for the current scope. */
  openCreate: () => void
}

export const NavigatorFolderList = React.forwardRef<NavigatorFolderListHandle, NavigatorFolderListProps>(
  function NavigatorFolderList({
  foldersApi,
  folderScopeProjectId = null,
  scopeId,
  searchQuery,
  onEnterFolder,
  sessionCounts,
  onDropSession,
  getSessionFolderId,
  unreadFolderIds,
}: NavigatorFolderListProps, ref): React.ReactElement | null {
  const { t } = useTranslation()
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const [renaming, setRenaming] = React.useState<{ folderId: string; value: string } | null>(null)
  const [deleting, setDeleting] = React.useState<FolderConfig | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = React.useState<string | null>(null)
  React.useEffect(() => {
    // dragend fires on the source row only; clear the target highlight here.
    const clear = () => setDropTargetId(null)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])
  // Inline "new folder" draft, created at the END of the current scope's list so
  // the name box appears where the folder will land (same rule as the tree).
  const [inlineCreate, setInlineCreate] = React.useState<{ value: string } | null>(null)
  const committingNameRef = React.useRef(false)

  React.useImperativeHandle(ref, () => ({
    openCreate: () => setInlineCreate({ value: '' }),
  }), [])


  // Direct sub-folder count per folder id. The row badge reports *items inside*
  // a folder, so sub-folders count too — a folder holding only folders used to
  // read "0", which looks like the count is broken.
  const childFolderCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const folder of foldersApi.folders) {
      const parentId = folder.parentId ?? null
      if (!parentId) continue
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1)
    }
    return counts
  }, [foldersApi.folders])

  const children = React.useMemo(() => {
    const visibleFolders = filterFolderSearchResults(foldersApi.folders, scopeId, searchQuery)
    const compareByExistingPriority = (a: FolderConfig, b: FolderConfig) =>
      compareFolders(a, b, unreadFolderIds ?? new Set())
    return searchQuery?.trim()
      ? rankFolderSearchResults(visibleFolders, searchQuery, compareByExistingPriority)
      : visibleFolders.sort(compareByExistingPriority)
  }, [foldersApi.folders, scopeId, searchQuery, unreadFolderIds])

  React.useEffect(() => {
    if (!menu) return
    // A menu opened by right-clicking while another one closes can receive that
    // other menu's dismissal events; ignore anything in the first few frames.
    const openedAt = Date.now()
    const close = () => { if (Date.now() - openedAt < 150) return; setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', close)
    }
  }, [menu])
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

  const commitInlineCreate = React.useCallback(() => {
    const current = inlineCreate
    if (!current || committingNameRef.current) return
    const name = current.value.trim()
    if (!name || INVALID_NAME_CHARS.test(name)) { setInlineCreate(null); return }
    const suggestedName = getUniqueFolderName(name, foldersApi.folders, scopeId)
    if (suggestedName !== name && !window.confirm(t('folders.duplicateNameConfirm', { name, suggestedName }))) {
      setInlineCreate(null)
      return
    }
    committingNameRef.current = true
    void run(async () => {
      try {
        await foldersApi.createFolder(suggestedName, scopeId)
        setInlineCreate(null)
      } finally {
        committingNameRef.current = false
      }
    })
  }, [inlineCreate, foldersApi, scopeId, run])

  /** Blank, OS-illegal or colliding names abort the edit instead of erroring. */
  const commitRename = React.useCallback(() => {
    const draft = renaming
    if (!draft || committingNameRef.current) return
    const folder = foldersApi.folders.find((f) => f.id === draft.folderId)
    const name = draft.value.trim()
    if (!folder || !name || INVALID_NAME_CHARS.test(name) || name === folder.name) {
      setRenaming(null)
      return
    }
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

  if (children.length === 0 && !inlineCreate && !foldersApi.error && !error) return null

  return (
    <div className="shrink-0 pb-1">
      <ul className="grid gap-0">
        {children.map((folder, index) => {
          const isFirst = index === 0
          const count = (sessionCounts?.get(folder.id) ?? 0) + (childFolderCounts.get(folder.id) ?? 0)
          const isRenaming = renaming?.folderId === folder.id
          return (
            <li key={folder.id}>
              {/* Row inset lives on the row, not the list, so the divider can
                  span the panel exactly like the session rows' divider does. */}
              {!isFirst && (
                // Same separator as the session rows below (EntityRow): hairline
                // tinted by --border and inset past the icon column.
                <div className="pl-[38px] pr-4">
                  <Separator />
                </div>
              )}
              <div
                role="button"
                tabIndex={0}
                data-nav-folder-id={folder.id}
                className={[
                  ROW_CLASS,
                  // w-full + mx-2 would overflow the panel by 2×8px; cap the
                  // width instead so the row ends exactly where session rows do.
                  'mx-2 max-w-[calc(100%-1rem)]',
                  dropTargetId === folder.id ? 'bg-foreground/[0.12] inset-ring-2 inset-ring-foreground/45' : '',
                ].join(' ')}
                onClick={() => {
                  if (isRenaming) return
                  onEnterFolder(folder.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onEnterFolder(folder.id)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ x: event.clientX, y: event.clientY, folder })
                }}
                // Draggable out of this list too: dropping onto a folder in the
                // sidebar tree re-parents it. The tree owns drop validation
                // (parent→child and self are rejected), so this only publishes
                // the dragged id for it to read during dragover.
                draggable={!isRenaming}
                onDragStart={(event) => {
                  if (isRenaming) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.setData('application/x-craft-folder', folder.id)
                  event.dataTransfer.effectAllowed = 'move'
                  beginFolderDrag(folder.id, folderScopeProjectId)
                }}
                onDragEnd={endDrag}
                onDragOver={(event) => {
                  // Sessions can be filed here; folders cannot be re-nested from
                  // this list (that lives in the tree), so anything else reads as
                  // "not a valid drop" and keeps the default cursor.
                  if (!onDropSession) return
                  // Dropping a session into the folder it already lives in is not a
                  // move: leave the event alone so the pointer reads "not allowed".
                  if (dragState.sessionId && dragState.projectId === folderScopeProjectId && dragState.sessionFolderId === folder.id) {
                    event.dataTransfer.dropEffect = 'none'
                    return
                  }
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTargetId((prev) => (prev === folder.id ? prev : folder.id))
                }}
                onDragLeave={(event) => {
                  const next = event.relatedTarget as Node | null
                  if (next && event.currentTarget.contains(next)) return
                  setDropTargetId((prev) => (prev === folder.id ? null : prev))
                }}
                onDrop={(event) => {
                  setDropTargetId(null)
                  if (!onDropSession) return
                  const sessionId = event.dataTransfer.getData('application/x-craft-session')
                  if (!sessionId) return
                  event.preventDefault()
                  event.stopPropagation()
                  onDropSession(sessionId, folder.id)
                }}
              >
                <FolderIcon className="h-[14px] w-[14px] shrink-0 text-muted-foreground" />
                {isRenaming ? (
                  <NameInput
                    value={renaming.value}
                    onChange={(value) => setRenaming({ folderId: folder.id, value })}
                    onCommit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">
                    {highlightMatch(folder.name, searchQuery ?? '')}
                  </span>
                )}
                {folder.pinnedAt ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
                {unreadFolderIds?.has(folder.id) ? (
                  <span aria-label="has unread sessions" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                ) : null}
                {!isRenaming ? (
                  <>
                    {/* Count is hover-only: the row's job is to be a folder, not a stat. */}
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                      {count}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </>
                ) : null}
              </div>
            </li>
          )
        })}
        {inlineCreate ? (
          <li>
            <div className={ROW_CLASS}>
              <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <NameInput
                value={inlineCreate.value}
                placeholder={t('folders.namePlaceholder')}
                onChange={(value) => setInlineCreate({ value })}
                onCommit={commitInlineCreate}
                onCancel={() => setInlineCreate(null)}
              />
            </div>
          </li>
        ) : null}
      </ul>

      {/* Divider between the folder block and the session list: same hairline. */}
      {children.length > 0 && (
        <div className="pl-[38px] pr-4">
          <Separator />
        </div>
      )}

      {foldersApi.error || error ? (
        <div className="mt-1 px-1 text-[11px] text-destructive">{foldersApi.error ?? error}</div>
      ) : null}

      {menu ? createPortal((
        <div
          className="fixed z-[100] min-w-[160px] overflow-hidden rounded-md border border-foreground/10 bg-popover p-1 text-sm text-popover-foreground shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <MenuItem onClick={() => { setRenaming({ folderId: menu.folder.id, value: menu.folder.name }); setMenu(null) }}>
            {t('folders.rename')}
          </MenuItem>
          <MenuItem onClick={() => { void run(async () => { await foldersApi.pinFolder(menu.folder.id, !menu.folder.pinnedAt) }); setMenu(null) }}>
            {menu.folder.pinnedAt ? t('folders.unpin') : t('folders.pin')}
          </MenuItem>
          <MenuItem onClick={() => { void run(async () => { await foldersApi.archiveFolder(menu.folder.id) }); setMenu(null) }}>
            {t('folders.archive')}
          </MenuItem>
          <MenuItem destructive onClick={() => { setDeleting(menu.folder); setMenu(null) }}>
            {t('folders.delete')}
          </MenuItem>
        </div>
      ), document.body) : null}

      {deleting ? createPortal((
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setDeleting(null)}>
          <div className="w-[320px] rounded-lg border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-2 text-sm font-medium">{t('folders.deleteTitle', { name: deleting.name })}</div>
            <p className="mb-3 text-xs text-muted-foreground">{t('folders.deleteBody')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => setDeleting(null)}
              >
                {t('folders.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-white hover:bg-destructive/90 disabled:opacity-50"
                onClick={() => {
                  const target = deleting
                  void run(async () => {
                    await foldersApi.deleteFolder(target.id)
                    setDeleting(null)
                  })
                }}
              >
                {t('folders.deleteForever')}
              </button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </div>
  )
})

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

/** In-place name editor: Enter commits, Escape and blur cancel. */
function NameInput({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={onCancel}
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-foreground/20 bg-background px-1 py-0.5 text-sm outline-none focus:border-primary"
    />
  )
}
