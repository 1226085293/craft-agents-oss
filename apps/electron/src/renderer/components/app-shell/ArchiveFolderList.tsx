/**
 * ArchiveFolderList
 *
 * Folder rows for the「已归档」view.
 *
 * The rule this component exists to enforce: a folder has exactly ONE path.
 * Archiving a folder moves it here and removes it from the live tree (left rail)
 * and from the live navigator (left list). This is the archive half of that
 * rule — it renders ONLY archived folders.
 *
 * Why it matters: the archived view used to draw the LIVE navigator, whose
 * filter drops archived rows. So a live folder (T-2) appeared under「已归档」
 * while actually living in「所有会话」— two paths for one folder — and a folder
 * that WAS archived could never appear here at all, leaving it unreachable
 * (`foldersApi.unarchiveFolder` had no call site anywhere in the renderer).
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder as FolderIcon } from 'lucide-react'
import type { ArchiveTreeNode } from '@craft-agent/shared/sessions/folder-tree'
import { Separator } from '@/components/ui/separator'

const ROW_CLASS =
  'group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-3 text-sm text-left cursor-default select-none overflow-hidden transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface MenuState {
  x: number
  y: number
  node: ArchiveTreeNode
}

export interface ArchiveFolderListProps {
  /** Archived folders at the current archive scope (children of the open node, or the roots). */
  nodes: readonly ArchiveTreeNode[]
  /** Archived session count per node key, node plus descendants. */
  sessionCounts?: ReadonlyMap<string, number>
  /** Open an archived folder (scopes the session list to it). */
  onEnter: (node: ArchiveTreeNode) => void
  /** Move a folder back to the live tree. Without this an archived folder is a dead end. */
  onUnarchive?: (folderId: string) => Promise<void> | void
}

export function ArchiveFolderList({
  nodes,
  sessionCounts,
  onEnter,
  onUnarchive,
}: ArchiveFolderListProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  if (nodes.length === 0) return null

  return (
    <div className="shrink-0 pb-1">
      {error ? <div className="px-3 py-1 text-[11px] text-destructive">{error}</div> : null}
      <ul className="grid gap-0">
        {nodes.map((node, index) => {
          const count = sessionCounts?.get(node.key) ?? node.sessions.length
          return (
            <li key={node.key}>
              {index > 0 && (
                <div className="pl-[38px] pr-4">
                  <Separator />
                </div>
              )}
              <div
                role="button"
                tabIndex={0}
                data-nav-archive-folder-key={node.key}
                className={[ROW_CLASS, 'mx-2 max-w-[calc(100%-1rem)]'].join(' ')}
                onClick={() => onEnter(node)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onEnter(node)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu({ x: event.clientX, y: event.clientY, node })
                }}
              >
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.path && node.path.length > 1 ? (
                  <span
                    className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground/70"
                    title={node.path.slice(0, -1).join(' / ')}
                  >
                    {node.path.slice(0, -1).join(' / ')}
                  </span>
                ) : null}
                {count > 0 ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
                ) : null}
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              </div>
            </li>
          )
        })}
      </ul>

      {menu ? createPortal((
        <div
          className="fixed z-[100] min-w-[160px] overflow-hidden rounded-md border border-foreground/10 bg-popover p-1 text-sm text-popover-foreground shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <MenuItem
            disabled={busy || !onUnarchive}
            onClick={() => {
              const node = menu.node
              setMenu(null)
              if (!onUnarchive) return
              setBusy(true)
              setError(null)
              void Promise.resolve(onUnarchive(node.id))
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err))
                })
                .finally(() => setBusy(false))
            }}
          >
            {t('folders.unarchive')}
          </MenuItem>
        </div>
      ), document.body) : null}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-foreground/[0.06] disabled:opacity-50"
    >
      {children}
    </button>
  )
}
