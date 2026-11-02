/**
 * FolderTree
 *
 * Presentational recursive tree for the session folders (left panel).
 * Data + mutations live in `useFolders`; this component only renders and emits
 * intent (select / toggle / context menu / drop target markers).
 *
 * Interaction model:
 * - single click on a folder with children → expand/collapse in place
 * - single click on a leaf folder          → scope the session list to it
 * - double click on any folder             → scope the session list to it
 *   (the two clicks of a double click are debounced, so a double click never
 *   leaves the folder in a toggled state)
 *
 * Layout notes (D6):
 * - indent is a fixed 16px per level, capped at the depth limit
 * - rows shrink and truncate instead of scrolling horizontally
 */

import * as React from 'react'
import { Separator } from '@/components/ui/separator'
import { ChevronRight, Folder as FolderIcon, FolderOpen, Pin } from 'lucide-react'
import type { FolderConfig } from '@craft-agent/shared/sessions/folders'
import type { FolderTreeNode } from '@craft-agent/shared/sessions/folder-tree'
import { beginFolderDrag, dragState, endDrag } from './dragState'
import { sortFolderNodes } from './folder-sort'

const INDENT_PX = 14
/** Root rows sit flush with sibling nav items (Flagged / Archived). */
const ROOT_PAD = 8
const MAX_INDENT_LEVELS = 5
/** Wait window that separates a single click from the first click of a double click. */
const CLICK_DELAY_MS = 180

/**
 * Parent links of every folder currently rendered, keyed by folder id.
 *
 * A drop target is invalid when it is the dragged folder itself or sits inside
 * it — moving a folder into its own subtree would detach that subtree from the
 * tree. Keeping the map here means the check is synchronous during `dragover`,
 * which is the only moment the OS cursor can still be changed.
 */
function indexNodes(nodes: FolderTreeNode[], parentId: string | null, parentIds: Map<string, string | null>): void {
  for (const node of nodes) {
    parentIds.set(node.folder.id, parentId)
    indexNodes(node.children, node.folder.id, parentIds)
  }
}

/** True when dropping `draggedId` onto `targetId` would detach the tree. */
function wouldDetachTree(draggedId: string, targetId: string, parentIds: ReadonlyMap<string, string | null>): boolean {
  if (draggedId === targetId) return true
  let cursor: string | null | undefined = targetId
  while (cursor) {
    if (cursor === draggedId) return true
    cursor = parentIds.get(cursor)
  }
  return false
}

/**
 * Row shell shared by real folder rows and the inline name-editing row, so
 * creating and renaming render identically (one interaction, not two widgets).
 */
const ROW_CLASS = 'group flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-sm cursor-default select-none overflow-hidden hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors'

/** Inline "new folder" editor state, owned by the caller. */
export interface InlineCreateState {
  parentId: string | null
  value: string
  placeholder: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}

export interface FolderTreeProps {
  nodes: FolderTreeNode[]
  selectedFolderId: string | null
  expandedIds: ReadonlySet<string>
  onSelect: (folderId: string) => void
  onToggle: (folderId: string) => void
  onContextMenu?: (folder: FolderConfig, event: React.MouseEvent) => void
  onDropOnFolder?: (folderId: string, event: React.DragEvent) => void
  /** Project scope of the rendered tree; null = All Sessions. */
  folderScopeProjectId?: string | null
  /** Tree-local parent map shared with recursive rows. */
  parentIds?: ReadonlyMap<string, string | null>
  /** Draw the hairline above this row (false for the first sibling). */
  showSeparator?: boolean
  /** Ids currently highlighted as a drop target. */
  dropTargetIds?: ReadonlySet<string>
  depth?: number
  emptyLabel?: string
  /** Inline create editor, rendered under its parent (or at the root). */
  inlineCreate?: InlineCreateState | null
  /** Inline rename editor: the folder whose name is being edited. */
  renaming?: InlineRenameState | null
  /**
   * Folder a session currently lives in, so hovering the folder it already
   * belongs to reads as "not a move" instead of promising one.
   */
  getSessionFolderId?: (sessionId: string) => string | null | undefined
  /** Folders holding unread sessions — sorted first among siblings and badged. */
  unreadFolderIds?: ReadonlySet<string>
}

