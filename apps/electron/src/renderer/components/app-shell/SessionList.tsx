import { useState, useCallback, useEffect, useMemo, useRef, type DragEvent } from "react"
import { useTranslation } from "react-i18next"
import { useSetAtom } from "jotai"
import { startOfDay } from "date-fns"
import { useAction } from "@/actions"
import { Inbox, Archive } from "lucide-react"

import * as storage from "@/lib/local-storage"
import { KEYS } from "@/lib/local-storage"
import * as MultiSelect from "@/hooks/useMultiSelect"
import { Spinner } from "@craft-agent/ui"
import { EntityListEmptyScreen } from "@/components/ui/entity-list-empty"
import { EntityList } from "@/components/ui/entity-list"
import { RenameDialog } from "@/components/ui/rename-dialog"
import { SessionItem } from "./SessionItem"
import { SessionListProvider, type SessionListContextValue } from "@/context/SessionListContext"
import { useSessionSelection, useSessionSelectionStore } from "@/hooks/useSession"
import { useSessionSearch } from "@/hooks/useSessionSearch"
import { NavigatorFolderList, type NavigatorFolderListHandle } from "./NavigatorFolderList"
import { filterFolderSearchResults } from "./folder-search"
import { ArchiveFolderList } from "./ArchiveFolderList"
import { buildArchiveTree, type ArchiveTreeNode } from "@craft-agent/shared/sessions/folder-tree"
import { getInChatSearchQuery } from "./chat-search-routing"
import type { UseFoldersResult } from "../../hooks/useFolders"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useEntityListInteractions } from "@/hooks/useEntityListInteractions"
import { useFocusZone } from "@/hooks/keyboard"
import { useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useNavigation, useNavigationState, isSessionsNavigation } from "@/contexts/NavigationContext"
import { useFocusContext } from "@/context/FocusContext"
import { sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"

export interface SessionListRow {
  item: SessionMeta
}

interface SessionListProps {
  items: SessionMeta[]
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onRename: (sessionId: string, name: string) => void
  /** Called when Enter is pressed to focus chat input for a specific session */
  onFocusChatInput?: (sessionId?: string) => void
  /** Called when a session is selected */
  onSessionSelect?: (session: SessionMeta) => void
  /** Called when a session selected from active search results should search its chat. */
  onSearchResultSelect?: (sessionId: string, query: string) => void
  /** Called when user wants to open a session in a new window */
  onOpenInNewWindow?: (session: SessionMeta) => void
  /** Whether search mode is active */
  searchActive?: boolean
  /** Current search query */
  searchQuery?: string
  /** Called when search query changes */
  onSearchChange?: (query: string) => void
  /** Called when search is closed */
  onSearchClose?: () => void
  /** Workspace projects (for the Projects submenu in SessionMenu) */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  /** Callback to bind/unbind a session to a project (null = unbind) */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** Workspace ID for content search (optional - if not provided, content search is disabled) */
  workspaceId?: string
  /** True when the list is scoped to one project's jump view — project-bound rows already sit inside their project, so the hover project-name suffix is redundant. */
  inProjectScope?: boolean
  /**
   * Folder list for the CURRENT scope, rendered as the first rows of this list.
   * Living inside the list (not above it) is what keeps folder rows and session
   * rows in one scroll flow with one row height.
   */
  foldersApi?: UseFoldersResult
  /** Project scope of the active folder tree; null = All Sessions. */
  folderScopeProjectId?: string | null
  /** Current folder scope: null = root. Its direct children are listed. */
  folderScopeId?: string | null
  /** Enter a folder (scope this list to it). */
  onEnterFolder?: (folderId: string) => void
  /** Session count per folder id, for the trailing badge. */
  folderSessionCounts?: ReadonlyMap<string, number>
  /** Drop a session onto a folder row (re-file it). */
  onDropSessionToFolder?: (sessionId: string, folderId: string) => void
  /** Handle to the folder list, so the panel's context menu can start a create. */
  folderListRef?: React.Ref<NavigatorFolderListHandle>
  /**
   * The folder open inside the「已归档」tree (namespaced key, e.g. `root:<id>`).
   * Controlled by the panel so the list title can render the folder path; the
   * standalone preview (no handler) keeps its own local copy.
   */
  archiveScopeKey?: string | null
  onArchiveScopeKeyChange?: (key: string | null) => void
  /** Override which session is highlighted (for multi-panel focused panel tracking) */
  focusedSessionId?: string | null
  /** Override navigation target (for multi-panel: focuses existing panel or navigates focused panel) */
  onNavigateToSession?: (sessionId: string) => void
  /** Session-level pending prompt marker (permission/admin approval) */
  hasPendingPrompt?: (sessionId: string) => boolean
  /** DOM-verified match info for the active session (from ChatDisplay) */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
  /** Create a session in the current scope (inherits project + folder). */
  onNewSession?: () => void
}


/**
 * SessionList - Scrollable list of session cards with keyboard navigation
 *
 * Keyboard shortcuts:
 * - Arrow Up/Down: Navigate and select sessions (immediate selection)
 * - Arrow Left/Right: Navigate between zones
 * - Enter: Focus chat input
 * - Home/End: Jump to first/last session
 */
export function SessionList({
  items,
  onDelete,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onRename,
  onFocusChatInput,
  onSearchResultSelect,
  onOpenInNewWindow,
  searchActive,
  searchQuery = '',
  onSearchChange,
  onSearchClose,
  projects,
  onSetProjectId,
  workspaceId,
  inProjectScope,
  foldersApi,
  folderScopeProjectId = null,
  folderScopeId = null,
  onEnterFolder,
  folderSessionCounts,
  onDropSessionToFolder,
  folderListRef,
  archiveScopeKey: archiveScopeKeyProp,
  onArchiveScopeKeyChange,
  focusedSessionId,
  onNavigateToSession,
  hasPendingPrompt,
  activeChatMatchInfo,
  onNewSession,
}: SessionListProps) {
  const { t, i18n } = useTranslation()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)

  // --- Selection (atom-backed, shared with ChatDisplay + BatchActionPanel) ---
  const {
    select: selectSession,
    toggle: toggleSession,
    selectRange,
    isMultiSelectActive,
  } = useSessionSelection()
  const selectionStore = useSessionSelectionStore()

  const { navigateToSession: navigateToSessionPrimary } = useNavigation()
  const navigateToSession = onNavigateToSession ?? navigateToSessionPrimary
  const navState = useNavigationState()
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Get current filter from navigation state (for preserving context in tab routes)
  const currentFilter = isSessionsNavigation(navState) ? navState.filter : undefined

  // --- Archive view: folders belong here, but ONLY archived ones ---
  // A folder has exactly one path. Archiving moves it out of the live tree and
  // the live navigator (both drop `archivedAt`) and into this archive tree; the
  // reverse is equally true. The old view reused the LIVE navigator, which is
  // how a live folder could appear under「已归档」 while still living in
  //「所有会话」— two paths for one folder — and how a truly archived folder
  // became unreachable (nothing rendered it, and `unarchiveFolder` had no UI).
  const isArchiveView = currentFilter?.kind === 'archived'
  const [localArchiveScopeKey, setLocalArchiveScopeKey] = useState<string | null>(null)
  // Panel-controlled when wired up (the title needs the open folder), local
  // otherwise. Same key shape either way: `root:<folderId>`.
  const archiveScopeKey = onArchiveScopeKeyChange ? (archiveScopeKeyProp ?? null) : localArchiveScopeKey
  const setArchiveScopeKey = (key: string | null) => {
    if (onArchiveScopeKeyChange) onArchiveScopeKeyChange(key)
    else setLocalArchiveScopeKey(key)
  }

  useEffect(() => {
    if (!isArchiveView) setArchiveScopeKey(null)
  }, [isArchiveView])

  const archiveTree = useMemo(() => {
    if (!isArchiveView) return null
    try {
      return buildArchiveTree({
        projects: [],
        foldersByScope: [{ projectId: null, folders: foldersApi?.folders ?? [] }],
        sessions: items,
      })
    } catch {
      return null
    }
  }, [isArchiveView, foldersApi?.folders, items])

  /** Trail from the archive root to the open archived folder (empty at the root). */
  const archivePath = useMemo((): ArchiveTreeNode[] => {
    if (!archiveTree || !archiveScopeKey) return []
    const walk = (nodes: readonly ArchiveTreeNode[], trail: ArchiveTreeNode[]): ArchiveTreeNode[] | null => {
      for (const node of nodes) {
        const next = [...trail, node]
        if (node.key === archiveScopeKey) return next
        const hit = walk(node.children, next)
        if (hit) return hit
      }
      return null
    }
    return walk(archiveTree.nodes, []) ?? []
  }, [archiveTree, archiveScopeKey])

  const archiveNode = archivePath.length > 0 ? archivePath[archivePath.length - 1]! : null

  // The open folder vanished (unarchived, deleted or moved elsewhere): drop back
  // to the archive root instead of paging through a scope that no longer exists.
  useEffect(() => {
    if (isArchiveView && archiveScopeKey && archiveTree && !archiveNode) setArchiveScopeKey(null)
  }, [isArchiveView, archiveScopeKey, archiveTree, archiveNode])

  const archiveFolderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (!archiveTree) return counts
    const count = (node: ArchiveTreeNode): number => {
      let total = node.sessions.length
      for (const child of node.children) total += count(child)
      counts.set(node.key, total)
      return total
    }
    for (const node of archiveTree.nodes) count(node)
    return counts
  }, [archiveTree])

  const archiveFoldersHere: readonly ArchiveTreeNode[] = archiveNode
    ? archiveNode.children
    : archiveTree?.nodes ?? []

  // Scope the session rows to the open archived folder. Search stays global: an
  // archived session has to be findable from anywhere inside the archive.
  const listItems = useMemo(() => {
    if (!isArchiveView || !archiveTree || searchActive) return items
    const sessions = archiveNode ? archiveNode.sessions : archiveTree.sessions
    const allowed = new Set(sessions.map(session => session.id))
    return items.filter(item => allowed.has(item.id))
  }, [isArchiveView, archiveTree, archiveNode, items, searchActive])

  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")
  // Track if search input has actual DOM focus (for proper keyboard navigation gating)
  // The search box lives in the panel header (outside this list), so keyboard
  // navigation is enabled whenever search is active: opening the box focuses it.

  // --- Data pipeline (search, filtering, pagination, grouping) ---
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  const {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    hasMore,
    searchInputRef,
  } = useSessionSearch({
    items: listItems,
    searchActive: searchActive ?? false,
    searchQuery,
    workspaceId,
    currentFilter,
    scrollViewportRef,
  })

  // One flat run of rows: the list has no grouping (date / unread / project),
  // so there are no group headers to build or collapse.
  const rowData = useMemo(() => {
    const rows: SessionListRow[] = (isSearchMode ? matchingFilterItems : flatItems).map(item => ({ item }))
    return {
      rows,
      groups: rows.length > 0 ? [{ key: 'all', label: '', items: rows, collapsible: false as const }] : [],
    }
  }, [isSearchMode, matchingFilterItems, flatItems])

  const flatRows = rowData.rows
  const hasMatchingSearchFolders = isSearchMode && !!foldersApi &&
    filterFolderSearchResults(foldersApi.folders, folderScopeId, searchQuery).length > 0

  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatRows.forEach((row, index) => {
      map.set(row.item.id, index)
    })
    return map
  }, [flatRows])

  // --- Action handlers with toast feedback ---
  const {
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  } = useSessionActions({ onArchive, onUnarchive, onDelete })

  // --- Focus zone ---
  const { focusZone } = useFocusContext()
  const { zoneRef, isFocused, shouldMoveDOMFocus } = useFocusZone({ zoneId: 'navigator' })

  // Keyboard eligibility: zone-focused OR search input focused (for arrow navigation)
  const isKeyboardEligible = isFocused || !!searchActive

  // --- Interactions (keyboard navigation + selection via shared atom) ---
  const interactions = useEntityListInteractions<SessionListRow>({
    items: flatRows,
    getId: (row) => row.item.id,
    keyboard: {
      onNavigate: useCallback((row: SessionListRow) => {
        navigateToSession(row.item.id)
      }, [navigateToSession]),
      onActivate: useCallback((row: SessionListRow) => {
        // Only navigate when not in multi-select (matches original behavior)
        if (!MultiSelect.isMultiSelectActive(selectionStore.state)) {
          const query = getInChatSearchQuery(isSearchMode, searchQuery)
          if (query) onSearchResultSelect?.(row.item.id, query)
          navigateToSession(row.item.id)
          if (!query) onFocusChatInput?.(row.item.id)
        }
      }, [selectionStore.state, navigateToSession, onFocusChatInput, isSearchMode, searchQuery, onSearchResultSelect]),
      enabled: isKeyboardEligible,
      virtualFocus: searchActive ?? false,
    },
    multiSelect: true,
    selectionStore,
    selectedIdOverride: focusedSessionId,
  })

  // Sync activeIndex when selection changes externally (e.g. from ChatDisplay)
  useEffect(() => {
    const newIndex = flatRows.findIndex(row => row.item.id === selectionStore.state.selected)
    if (newIndex >= 0 && newIndex !== interactions.keyboard.activeIndex) {
      interactions.keyboard.setActiveIndex(newIndex)
    }
  }, [selectionStore.state.selected, flatRows, interactions.keyboard])

  // Focus active item when zone gains keyboard focus
  useEffect(() => {
    if (shouldMoveDOMFocus && flatRows.length > 0 && !(searchActive ?? false)) {
      interactions.keyboard.focusActiveItem()
    }
  }, [shouldMoveDOMFocus, flatRows.length, searchActive, interactions.keyboard])

  // --- Global keyboard shortcuts ---
  const isFocusWithinZone = () => zoneRef.current?.contains(document.activeElement) ?? false

  useAction('navigator.selectAll', () => {
    interactions.selection.selectAll()
  }, {
    enabled: isFocusWithinZone,
  }, [interactions.selection])

  useAction('navigator.clearSelection', () => {
    const selectedId = selectionStore.state.selected
    interactions.selection.clear()
    if (selectedId) navigateToSession(selectedId)
  }, {
    enabled: () => isMultiSelectActive && !showEscapeOverlay,
  }, [isMultiSelectActive, showEscapeOverlay, interactions.selection, selectionStore.state.selected, navigateToSession])

  // --- Click handlers ---
  const handleSelectSession = useCallback((row: SessionListRow, index: number) => {
    selectSession(row.item.id, index)
    const query = getInChatSearchQuery(isSearchMode, searchQuery)
    if (query) onSearchResultSelect?.(row.item.id, query)
    navigateToSession(row.item.id)
    // Route focus through the queued mechanism (120ms delay in FreeFormInput)
    // so the session-switch re-render burst settles before focusing — immediate
    // focus mid-update races Windows TSF IME context registration and makes the
    // first keystroke miss the IME (duplicated plain chars, e.g. "nn").
    // Search result selection instead focuses the in-chat search field.
    if (!query) onFocusChatInput?.(row.item.id)
  }, [selectSession, navigateToSession, onFocusChatInput, isSearchMode, searchQuery, onSearchResultSelect])

  const handleSelectSessionById = useCallback((sessionId: string) => {
    const index = rowIndexMap.get(sessionId) ?? -1
    if (index >= 0) {
      selectSession(sessionId, index)
    } else {
      selectSession(sessionId, 0)
    }
    navigateToSession(sessionId)
  }, [rowIndexMap, selectSession, navigateToSession])

  const handleToggleSelect = useCallback((row: SessionListRow, index: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    toggleSession(row.item.id, index)
  }, [focusZone, toggleSession])

  const handleRangeSelect = useCallback((toIndex: number) => {
    focusZone('navigator', { intent: 'click', moveFocus: false })
    const allIds = flatRows.map(row => row.item.id)
    selectRange(toIndex, allIds)
  }, [focusZone, flatRows, selectRange])

  // Arrow key shortcuts for zone navigation (left → sidebar, right → chat)
  const handleKeyDown = useCallback((e: React.KeyboardEvent, _item: SessionMeta) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusZone('sidebar', { intent: 'keyboard' })
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusZone('chat', { intent: 'keyboard' })
      return
    }
  }, [focusZone])

  // --- Rename dialog ---
  const handleRenameClick = useCallback((sessionId: string, currentName: string) => {
    setRenameSessionId(sessionId)
    setRenameName(currentName)
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const handleRenameSubmit = () => {
    if (renameSessionId && renameName.trim()) {
      onRename(renameSessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
    setRenameSessionId(null)
    setRenameName("")
  }

  // --- Context value (shared across all SessionItems) ---
  const handleFocusZone = useCallback(() => focusZone('navigator', { intent: 'click', moveFocus: false }), [focusZone])
  const handleOpenInNewWindow = useCallback((item: SessionMeta) => onOpenInNewWindow?.(item), [onOpenInNewWindow])
  const resolvedSearchQuery = isSearchMode ? highlightQuery : searchQuery

  const listContext = useMemo((): SessionListContextValue => ({
    onRenameClick: handleRenameClick,
    onArchive: onArchive ? handleArchiveWithToast : undefined,
    onUnarchive: onUnarchive ? handleUnarchiveWithToast : undefined,
    onMarkUnread,
    onDelete: handleDeleteWithToast,
    projects,
    onSetProjectId,
    onSelectSessionById: handleSelectSessionById,
    onOpenInNewWindow: handleOpenInNewWindow,
    onSendToWorkspace: (ids: string[]) => setSendToWorkspace(ids),
    onFocusZone: handleFocusZone,
    onKeyDown: handleKeyDown,
    searchQuery: resolvedSearchQuery,
    selectedSessionId: focusedSessionId !== undefined ? focusedSessionId : selectionStore.state.selected,
    isMultiSelectActive,
    inProjectScope,
    contentSearchResults,
    activeChatMatchInfo,
    onNewSession,
    hasPendingPrompt,
  }), [
    handleRenameClick,
    onArchive, handleArchiveWithToast, onUnarchive, handleUnarchiveWithToast,
    onMarkUnread, handleDeleteWithToast,
    projects, onSetProjectId,
    handleSelectSessionById, handleOpenInNewWindow, setSendToWorkspace, handleFocusZone, handleKeyDown,
    resolvedSearchQuery,
    focusedSessionId, selectionStore.state.selected, isMultiSelectActive,
    inProjectScope, contentSearchResults, activeChatMatchInfo, hasPendingPrompt, onNewSession,
  ])

  // --- Empty state (non-search) — render before EntityList ---
  // Don't show empty state when there are collapsed groups with content.
  // The live folder section counts as content too: in browse mode the folder
  // list (and its create affordance) lives inside the EntityList header, so
  // an early-return empty screen would swallow it — leaving root folders
  // invisible in the panel and right-click → 新建文件夹 a silent no-op
  // (the folder list ref is never mounted).
  const liveFolderSection = !isArchiveView && !!foldersApi && !!onEnterFolder
  if (flatRows.length === 0 && rowData.groups.length === 0 && !searchActive && archiveFoldersHere.length === 0) {
    if (currentFilter?.kind === 'archived') {
      return (
        <EntityListEmptyScreen
          icon={<Archive />}
          title={t("session.noArchivedSessions")}
          description={t("session.noArchivedSessionsDesc")}
          className="h-full"
        />
      )
    }
    if (liveFolderSection) {
      return (
        <div className="flex flex-col flex-1 min-h-0">
          <NavigatorFolderList
            ref={folderListRef}
            foldersApi={foldersApi!}
            folderScopeProjectId={folderScopeProjectId}
            scopeId={folderScopeId}
            searchQuery={isSearchMode ? searchQuery : undefined}
            onEnterFolder={onEnterFolder}
            sessionCounts={folderSessionCounts}
            onDropSession={onDropSessionToFolder}
          />
          {/* No action button: the list is "empty" in normal operation because
              the supervisor (督导) is hidden by design, and the sessions that
              do appear here are created by tasks. Minting a blank session
              from the empty state is exactly what this list is not for. */}
          <EntityListEmptyScreen
            icon={<Inbox />}
            title={t("session.noSessionsYet")}
            description={t("session.noSessionsYetDesc")}
          />
        </div>
      )
    }
    // No action button: the list is "empty" in normal operation because the
    // supervisor (督导) is hidden by design, and the sessions that do appear
    // here are created by tasks. Minting a blank session from the empty state
    // is exactly what this list is not for.
    return (
      <EntityListEmptyScreen
        icon={<Inbox />}
        title={t("session.noSessionsYet")}
        description={t("session.noSessionsYetDesc")}
        className="h-full"
      />
    )
  }

  // --- Render ---
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <SessionListProvider value={listContext}>
      <EntityList<SessionListRow>
        groups={rowData.groups}
        getKey={(row) => row.item.id}
        renderItem={(row, _indexInGroup, isFirstInGroup) => {
          const flatIndex = rowIndexMap.get(row.item.id) ?? 0
          const rowProps = interactions.getRowProps(row, flatIndex)
          return (
            <div className="relative">
              <SessionItem
                item={row.item}
                index={flatIndex}
                itemProps={rowProps.buttonProps as Record<string, unknown>}
                isSelected={rowProps.isSelected}
                isFirstInGroup={isFirstInGroup}
                isInMultiSelect={rowProps.isInMultiSelect ?? false}
                onSelect={() => handleSelectSession(row, flatIndex)}
                onToggleSelect={() => handleToggleSelect(row, flatIndex)}
                onRangeSelect={() => handleRangeSelect(flatIndex)}
              />
            </div>
          )
        }}
        header={
          <>
            {/* Browse mode lists direct children; search mode lists matching folders
                throughout the current directory tree. The archived view gets the
                archive tree instead of this live navigator: one path per folder. */}
            {isArchiveView && archiveTree ? (
              <>
                <ArchiveFolderList
                  nodes={archiveFoldersHere}
                  sessionCounts={archiveFolderCounts}
                  onEnter={(node) => setArchiveScopeKey(node.key)}
                  onUnarchive={foldersApi
                    ? async (folderId: string) => {
                        await foldersApi.unarchiveFolder(folderId)
                        setArchiveScopeKey(null)
                      }
                    : undefined}
                />
              </>
            ) : foldersApi && onEnterFolder ? (
              <NavigatorFolderList
                ref={folderListRef}
                foldersApi={foldersApi}
                folderScopeProjectId={folderScopeProjectId}
                scopeId={folderScopeId}
                searchQuery={isSearchMode ? searchQuery : undefined}
                onEnterFolder={onEnterFolder}
                sessionCounts={folderSessionCounts}
                onDropSession={onDropSessionToFolder}
              />
            ) : null}
            {isSearchMode && matchingFilterItems.length === 0 && otherResultItems.length > 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {t("session.noResultsInFilter")}
              </div>
            )}
          </>
        }
        emptyState={
          isSearchMode && !isSearchingContent && !hasMatchingSearchFolders ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <p className="text-sm text-muted-foreground">{t("session.noSessionsFound")}</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                {t("session.noSessionsFoundDesc")}
              </p>
              <button
                onClick={() => onSearchChange?.('')}
                className="text-xs text-foreground hover:underline mt-2"
              >
                {t("session.clearSearch")}
              </button>
            </div>
          ) : undefined
        }
        footer={
          hasMore ? (
            <div className="flex justify-center py-4">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : undefined
        }
        viewportRef={scrollViewportRef}
        containerRef={zoneRef}
        containerProps={{
          'data-focus-zone': 'navigator',
          'data-list-role': 'sessions',
          role: 'listbox',
          'aria-label': 'Sessions',
        }}
        scrollAreaClassName="select-none mask-fade-top-short"
      />
      </SessionListProvider>

      {/* Rename Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t("session.renameSession")}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t("session.enterSessionName")}
      />
    </div>
  )
}