/** Inline rename state — the name turns into an input in place. */
export interface InlineRenameState {
  folderId: string
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}

export function FolderTree({
  nodes,
  selectedFolderId,
  expandedIds,
  onSelect,
  onToggle,
  onContextMenu,
  onDropOnFolder,
  folderScopeProjectId = null,
  parentIds: inheritedParentIds,
  dropTargetIds,
  depth = 0,
  emptyLabel,
  inlineCreate,
  renaming,
  getSessionFolderId,
  unreadFolderIds,
}: FolderTreeProps): React.ReactElement {
  const parentIds = React.useMemo(() => {
    if (inheritedParentIds) return inheritedParentIds
    const map = new Map<string, string | null>()
    indexNodes(nodes, null, map)
    return map
  }, [inheritedParentIds, nodes])
  const rootEditor = depth === 0 && inlineCreate && inlineCreate.parentId === null
    ? <InlineFolderRow depth={0} inline={inlineCreate} />
    : null

  // Pinned first, then folders holding unread sessions, then by name.
  const orderedNodes = unreadFolderIds && unreadFolderIds.size > 0
    ? sortFolderNodes(nodes, unreadFolderIds)
    : nodes

  if (nodes.length === 0) {
    if (depth !== 0) return <></>
    if (rootEditor) return <ul role="tree" className="w-full min-w-0">{rootEditor}</ul>
    return emptyLabel
      ? (
        <div className="flex w-full items-center justify-center px-3 py-5 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )
      : <></>
  }

  return (
    <ul role="tree" className="w-full min-w-0">
      {rootEditor}
      {orderedNodes.map((node, index) => (
        <FolderNode
          key={node.folder.id}
          node={node}
          showSeparator={index > 0}
          selectedFolderId={selectedFolderId}
          expandedIds={expandedIds}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          onDropOnFolder={onDropOnFolder}
          folderScopeProjectId={folderScopeProjectId}
          parentIds={parentIds}
          dropTargetIds={dropTargetIds}
          depth={depth}
          inlineCreate={inlineCreate}
          renaming={renaming}
          getSessionFolderId={getSessionFolderId}
          unreadFolderIds={unreadFolderIds}
        />
      ))}
    </ul>
  )
}

interface FolderNodeProps extends Omit<FolderTreeProps, 'nodes' | 'emptyLabel'> {
  node: FolderTreeNode
}

function FolderNode({
  node,
  selectedFolderId,
  expandedIds,
  onSelect,
  onToggle,
  onContextMenu,
  onDropOnFolder,
  folderScopeProjectId = null,
  parentIds = new Map(),
  dropTargetIds,
  depth = 0,
  inlineCreate,
  renaming,
  getSessionFolderId,
  unreadFolderIds,
  showSeparator = false,
}: FolderNodeProps): React.ReactElement {
  const { folder, children } = node
  const hasChildren = children.length > 0
  const isExpanded = expandedIds.has(folder.id)
  const isSelected = selectedFolderId === folder.id
  const isDropTarget = dropTargetIds?.has(folder.id) ?? false

  // Live hover state for drop targets. The tree never received `dropTargetIds`,
  // so the only reliable signal is the drag gesture itself: set it on dragOver
  // and clear it when the pointer leaves the row (ignoring child transitions).
  const [dropHover, setDropHover] = React.useState(false)
  React.useEffect(() => {
    // A cancelled gesture fires dragend on the SOURCE row only, so the target
    // would stay highlighted forever. Listen document-wide to clear it.
    const clear = () => setDropHover(false)
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])

  const indent = Math.min(depth, MAX_INDENT_LEVELS) * INDENT_PX
  const rowPadLeft = ROOT_PAD + indent

  // Debounce single click so a double click never toggles the node.
  const clickTimer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
  }, [])

  const handleRowClick = React.useCallback((event: React.MouseEvent) => {
    // event.detail is the click count: 1 = first click, 2 = second click of a
    // double click. A second click cancels the pending toggle immediately, so a
    // double click can never both collapse and navigate.
    if (event.detail > 1) {
      if (clickTimer.current) {
        window.clearTimeout(clickTimer.current)
        clickTimer.current = null
      }
      return
    }
    if (clickTimer.current) return
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      // A single click only expands/collapses. Entering the folder (scoping the
      // session list) is a deliberate double click, so browsing the tree never
      // swaps the right-hand list under the user.
      //
      // Toggling is unconditional (not gated on hasChildren): a leaf folder must
      // still flip its expanded state, otherwise rows behave differently
      // depending on whether they happen to have children — the chevron would
      // appear dead on empty folders.
      onToggle(folder.id)
    }, CLICK_DELAY_MS)
  }, [onToggle, folder.id])

  const handleRowDoubleClick = React.useCallback(() => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    onSelect(folder.id)
  }, [onSelect, folder.id])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(folder.id)
      return
    }
    if (event.key === 'ArrowRight' && hasChildren && !isExpanded) {
      event.preventDefault()
      onToggle(folder.id)
      return
    }
    if (event.key === 'ArrowLeft' && hasChildren && isExpanded) {
      event.preventDefault()
      onToggle(folder.id)
    }
  }

  const childEditor = inlineCreate && inlineCreate.parentId === folder.id
    ? <InlineFolderRow depth={depth + 1} inline={inlineCreate} />
    : null

  return (
    <li role="none" className="min-w-0">
      {showSeparator && (
        // Same hairline as the session rows (--border, inset past the icon).
        <div style={{ paddingLeft: rowPadLeft + 22 }} className="pr-2">
          <Separator />
        </div>
      )}
      <div
        role="treeitem"
        aria-level={depth + 1}
        // Every row exposes the state (leaf rows included): clicking a folder
        // without children still flips it, so the state must be observable.
        aria-expanded={isExpanded}
        aria-selected={isSelected}
        tabIndex={0}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-craft-folder', folder.id)
          event.dataTransfer.effectAllowed = 'move'
          beginFolderDrag(folder.id, folderScopeProjectId)
        }}
        onDragEnd={endDrag}
        data-folder-id={folder.id}
        className={[
          ROW_CLASS,
          isSelected ? 'bg-foreground/[0.10] text-foreground' : '',
          isDropTarget || dropHover ? 'bg-foreground/[0.12] inset-ring-2 inset-ring-foreground/45' : '',
        ].join(' ')}
        style={{ paddingLeft: rowPadLeft }}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onContextMenu?.(folder, event)
        }}
        onDragOver={(event) => {
          if (!onDropOnFolder) return
          // Decided from the live drag state rather than from props: whether a
          // folder may land here depends on the dragged folder, which is known
          // synchronously and cannot wait for a re-render mid-gesture.
          const draggedFolderId = dragState.folderId
          const sameScope = dragState.projectId === folderScopeProjectId
          if (draggedFolderId && sameScope && wouldDetachTree(draggedFolderId, folder.id, parentIds)) {
            event.dataTransfer.dropEffect = 'none'
            return
          }
          // Dropping a session into the folder it already lives in is a no-op,
          // but it must NOT be rejected here: `dropEffect = 'none'` makes the
          // browser skip the drop event entirely, so the gesture died silently
          // and read as "dragging stopped working". The drop handler reports it.
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropHover(true)
        }}
        onDragLeave={(event) => {
          // Moving onto a child fires dragleave on the row: ignore those so the
          // frame does not flicker while the pointer is still inside.
          const next = event.relatedTarget as Node | null
          if (next && event.currentTarget.contains(next)) return
          setDropHover(false)
        }}
        onDrop={(event) => {
          setDropHover(false)
          if (!onDropOnFolder) return
          event.preventDefault()
          event.stopPropagation()
          onDropOnFolder(folder.id, event)
        }}
      >
        {/* The icon mirrors the expand state for EVERY folder (children or not):
            single click toggles empty folders too, so the row needs a visible
            response — otherwise the click looks like a no-op. */}
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}

        {renaming?.folderId === folder.id ? (
          <NameInput
            value={renaming.value}
            commitOnBlur
            onChange={renaming.onChange}
            onCommit={renaming.onCommit}
            onCancel={renaming.onCancel}
          />
        ) : (
          <span className="truncate">{folder.name}</span>
        )}

        {folder.pinnedAt ? <Pin className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}

        {/* Unread marker: a folder is unread when any session inside it is. */}
        {unreadFolderIds?.has(folder.id) ? (
          <span
            aria-label="has unread sessions"
            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : null}

        {/* Collapse affordance: hidden until the row is hovered, pinned to the right edge.
            Rendered for EVERY folder, children or not: an empty folder still has an
            expand state (single click flips it), so the affordance must not vanish
            just because there is nothing to unfold yet — otherwise the row looks
            unresponsive and the two cases behave differently. */}
        {true ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(folder.id)
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="ml-auto -mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-foreground/10 focus-visible:opacity-100"
          >
            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
        {folder.archivedAt ? (
          <span className="ml-1 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{folder.archivedAt ? '·' : ''}</span>
        ) : null}
      </div>

      {childEditor}

      {hasChildren && isExpanded ? (
        <FolderTree
          nodes={children}
          selectedFolderId={selectedFolderId}
          expandedIds={expandedIds}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          onDropOnFolder={onDropOnFolder}
          folderScopeProjectId={folderScopeProjectId}
          parentIds={parentIds}
          dropTargetIds={dropTargetIds}
          depth={depth + 1}
          inlineCreate={inlineCreate}
          renaming={renaming}
        />
      ) : null}
    </li>
  )
}

/**
 * NameInput
 *
 * The single in-place name editor used by both rename and new-folder. Enter
 * commits, Escape cancels; an invalid name is rejected by the caller, so the row
 * keeps its previous state without an error toast.
 */
interface NameInputProps {
  value: string
  placeholder?: string
  /** Resolve the edit when the input loses focus (commit or cancel). */
  commitOnBlur?: boolean
  /** Ignore blurs this soon after mount — the context menu closing steals focus. */
  blurGraceMs?: number
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}

export function NameInput({ value, placeholder, commitOnBlur = false, blurGraceMs = 400, onChange, onCommit, onCancel }: NameInputProps): React.ReactElement {
  const mountedAtRef = React.useRef(Date.now())
  // Radix restores focus to its trigger when the context menu unmounts, and that
  // happens AFTER this input mounts — so a single focus() is immediately undone.
  // Re-assert focus on the next ticks (guarded by isConnected + activeElement).
  const focusRef = React.useCallback((node: HTMLInputElement | null) => {
    if (!node) return
    const grab = () => {
      if (!node.isConnected) return
      if (document.activeElement === node) return
      node.focus()
      node.select()
    }
    grab()
    window.setTimeout(grab, 0)
    window.setTimeout(grab, 90)
    window.setTimeout(grab, 250)
  }, [])

  return (
    <input
      ref={focusRef}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => { if (!commitOnBlur) return; if (Date.now() - mountedAtRef.current < blurGraceMs) return; onCommit() }}
      className="min-w-0 flex-1 rounded-[4px] border border-foreground/20 bg-background px-1 py-0 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

/**
 * InlineFolderRow
 *
 * The "new folder" row. It deliberately mirrors the in-place rename row — same
 * shell, same folder icon, same input — so creating and renaming read as one
 * interaction instead of two different widgets.
 */
function InlineFolderRow({ depth, inline }: { depth: number; inline: InlineCreateState }): React.ReactElement {
  const rowPadLeft = ROOT_PAD + Math.min(depth, MAX_INDENT_LEVELS) * INDENT_PX
  return (
    <div
      className={ROW_CLASS}
      style={{ paddingLeft: rowPadLeft }}
    >
      <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <NameInput
        value={inline.value}
        placeholder={inline.placeholder}
        commitOnBlur
        onChange={inline.onChange}
        onCommit={inline.onCommit}
        onCancel={inline.onCancel}
      />
    </div>
  )
}
