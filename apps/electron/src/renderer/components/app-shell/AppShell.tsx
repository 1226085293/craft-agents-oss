import * as React from "react"
import { useTranslation, Trans } from "react-i18next"
import { useRef, useState, useEffect, useCallback, useMemo } from "react"
import { createPortal } from "react-dom"
import { useAtomValue, useStore } from "jotai"
import { motion, AnimatePresence } from "motion/react"
import {
  Archive,
  Settings,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  RotateCw,
  Flag,
  ListFilter,
  Tag,
  Check,
  X,
  Search,
  Plus,
  Settings2,
  Trash2,
  DatabaseZap,
  Zap,
  Inbox,
  Globe,
  FolderOpen,
  Cake,
  Calendar,
  Layers,
  ListTodo,
  Clock,
  Radio,
  Bot,
  Info,
  MailOpen,
  FolderKanban,
  PanelsTopLeft,
  Brain,
  FolderPlus,
  ChevronLeft,
  ArrowLeft,
} from "lucide-react"
import { SourceAvatar } from "@/components/ui/source-avatar"
import { TopBar } from "./TopBar"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { McpIcon } from "../icons/McpIcon"
import { cn } from "@/lib/utils"
import { isMac } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { HeaderIconButton } from "@/components/ui/HeaderIconButton"
import { resolveInheritedFilterParams, type FilterMode } from "./inherited-filter-params"
import { filterSessionsByFolderScope, filterSessionsByFolderSearchScope } from "./session-search-scope"
import { getFolderSubtreeIds } from "./folder-search"
import { resolveKeyboardSearchTarget } from "./chat-search-routing"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipTrigger, TooltipContent, DocumentFormattedMarkdownOverlay } from "@craft-agent/ui"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from "@/components/ui/styled-dropdown"
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from "@/components/ui/styled-context-menu"
import { ContextMenuProvider } from "@/components/ui/menu-context"
import { SidebarMenu } from "./SidebarMenu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FadingText } from "@/components/ui/fading-text"
import {
  Collapsible,
  CollapsibleTrigger,
  AnimatedCollapsibleContent,
  springTransition as collapsibleSpring,
} from "@/components/ui/collapsible"
import { SessionList } from "./SessionList"
import { FolderSection, type FolderSectionHandle } from "./FolderSection"
import type { NavigatorFolderListHandle } from "./NavigatorFolderList"
import { HeaderSearchControl } from "./HeaderSearchControl"
import { useFolders } from "@/hooks/useFolders"
import { MainContentPanel } from "./MainContentPanel"
import { shouldRefreshUsageStats } from "./usage-refresh"
import { PanelStackContainer } from "./PanelStackContainer"
import type { ChatDisplayHandle } from "./ChatDisplay"
import { LeftSidebar } from "./LeftSidebar"
import { useSession } from "@/hooks/useSession"
import { ensureSessionMessagesLoadedAtom } from "@/atoms/sessions"
import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext"
import { EscapeInterruptProvider, useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useTheme } from "@/context/ThemeContext"
import { getResizeGradientStyle } from "@/hooks/useResizeGradient"
import { useAction, useActionLabel } from "@/actions"
import { useFocusZone } from "@/hooks/keyboard"
import { useFocusContext } from "@/context/FocusContext"
import { getCurrentZone } from "@/actions/keybinding-context"
import { getSessionTitle } from "@/utils/session"
import { useSetAtom } from "jotai"
import type { Session, Workspace, FileAttachment, PermissionRequest, LoadedSource, LoadedSkill, PermissionMode, SourceFilter, UsageStats } from "../../../shared/types"
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from "@/atoms/sessions"
import { sourcesAtom } from "@/atoms/sources"
import { skillsAtom } from "@/atoms/skills"
import { panelStackAtom, panelCountAtom, focusedPanelIdAtom, focusedSessionIdAtom, focusNextPanelAtom, focusPrevPanelAtom, parseSessionIdFromRoute } from "@/atoms/panel-stack"
import { useContainerWidth } from "@/hooks/useContainerWidth"
import { resolveEntityColor } from "@craft-agent/shared/colors"
import { getFolderIdsToCollapseOnAncestorNavigation, getFolderPathParts } from "./folder-path"
import { getUniqueFolderName } from "@craft-agent/shared/sessions/folder-tree"
import { dragState } from "./dragState"
import { getEnteredProjectDetailScopeId } from "./project-navigation"
import * as storage from "@/lib/local-storage"
import { toast } from "sonner"
import { navigate, routes } from "@/lib/navigate"
import { openSettingsWindow } from "@/lib/settings-window"
import {
  useNavigation,
  useNavigationState,
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isProjectsNavigation,
  isPagesNavigation,
  isAutomationsNavigation,
  type NavigationState,
} from "@/contexts/NavigationContext"
import type { SettingsSubpage } from "../../../shared/types"
import { SourcesListPanel } from "./SourcesListPanel"
import { SkillsListPanel } from "./SkillsListPanel"
import { ProjectsListPanel } from "./ProjectsListPanel"
import { useProjects } from "@/hooks/useProjects"
import { useAutomations } from "@/hooks/useAutomations"
import { APP_EVENTS, AGENT_EVENTS, AUTOMATION_TYPE_TO_FILTER_KIND } from "@/components/automations/types"
import { AutomationsListPanel } from "@/components/automations/AutomationsListPanel"
import { usePages } from "@/hooks/usePages"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { PanelHeader } from "./PanelHeader"
import { FabNewChat } from "./FabNewChat"
import { SendToWorkspaceDialog } from "./SendToWorkspaceDialog"
import { CreateProjectDialog } from "../projects/CreateProjectDialog"
import { MessagingDialogHost } from "@/components/messaging/MessagingDialogHost"
import { EditPopover, getEditConfig, type EditContextKey } from "@/components/ui/EditPopover"
import SettingsNavigator from "@/pages/settings/SettingsNavigator"
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
  RADIUS_EDGE,
  RADIUS_INNER,
} from "./panel-constants"
import { hasOpenOverlay } from "@/lib/overlay-detection"
import { clearSourceIconCaches } from "@/lib/icon-cache"
import { dispatchFocusInputEvent } from "./input/focus-input-events"

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Use via useAppShellContext() hook in child components
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultLayout?: number[]
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Focused mode - hides sidebars, shows only the chat content */
  isFocusedMode?: boolean
}

/**
 * AppShell - Main 3-panel layout container
 *
 * Layout: [LeftSidebar 20%] | [NavigatorPanel 32%] | [MainContentPanel 48%]
 *
 * Session Filters:
 * - 'allSessions': Shows all sessions
 * - 'state': Shows sessions with a specific todo state
 */
export function AppShell(props: AppShellProps) {
  // Wrap with EscapeInterruptProvider so AppShellContent can use useEscapeInterrupt
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
  menuNewChatTrigger,
  isFocusedMode = false,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - we use sessionMetaMapAtom instead
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    activeWorkspaceId,
    sessionOptions,
    onSelectWorkspace,
    onRefreshWorkspaces,
    onDeleteSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionRead,
    onMarkSessionUnread,
    onRenameSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    onReset,
    onSendMessage,
    openNewChat,
    pendingPermissions,
  } = contextValue

  const { t } = useTranslation()

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey


  const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })
  const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarWidth, 220)
  })
  // Session list width in pixels (min 240, max 480)
  const [sessionListWidth, setSessionListWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sessionListWidth, 300)
  })

  // Hides both sidebar and navigator (CMD+. toggle)
  // Seed from either focused window param or persisted preference, then keep it toggleable.
  const [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden] = React.useState(() => {
    return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
  })

  // Auto-compact mode: shell width below mobile threshold hides sidebar/navigator
  // and switches to single-panel mode. Works in both webui (narrow viewport) and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD

  const effectiveSidebarAndNavigatorHidden = isSidebarAndNavigatorHidden || isAutoCompact

  // What's New overlay
  const [showWhatsNew, setShowWhatsNew] = React.useState(false)
  const [releaseNotesContent, setReleaseNotesContent] = React.useState('')
  const [hasUnseenReleaseNotes, setHasUnseenReleaseNotes] = React.useState(false)

  // Check for unseen release notes on mount
  useEffect(() => {
    window.electronAPI.getLatestReleaseVersion().then((latestVersion) => {
      if (!latestVersion) return
      const lastSeen = storage.get(storage.KEYS.whatsNewLastSeenVersion, '')
      setHasUnseenReleaseNotes(lastSeen !== latestVersion)
    })
  }, [])

  const [isResizing, setIsResizing] = React.useState<'sidebar' | 'session-list' | null>(null)
  const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)
  const [sessionListHandleY, setSessionListHandleY] = React.useState<number | null>(null)
  const resizeHandleRef = React.useRef<HTMLDivElement>(null)
  const sessionListHandleRef = React.useRef<HTMLDivElement>(null)
  const [session, setSession] = useSession()
  const { resolvedMode, isDark, setMode } = useTheme()
  const { canGoBack, canGoForward, goBack, goForward, navigateToSource, navigateToSession } = useNavigation()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterrupt()

  // UNIFIED NAVIGATION STATE - single source of truth from NavigationContext
  // Derived from focused panel's route — all panels are peers
  const navState = useNavigationState()

  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Navigate the focused panel to a session.
  // If the session is already open in another panel, focus that panel instead.
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navigateToSessionInPanel = useCallback((sessionId: string) => {
    // Check if the session is already open in any panel — focus it instead of navigating
    const stack = store.get(panelStackAtom)
    for (const entry of stack) {
      if (parseSessionIdFromRoute(entry.route) === sessionId) {
        setFocusedPanel(entry.id)
        return
      }
    }

    // Not open in any panel — navigate() updates the focused panel
    navigateToSession(sessionId)
  }, [store, setFocusedPanel, navigateToSession])

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null

  // Automations type filter (scheduled / event / agentic), null when unfiltered.
  const automationFilter = isAutomationsNavigation(navState) ? (navState.filter ?? null) : null

  // Pages behaves the same way: both the library grid and an open page render
  // full-width in the content area — there is no pages navigator list.
  const isPagesView = isPagesNavigation(navState)

  // Memory manager renders full-width in the content area — there is no
  // sources list to keep beside it, so the navigator (and its resize handle)
  // collapse to zero width while it's active (#memory-ui).
  const isMemoryView = isSourcesNavigation(navState) && navState.details?.type === 'memory'

  // Derive source filter from navigation state (only when in sources navigator)
  const sourceFilter: SourceFilter | null = isSourcesNavigation(navState) ? navState.filter ?? null : null

  // Per-view filter storage: each session list view has its own independent project
  // filter. Each filter entry stores a mode ('include' or 'exclude') for tri-state filtering.
  type FilterEntry = Record<string, FilterMode> // id → mode
  type ViewFiltersMap = Record<string, { projects?: FilterEntry }>

  // Compute a stable key for the current chat filter view
  const sessionFilterKey = useMemo(() => {
    if (!sessionFilter) return null
    switch (sessionFilter.kind) {
      case 'allSessions': return 'allSessions'
      case 'archived': return 'archived'
      default: return 'allSessions'
    }
  }, [sessionFilter])

  const [viewFiltersMap, setViewFiltersMap] = React.useState<ViewFiltersMap>(() => {
    const saved = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {})
    return saved
  })


  // Derive current view's project filter as a Map<projectId, FilterMode>
  const projectFilter = useMemo(() => {
    if (!sessionFilterKey) return new Map<string, FilterMode>()
    const entry = viewFiltersMap[sessionFilterKey]?.projects ?? {}
    return new Map<string, FilterMode>(Object.entries(entry) as [string, FilterMode][])
  }, [viewFiltersMap, sessionFilterKey])

  // An explicit project include (jump-to-project state) narrows the list to
  // that project's sessions: it suspends D9 and the folder scope, and the rail
  // highlights the project entry instead of "All Sessions".
  const hasProjectInclude = useMemo(() => {
    for (const mode of projectFilter.values()) {
      if (mode === 'include') return true
    }
    return false
  }, [projectFilter])

  // Setter for project filter — updates only the current view's entry in the map
  const setProjectFilter = useCallback((updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => {
    setViewFiltersMap(prev => {
      if (!sessionFilterKey) return prev
      const current = new Map<string, FilterMode>(Object.entries(prev[sessionFilterKey]?.projects ?? {}) as [string, FilterMode][])
      const next = typeof updater === 'function' ? updater(current) : updater
      const existing = prev[sessionFilterKey]
      return {
        ...prev,
        [sessionFilterKey]: {
          projects: Object.fromEntries(next),
        }
      }
    })
  }, [sessionFilterKey])

  // Jump to All Sessions filtered by a single project. Used by the Projects list
  // context menu — sets the allSessions view's project filter (preserving its
  // other filters), then navigates.
  const handleJumpToProjectSessions = useCallback((projectId: string) => {
    // The project becomes the active scope: drop the folder scope so the two
    // never stack — the rail highlights exactly one scope row.
    setRootFolderBrowseId(undefined)
    setFolderScopeId(null)
    setViewFiltersMap(prev => {
      const existing = prev['allSessions']
      return {
        ...prev,
        allSessions: {
          projects: { [projectId]: 'include' },
        }
      }
    })
    navigate(routes.view.allSessions())
  }, [])

  // Picking a folder in the RAIL tree means browsing "All Sessions" (that tree
  // is always the root tree): drop any project include so the list really is
  // the root folder's sessions. The navigator list's project folders enter via
  // plain setFolderScopeId — they narrow within the project instead. Root-tree
  // navigation also exits the rail's project-tree mode (mode 2).
  const handleSelectFolderScope = useCallback((folderId: string | null) => {
    setEnteredProjectId(null)
    setRootFolderBrowseId(undefined)
    setFolderScopeId(folderId)
    setViewFiltersMap(prev => {
      const entry = prev['allSessions']
      if (!entry || Object.keys(entry.projects ?? {}).length === 0) return prev
      return { ...prev, allSessions: { projects: {} } }
    })
  }, [])

  const handleBrowseRootFolderInProjectMode = useCallback((folderId: string | null) => {
    setRootFolderBrowseId(folderId)
    navigate(routes.view.allSessions())
  }, [])

  const handleSelectProjectFolder = useCallback((folderId: string | null) => {
    setRootFolderBrowseId(undefined)
    setFolderScopeId(folderId)
  }, [])

  // Drag a session across scopes (root ↔ project): the atomic moveToScope
  // command rebinds project + folder in one step; the target folder must exist
  // in the target scope, so cross-scope drops carry folderId: null.
  // Session metadata is declared far below (it comes from a Jotai atom), so the
  // drop handlers read it through a ref instead of closing over it directly —
  // referencing the atom value here would hit the temporal dead zone and take
  // the whole shell down.
  const sessionMetaMapRef = React.useRef<ReadonlyMap<string, { projectId?: string; folderId?: string | null }>>(new Map())

  const handleDropSessionToScope = useCallback(async (sessionId: string, targetProjectId: string | null, targetFolderId: string | null) => {
    try {
      // Compare against the session's REAL binding, not the drag state: a stale
      // drag state made an already-filed session look movable, and the move then
      // either did nothing or failed silently.
      const meta = sessionMetaMapRef.current.get(sessionId) as { projectId?: string; folderId?: string | null } | undefined
      const currentProject = meta?.projectId ?? null
      const currentFolder = meta?.folderId ?? null
      if (currentProject === (targetProjectId ?? null) && currentFolder === (targetFolderId ?? null)) {
        toast.info(t('folders.alreadyInFolder'))
        return
      }
      await window.electronAPI.sessionCommand(sessionId, { type: 'moveToScope', projectId: targetProjectId, folderId: targetFolderId })
      // Filters stay untouched for the same reason: a drop must not re-scope the
      // navigator under the user.
    } catch (error) {
      console.error('[AppShell] Failed to move session across scopes:', error)
      const detail = error instanceof Error ? error.message : String(error)
      toast.error(`${t('folders.moveFailed')}${detail ? `: ${detail}` : ''}`)
    }
  }, [t])

  // Move a folder subtree between workspace/project trees, optionally into a
  // folder. Ask before applying the deterministic sibling suffix on collision.
  const handleDropFolderToScope = useCallback(async (
    folderId: string,
    fromProjectId: string | null,
    toProjectId: string | null,
    targetParentId: string | null = null,
  ) => {
    if (!activeWorkspaceId) return
    try {
      const [sourceFolders, targetFolders] = await Promise.all([
        window.electronAPI.listFolders(activeWorkspaceId, { projectId: fromProjectId }),
        window.electronAPI.listFolders(activeWorkspaceId, { projectId: toProjectId }),
      ])
      const sourceFolder = sourceFolders.find(folder => folder.id === folderId)
      if (!sourceFolder) throw new Error('Dragged folder no longer exists')
      const name = getUniqueFolderName(sourceFolder.name, targetFolders, targetParentId, fromProjectId === toProjectId ? folderId : undefined)
      if (name !== sourceFolder.name && !window.confirm(t('folders.duplicateNameConfirm', { name: sourceFolder.name, suggestedName: name }))) return
      if (fromProjectId === toProjectId) {
        await window.electronAPI.moveFolder(activeWorkspaceId, { projectId: fromProjectId }, { id: folderId, parentId: targetParentId, name })
      } else {
        await window.electronAPI.moveFolderToScope(
          activeWorkspaceId,
          { projectId: fromProjectId },
          { id: folderId, parentId: targetParentId, name },
          { projectId: toProjectId },
        )
      }
      // Deliberately do NOT touch the navigator scope here: moving a folder is a
      // structural edit, and re-scoping left-2 made the drop look like it did
      // nothing (the list switched away from the folder the user was watching).
    } catch (error) {
      console.error('[AppShell] Failed to move folder across scopes:', error)
      toast.error(t('folders.moveFailed'))
    }
  }, [activeWorkspaceId, t])

  // Search state for session list
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [chatSearchHandoff, setChatSearchHandoff] = React.useState<{
    sessionId: string
    query: string
    requestId: number
  } | null>(null)
  const chatSearchHandoffSequence = React.useRef(0)
  const handleSearchResultSelect = React.useCallback((sessionId: string, query: string) => {
    setChatSearchHandoff({ sessionId, query, requestId: ++chatSearchHandoffSequence.current })
  }, [])
  const handleChatSearchHandoffConsumed = React.useCallback((requestId: number) => {
    setChatSearchHandoff((current) => current?.requestId === requestId ? null : current)
  }, [])
  // Folder tree lives in the navigator (left-2) panel, so AppShell drives both
  // its imperative "new folder" action and the panel's empty-space menu.
  const folderSectionRef = React.useRef<FolderSectionHandle>(null)
  const projectFolderSectionRef = React.useRef<FolderSectionHandle>(null)
  // Left-2's own folder list (the panel where the user actually is).
  const navigatorFolderListRef = React.useRef<NavigatorFolderListHandle>(null)
  const [listMenu, setListMenu] = React.useState<{ x: number; y: number } | null>(null)

  // Folder scope picked in the left tree (null = 「所有会话」 root).
  // Kept local so folders become usable before the full folder routing lands (B4).
  const [folderScopeId, setFolderScopeId] = React.useState<string | null>(null)
  // Explicit root-tree browsing while the project rail remains in mode 2.
  // undefined = follow the active project scope; null/string = root tree root/folder.
  const [rootFolderBrowseId, setRootFolderBrowseId] = React.useState<string | null | undefined>(undefined)
  // Mode 2 of the Projects rail section: the project whose folder tree is
  // currently shown under 项目/xxx. Deliberately separate from the include
  // filter — single-clicking an entry jumps to its sessions without flipping
  // the rail into tree mode; only a double-click (or the explicit enter) does.
  const [enteredProjectId, setEnteredProjectId] = React.useState<string | null>(null)
  React.useEffect(() => {
    setFolderScopeId(null)
    setRootFolderBrowseId(undefined)
  }, [activeWorkspaceId])

  const isStateSubView = false

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Ctrl/Cmd+F opens the chat-local search when the conversation has focus;
  // otherwise the existing session-list search remains the target.
  useAction('app.search', () => setSearchActive(true), {
    enabled: () => resolveKeyboardSearchTarget(
      getCurrentZone(),
      !!(focusedSessionId ?? sessionsContext?.sessionId),
    ) === 'sessions',
  }, [focusedSessionId, sessionsContext?.sessionId])

  // Unified sidebar keyboard navigation state
  // Load expanded folders from localStorage (default: all collapsed)
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[]>(storage.KEYS.expandedFolders, [])
    return new Set(saved)
  })
  const [focusedSidebarItemId, setFocusedSidebarItemId] = React.useState<string | null>(null)
  const sidebarItemRefs = React.useRef<Map<string, HTMLElement>>(new Map())
  // Track which expandable sidebar items are collapsed
  const [collapsedItems, setCollapsedItems] = React.useState<Set<string>>(() => {
    const saved = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null)
    if (saved !== null) return new Set(saved)
    return new Set()
  })
  const isExpanded = React.useCallback((id: string) => !collapsedItems.has(id), [collapsedItems])
  const toggleExpanded = React.useCallback((id: string) => {
    setCollapsedItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  // Sources state (workspace-scoped)
  const [sources, setSources] = React.useState<LoadedSource[]>([])
  // Sync sources to atom for NavigationContext auto-selection
  const setSourcesAtom = useSetAtom(sourcesAtom)
  React.useEffect(() => {
    setSourcesAtom(sources)
  }, [sources, setSourcesAtom])

  // Skills state (workspace-scoped)
  const [skills, setSkills] = React.useState<LoadedSkill[]>([])
  // Sync skills to atom for NavigationContext auto-selection
  const setSkillsAtom = useSetAtom(skillsAtom)
  React.useEffect(() => {
    setSkillsAtom(skills)
  }, [skills, setSkillsAtom])

  // Usage stats (source & skill usage counts / last-used)
  const [usageStats, setUsageStats] = React.useState<UsageStats>({ sources: {}, skills: {} })

  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

  // Global memory count (for the "记忆" sidebar badge — same style as
  // sources/skills/projects counts). Reloaded when the workspace changes
  // and after every memory write broadcast (live badge).
  const [memoryCount, setMemoryCount] = React.useState(0)
  const refreshMemoryCount = React.useCallback(async () => {
    const root = activeWorkspace?.rootPath
    if (!root) return
    try {
      const res = await window.electronAPI.getMemoryStats(root)
      setMemoryCount(res.entries?.length ?? 0)
    } catch { /* badge is best-effort */ }
  }, [activeWorkspace?.rootPath])
  React.useEffect(() => {
    void refreshMemoryCount()
  }, [refreshMemoryCount])
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMemoryChanged((workspaceId) => {
      if (workspaceId !== activeWorkspaceId) return
      void refreshMemoryCount()
    })
    return cleanup
  }, [activeWorkspaceId, refreshMemoryCount])

  // Send to Workspace dialog state (driven by sendToWorkspaceAtom set from SessionMenu/BatchSessionMenu)
  const sendToWorkspaceIds = useAtomValue(sendToWorkspaceAtom)
  const setSendToWorkspaceIds = useSetAtom(sendToWorkspaceAtom)
  const handleTransferComplete = useCallback((targetWorkspaceId: string, _newSessionIds: string[]) => {
    onSelectWorkspace(targetWorkspaceId)
  }, [onSelectWorkspace])
  const { projects } = useProjects(activeWorkspaceId)
  const enteredProjectDetailScopeId = React.useMemo(() => {
    const detailProjectSlug = isProjectsNavigation(navState) && navState.details?.type === 'project'
      ? navState.details.projectSlug
      : null
    return getEnteredProjectDetailScopeId(
      enteredProjectId,
      detailProjectSlug,
      projects.map(project => ({ id: project.config.id, slug: project.config.slug })),
    )
  }, [enteredProjectId, navState, projects])

  // Navigating away from sessions clears local folder browsing, except when the
  // mode-2 project settings/detail route is open for the same entered project.
  React.useEffect(() => {
    if (enteredProjectDetailScopeId) return
    if (!isSessionsNavigation(navState)) {
      setEnteredProjectId(null)
      setFolderScopeId(null)
      setRootFolderBrowseId(undefined)
    }
  }, [navState, enteredProjectDetailScopeId])

  // Inline rename of a project entry in the nav rail (context menu → 重命名).
  const [renamingProjectId, setRenamingProjectId] = React.useState<string | null>(null)
  const handleRenameProject = useCallback(async (projectSlug: string, currentName: string, rawName: string) => {
    setRenamingProjectId(null)
    const name = rawName.trim()
    if (!name || name === currentName || !activeWorkspace) return
    try {
      await window.electronAPI.updateProject(activeWorkspace.id, projectSlug, { name })
      toast.success(t('projectInfo.saved'))
    } catch (error) {
      console.error('[AppShell] Failed to rename project:', error)
      toast.error(t('projectInfo.saveFailed'))
    }
  }, [activeWorkspace, t])

  // Delete a project from its nav-rail context menu (same confirm as ProjectInfoPage).
  const handleDeleteProject = useCallback(async (projectSlug: string, projectName: string) => {
    if (!activeWorkspace) return
    if (!window.confirm(t('projectInfo.deleteConfirm', { name: projectName }))) return
    try {
      await window.electronAPI.deleteProject(activeWorkspace.id, projectSlug)
      toast.success(t('projectsList.deleted', { name: projectName }))
      // If we were looking at that project's page, fall back to the projects root.
      if (isProjectsNavigation(navState) && navState.details?.type === 'project' && navState.details.projectSlug === projectSlug) {
        navigate(routes.view.projects())
      }
    } catch (error) {
      console.error('[AppShell] Failed to delete project:', error)
      toast.error(t('projectsList.deleteFailed'))
    }
  }, [activeWorkspace, t, navState, navigate])

  const {
    automations,
    handleTestAutomation,
    handleToggleAutomation,
    handleDuplicateAutomation,
    handleDeleteAutomation,
  } = useAutomations(activeWorkspaceId)

  // Handler for selecting an automation (preserves the active type filter)
  const handleAutomationSelect = React.useCallback((automationId: string) => {
    const type = isAutomationsNavigation(navState) ? navState.filter?.automationType : undefined
    navigate(routes.view.automations({ automationId, type }))
  }, [navState])
  const automationTypeCounts = React.useMemo(() => {
    const counts = { scheduled: 0, event: 0, agentic: 0 }
    for (const automation of automations) {
      if (automation.event === 'SchedulerTick') counts.scheduled++
      else if ((APP_EVENTS as string[]).includes(automation.event)) counts.event++
      else if ((AGENT_EVENTS as string[]).includes(automation.event)) counts.agentic++
    }
    return counts
  }, [automations])

  // Folder tree follows the active scope: a project jump view or the same
  // project's mode-2 detail route shows that project's own tree, backed by its
  // independent storage file (projects/<slug>/folders.json); other views show
  // the workspace root tree. The two scopes never mix because they are stored
  // in different config files.
  const projectScopeProjectId = useMemo(() => {
    if (!hasProjectInclude) return enteredProjectDetailScopeId
    const includeIds = [...projectFilter.entries()].filter(([, mode]) => mode === 'include').map(([id]) => id)
    return includeIds.length === 1 ? includeIds[0] : null
  }, [hasProjectInclude, projectFilter, enteredProjectDetailScopeId])
  // Two folder scopes side by side: the rail tree under "All Sessions" is
  // ALWAYS the workspace root tree — it belongs to that section. The project's
  // own tree (independent file projects/<slug>/folders.json) only replaces the
  // navigator-list scope while browsing that project's sessions, and can never
  // leak into the root tree because the scopes are different config files.
  const rootFolderApi = useFolders(activeWorkspaceId ?? null, { projectId: null })
  const projectFolderApi = useFolders(activeWorkspaceId ?? null, { projectId: projectScopeProjectId })
  const isProjectBrowsingMode = !!enteredProjectId && projectScopeProjectId === enteredProjectId
  const isBrowsingRootTreeInProjectMode = isProjectBrowsingMode && rootFolderBrowseId !== undefined
  // Scope-following API: the navigator normally follows the project include,
  // but a folder explicitly opened from the root rail browses the root tree.
  const activeFolderApi = isBrowsingRootTreeInProjectMode
    ? rootFolderApi
    : projectScopeProjectId ? projectFolderApi : rootFolderApi
  const activeFolderIds = React.useMemo(
    () => new Set(activeFolderApi.folders.map(folder => folder.id)),
    [activeFolderApi.folders],
  )

  // A folder scope id only means something inside its own tree. Switching
  // scopes (project ↔ root) or deleting the folder would otherwise keep
  // filtering the new tree by an id it does not own, which hides every session
  // and leaves the navigator showing an empty list. Drop the stale id instead.
  const rootFolderIds = React.useMemo(() => new Set(rootFolderApi.folders.map(folder => folder.id)), [rootFolderApi.folders])
  const projectFolderIds = React.useMemo(() => new Set(projectFolderApi.folders.map(folder => folder.id)), [projectFolderApi.folders])
  const rawFolderScopeId = isBrowsingRootTreeInProjectMode ? rootFolderBrowseId! : folderScopeId
  // A scope id that no longer exists in the active tree is treated as "root of
  // this scope" for filtering purposes — without touching the state, so the
  // navigator keeps showing exactly what the user selected.
  const activeFolderScopeId = rawFolderScopeId && (rootFolderIds.has(rawFolderScopeId) || projectFolderIds.has(rawFolderScopeId))
    ? rawFolderScopeId
    : null
  // NOTE: no effect may clear `folderScopeId` here. A moved/deleted folder used
  // to be validated in an effect, but that re-scoped the navigator mid-gesture —
  // dropping a folder into another tree made left-2 jump to a different list and
  // the drag looked like it did nothing. Dangling ids are neutralised at render
  // time instead (see `folderIdOf` / `activeFolderIdForList`).

  const { pages } = usePages(activeWorkspaceId)
  const projectMenuOptions = useMemo(
    () => projects.map(p => ({ id: p.config.id, slug: p.config.slug, name: p.config.name, color: p.config.color })),
    [projects],
  )
  const handleSessionProjectChange = useCallback(async (sessionId: string, projectId: string | null) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setProjectId', projectId })
    } catch (err) {
      console.error('[AppShell] Failed to update session project:', err)
      toast.error(t('toast.failedToUpdateProject'))
    }
  }, [t])

  // Whether local MCP servers are enabled (affects stdio source status)
  const [localMcpEnabled, setLocalMcpEnabled] = React.useState(true)

  // Enabled permission modes for Shift+Tab cycling (min 2 modes)
  const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>(['safe', 'ask', 'allow-all'])

  // Load workspace settings (for localMcpEnabled and cyclablePermissionModes) on workspace change
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getWorkspaceSettings(activeWorkspaceId).then((settings) => {
      if (settings) {
        setLocalMcpEnabled(settings.localMcpEnabled ?? true)
        // Load cyclablePermissionModes from workspace settings
        if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
          setEnabledModes(settings.cyclablePermissionModes)
        }
      }
    }).catch((err) => {
      console.error('[Chat] Failed to load workspace settings:', err)
    })
  }, [activeWorkspaceId])

  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

      // Clear focused sidebar item
      setFocusedSidebarItemId(null)
    }

    // Load workspace-scoped state on BOTH initial mount AND workspace switch
    // This fixes CMD+R losing filters - previously only ran on workspace switch
    if (previousWorkspaceId !== activeWorkspaceId) {
      const newViewFilters = storage.get<ViewFiltersMap>(storage.KEYS.viewFilters, {}, activeWorkspaceId)
      setViewFiltersMap(newViewFilters)

      const newExpandedFolders = storage.get<string[]>(storage.KEYS.expandedFolders, [], activeWorkspaceId)
      setExpandedFolders(new Set(newExpandedFolders))

      const newCollapsedItems = storage.get<string[] | null>(storage.KEYS.collapsedSidebarItems, null, activeWorkspaceId)
      setCollapsedItems(newCollapsedItems !== null ? new Set(newCollapsedItems) : new Set())
    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Load sources from backend on mount
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getSources(activeWorkspaceId).then((loaded) => {
      setSources(loaded || [])
    }).catch(err => {
      console.error('[Chat] Failed to load sources:', err)
    })
  }, [activeWorkspaceId])

  // Load usage stats from backend (source & skill usage counts / last-used)
  const usageStatsReloadRef = React.useRef<{ timer?: ReturnType<typeof setTimeout>; seq: number }>({ seq: 0 })
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getUsageStats(activeWorkspaceId).then((stats) => {
      setUsageStats(stats ?? { sources: {}, skills: {} })
    }).catch(err => {
      console.error('[Chat] Failed to load usage stats:', err)
    })
  }, [activeWorkspaceId])

  // Refresh usage stats when source/skill calls complete. Debounced so a burst
  // of tool calls hits the RPC once.
  React.useEffect(() => {
    const reloadRef = usageStatsReloadRef.current
    const cleanup = window.electronAPI.onSessionEvent((event) => {
      if (!shouldRefreshUsageStats(event)) return

      if (reloadRef.timer) clearTimeout(reloadRef.timer)
      reloadRef.timer = setTimeout(() => {
        reloadRef.timer = undefined
        if (!activeWorkspaceId) return
        const seq = ++reloadRef.seq
        window.electronAPI.getUsageStats(activeWorkspaceId).then((stats) => {
          if (seq === reloadRef.seq) setUsageStats(stats ?? { sources: {}, skills: {} })
        }).catch(() => { /* best-effort refresh */ })
      }, 1500)
    })
    return () => {
      cleanup()
      if (reloadRef.timer) clearTimeout(reloadRef.timer)
    }
  }, [activeWorkspaceId])

  // Subscribe to live source updates (when sources are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSourcesChanged((workspaceId, updatedSources) => {
      if (workspaceId !== activeWorkspaceId) return
      // Clear icon cache so updated source icons are re-fetched on render
      clearSourceIconCaches()
      setSources(updatedSources || [])
    })
    return cleanup
  }, [activeWorkspaceId])

  // Subscribe to live skill updates (when skills are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSkillsChanged((workspaceId, updatedSkills) => {
      if (workspaceId !== activeWorkspaceId) return
      setSkills(updatedSkills || [])
    })
    return cleanup
  }, [activeWorkspaceId])

  // Handle session source selection changes
  const handleSessionSourcesChange = React.useCallback(async (sessionId: string, sourceSlugs: string[], sourceScope?: 'auto' | 'only' | 'exclude') => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setSources', sourceSlugs, sourceScope })
      // Session will emit a 'sources_changed' event that updates the session state
    } catch (err) {
      console.error('[Chat] Failed to set session sources:', err)
    }
  }, [])

  // Ensure session messages are loaded when selected
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  // Handle selecting a source from the list (preserves current filter type)
  const handleSourceSelect = React.useCallback((source: LoadedSource) => {
    if (!activeWorkspaceId) return
    navigateToSource(source.config.slug)
  }, [activeWorkspaceId, navigateToSource])

  // Handle selecting a skill from the list
  const handleSkillSelect = React.useCallback((skill: LoadedSkill) => {
    if (!activeWorkspaceId) return
    navigate(routes.view.skills(skill.slug))
  }, [activeWorkspaceId, navigate])

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Register focus zones
  const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({ zoneId: 'sidebar' })

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))
  useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !document.querySelector('[role="dialog"]') })

  // Shift+Tab cycles permission mode through enabled modes (textarea handles its own, this handles when focus is elsewhere)
  // In multi-panel, targets the focused panel's session
  const effectiveSessionId = focusedSessionId ?? session.selected

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

  useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = contextValue.sessionOptions.get(effectiveSessionId) ?? contextValue.workspaceDefaultSessionOptions
      const currentMode = currentOptions?.permissionMode ?? 'ask'
      // Cycle through enabled permission modes
      const modes = enabledModes.length >= 2 ? enabledModes : ['safe', 'ask', 'allow-all'] as PermissionMode[]
      const currentIndex = modes.indexOf(currentMode)
      // If current mode not in enabled list, jump to first enabled mode
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]
      contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

  const handleToggleSidebar = useCallback(() => {
    if (isSidebarAndNavigatorHidden) {
      setIsSidebarAndNavigatorHidden(false)
      return
    }
    setIsSidebarVisible(v => !v)
  }, [isSidebarAndNavigatorHidden])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', handleToggleSidebar)

  // Focus mode toggle (CMD+.) - hides both sidebars
  const handleToggleFocusMode = React.useCallback(() => {
    setIsSidebarAndNavigatorHidden(v => !v)
  }, [])
  useAction('view.toggleFocusMode', handleToggleFocusMode)

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })
  useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
  useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction('chat.stopProcessing', () => {
    if (effectiveSessionId) {
      const meta = sessionMetaMap.get(effectiveSessionId)
      if (meta?.isProcessing) {
        // handleEscapePress returns true on second press (within timeout)
        const shouldInterrupt = handleEscapePress()
        if (shouldInterrupt) {
          window.electronAPI.cancelProcessing(effectiveSessionId, false).catch(err => {
            console.error('[AppShell] Failed to cancel processing:', err)
          })
        }
      }
    }
  }, {
    // Only active when no overlay is open and session is processing
    // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
    enabled: () => {
      if (hasOpenOverlay()) return false
      if (!effectiveSessionId) return false
      const meta = sessionMetaMap.get(effectiveSessionId)
      return meta?.isProcessing ?? false
    }
  }, [effectiveSessionId, handleEscapePress])

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'))

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: { files: filesArray, sessionId: targetSessionId }
      }))
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  // Resize effect for sidebar, session list, browser host lane, and metadata right sidebar.
  React.useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing === 'sidebar') {
        const newWidth = Math.min(Math.max(e.clientX, 180), 320)
        setSidebarWidth(newWidth)
        if (resizeHandleRef.current) {
          const rect = resizeHandleRef.current.getBoundingClientRect()
          setSidebarHandleY(e.clientY - rect.top)
        }
      } else if (isResizing === 'session-list') {
        const offset = isSidebarVisible ? sidebarWidth : 0
        const newWidth = Math.min(Math.max(e.clientX - offset, 240), 480)
        setSessionListWidth(newWidth)
        if (sessionListHandleRef.current) {
          const rect = sessionListHandleRef.current.getBoundingClientRect()
          setSessionListHandleY(e.clientY - rect.top)
        }
      }
    }

    const handleMouseUp = () => {
      if (isResizing === 'sidebar') {
        storage.set(storage.KEYS.sidebarWidth, sidebarWidth)
        setSidebarHandleY(null)
      } else if (isResizing === 'session-list') {
        storage.set(storage.KEYS.sessionListWidth, sessionListWidth)
        setSessionListHandleY(null)
      }
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    isResizing,
    sidebarWidth,
    sessionListWidth,
    isSidebarVisible,
  ])

  // Spring transition config - shared between sidebar and header
  // Critical damping (no bounce): damping = 2 * sqrt(stiffness * mass)
  const springTransition = {
    type: "spring" as const,
    stiffness: 600,
    damping: 49,
  }

  // Use session metadata from Jotai atom (lightweight, no messages)
  // This prevents closures from retaining full message arrays
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  sessionMetaMapRef.current = sessionMetaMap as ReadonlyMap<string, { projectId?: string; folderId?: string | null }>
  const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

  const hasPendingPrompt = React.useCallback((sessionId: string) => {
    return (pendingPermissions.get(sessionId)?.length ?? 0) > 0
  }, [pendingPermissions])

  // Workspace-level unread indicators (needed for workspace selectors across all workspaces)
  const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<Record<string, boolean>>({})

  // Reload skills when active session's workingDirectory changes (for project-level skills)
  // Skills are loaded from: global (~/.agents/skills/), workspace, and project ({workingDirectory}/.agents/skills/)
  const activeSessionWorkingDirectory = session.selected
    ? sessionMetaMap.get(session.selected)?.workingDirectory
    : undefined
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getSkills(activeWorkspaceId, activeSessionWorkingDirectory).then((loaded) => {
      setSkills(loaded || [])
    }).catch(err => {
      console.error('[Chat] Failed to load skills:', err)
    })
  }, [activeWorkspaceId, activeSessionWorkingDirectory])

  // Filter session metadata by active workspace
  // Also exclude hidden sessions (mini-agent sessions) from all counts and lists
  // For remote workspaces, sessions have the remote workspace ID (not the local one),
  // so we match against both the local and remote workspace IDs.
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId
  const workspaceSessionMetas = useMemo(() => {
    const metas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return metas.filter(s => !s.hidden)
    return metas.filter(s =>
      !s.hidden && (s.workspaceId === activeWorkspaceId || (remoteWorkspaceId && s.workspaceId === remoteWorkspaceId))
    )
  }, [sessionMetaMap, activeWorkspaceId, remoteWorkspaceId])

  // Active sessions exclude archived - use this for all counts and filters except archived view
  const activeSessionMetas = useMemo(() => {
    return workspaceSessionMetas.filter(s => !s.isArchived)
  }, [workspaceSessionMetas])

  const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }

      setWorkspaceUnreadMap(next)
    } catch (error) {
      console.error('[AppShell] Failed to refresh workspace unread indicators:', error)
    }
  }, [workspaces])

  // Initial + workspace-list refresh
  useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

  // Keep active workspace unread indicator in sync with live metadata updates
  useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some((session) => !!session.hasUnread)
    setWorkspaceUnreadMap((prev) => ({ ...prev, [activeWorkspaceId]: activeHasUnread }))
  }, [activeWorkspaceId, activeSessionMetas])

  // Keep cross-workspace indicators in sync with global unread updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }
      setWorkspaceUnreadMap(next)
    })

    return cleanup
  }, [workspaces])

  // Count sessions by todo state (scoped to workspace)
  const archivedCount = workspaceSessionMetas.filter(s => s.isArchived).length

  // Count sources by type for the Sources dropdown subcategories
  const sourceTypeCounts = useMemo(() => {
    const counts = { api: 0, mcp: 0, local: 0 }
    for (const source of sources) {
      const t = source.config.type
      if (t === 'api' || t === 'mcp' || t === 'local') {
        counts[t]++
      }
    }
    return counts
  }, [sources])

  // Filter session metadata based on sidebar mode and chat filter
  const filteredSessionMetas = useMemo(() => {
    // When in sources mode, return empty (no sessions to show)
    if (!sessionFilter) {
      return []
    }

    let result: SessionMeta[]

    switch (sessionFilter.kind) {
      case 'allSessions':
        // "All Sessions" - shows active (non-archived) sessions
        result = activeSessionMetas
        break
      case 'archived':
        // Archived view shows only archived sessions
        result = workspaceSessionMetas.filter(s => s.isArchived)
        break
      default:
        result = activeSessionMetas
    }

    if (isBrowsingRootTreeInProjectMode) {
      // The root-tree action changes only the left-2 browsing scope. Keep the
      // project rail in mode 2, while showing sessions filed in the root tree.
      result = result.filter(s => !(s as { projectId?: string }).projectId)
      const folderScopeId = rootFolderBrowseId ?? null
      result = searchActive && searchQuery.trim().length > 0 && sessionFilter.kind !== 'archived'
        ? filterSessionsByFolderSearchScope(
            result,
            folderScopeId,
            getFolderSubtreeIds(activeFolderApi.folders, folderScopeId),
            activeFolderIds,
          )
        : filterSessionsByFolderScope(result, folderScopeId, activeFolderIds)
    } else {
      // D9: the root domain never shows project-bound sessions. Two exceptions:
      // the archive view stays global (D10), and an explicit project include —
      // the jump-to-project state — is the user asking for exactly those
      // sessions; applying D9 first would always leave that list empty.
      if (sessionFilter.kind !== 'archived' && !hasProjectInclude) {
        result = result.filter(s => !(s as { projectId?: string }).projectId)
      }

      // Folder scope narrows within the active tree — always, and with the same
      // rule as the root tree: inside a folder only its own sessions, at the
      // scope root only unfiled ones. Leaving the project branch unfiltered used
      // to list every project session (including ones filed in a folder) at the
      // project root, so the same session appeared twice — under its folder and
      // at the root — and deleting it made both rows vanish.
      const folderScopeId = activeFolderScopeId ?? null
      result = searchActive && searchQuery.trim().length > 0 && sessionFilter.kind !== 'archived'
        ? filterSessionsByFolderSearchScope(
            result,
            folderScopeId,
            getFolderSubtreeIds(activeFolderApi.folders, folderScopeId),
            activeFolderIds,
          )
        : filterSessionsByFolderScope(result, folderScopeId, activeFolderIds)
    }

    // Apply secondary filters (project, AND-ed) in ALL views.
    // These layer on top of the primary sessionFilter to allow further narrowing.
    // Each filter supports include/exclude modes:
    //   - Includes: if any exist, only matching items pass
    //   - Excludes: matching items are removed (applied after includes)

    // Filter by project — supports include/exclude on session.projectId
    if (!isBrowsingRootTreeInProjectMode && projectFilter.size > 0) {
      const projectIncludes = new Set<string>()
      const projectExcludes = new Set<string>()
      for (const [id, mode] of projectFilter) {
        if (mode === 'include') projectIncludes.add(id)
        else projectExcludes.add(id)
      }
      if (projectIncludes.size > 0) {
        result = result.filter(s => {
          const pid = (s as { projectId?: string }).projectId
          return pid !== undefined && projectIncludes.has(pid)
        })
      }
      if (projectExcludes.size > 0) {
        result = result.filter(s => {
          const pid = (s as { projectId?: string }).projectId
          return pid === undefined || !projectExcludes.has(pid)
        })
      }
    }

    return result
  }, [workspaceSessionMetas, activeSessionMetas, sessionFilter, projectFilter, hasProjectInclude, activeFolderScopeId, rootFolderBrowseId, isBrowsingRootTreeInProjectMode, projectScopeProjectId, activeFolderIds, searchActive, searchQuery, activeFolderApi.folders])

  // Ensure session messages are loaded when selected
  React.useEffect(() => {
    if (session.selected) {
      ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, ensureMessagesLoaded])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession({ selected: null })
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])

  // Extend context value with local overrides (wrapped onDeleteSession, sources, skills, enabledModes, rightSidebarOpenButton)
  const appShellContextValue = React.useMemo<AppShellContextType>(() => ({
    ...contextValue,
    onDeleteSession: handleDeleteSession,
    enabledSources: sources,
    skills,
    activeSessionWorkingDirectory,
    enabledModes,
    onSessionSourcesChange: handleSessionSourcesChange,
    rightSidebarButton: null,
    isCompactMode: isAutoCompact,
    // Focus mode (drives the zoom in/out button in the session header)
    isFocusMode: isSidebarAndNavigatorHidden,
    onToggleFocusMode: handleToggleFocusMode,
    // Search state for ChatDisplay highlighting
    sessionListSearchQuery: searchActive ? searchQuery : undefined,
    isSearchModeActive: searchActive,
    chatSearchHandoff,
    onChatSearchHandoffConsumed: handleChatSearchHandoffConsumed,
    chatDisplayRef,
    onChatMatchInfoChange: handleChatMatchInfoChange,
  }), [contextValue, handleDeleteSession, sources, skills, activeSessionWorkingDirectory, enabledModes, handleSessionSourcesChange, isAutoCompact, isSidebarAndNavigatorHidden, handleToggleFocusMode, searchActive, searchQuery, chatSearchHandoff, handleChatSearchHandoffConsumed, handleChatMatchInfoChange])

  // Persist expanded folders to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.expandedFolders, [...expandedFolders], activeWorkspaceId)
  }, [expandedFolders, activeWorkspaceId])

  // Persist sidebar visibility to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.sidebarVisible, isSidebarVisible)
  }, [isSidebarVisible])

  // Persist focus mode state to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isSidebarAndNavigatorHidden)
  }, [isSidebarAndNavigatorHidden])

  // Listen for focus mode toggle from menu (View → Focus Mode)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      handleToggleFocusMode()
    })
    return cleanup
  }, [])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  // Persist per-view filter map to localStorage (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.viewFilters, viewFiltersMap, activeWorkspaceId)
  }, [viewFiltersMap, activeWorkspaceId])

  // Persist sidebar section collapsed states (workspace-scoped)
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    storage.set(storage.KEYS.collapsedSidebarItems, [...collapsedItems], activeWorkspaceId)
  }, [collapsedItems, activeWorkspaceId])

  const handleAllSessionsClick = useCallback(() => {
    // Explicit root navigation: drop any folder scope, otherwise the list would
    // stay narrowed to the folder and the title would keep its path. A project
    // include is dropped too — the root list is the unscoped session list; the
    // project entry re-applies it on demand. The rail exits Mode 2 as well.
    setEnteredProjectId(null)
    setFolderScopeId(null)
    setRootFolderBrowseId(undefined)
    setViewFiltersMap(prev => {
      const entry = prev['allSessions']
      if (!entry || Object.keys(entry.projects ?? {}).length === 0) return prev
      return { ...prev, allSessions: { projects: {} } }
    })
    navigate(routes.view.allSessions())
  }, [])

  const handleArchivedClick = useCallback(() => {
    // The archive list is global (D10) — it must not inherit a folder filter.
    setEnteredProjectId(null)
    setFolderScopeId(null)
    setRootFolderBrowseId(undefined)
    navigate(routes.view.archived())
  }, [])

  // Leave the project browsing state (rail Mode 2): back to the entries list
  // and the root session list — the same navigation as "All Sessions".
  const handleExitProjectBrowsing = useCallback(() => {
    setRootFolderBrowseId(undefined)
    handleAllSessionsClick()
  }, [handleAllSessionsClick])

  // Double-clicking the project header returns the navigator to this project's
  // folder root without leaving mode 2 or dropping its project include filter.
  const handleProjectRootDoubleClick = useCallback(() => {
    setRootFolderBrowseId(undefined)
    setFolderScopeId(null)
    navigate(routes.view.allSessions())
  }, [])

  // Handler for sources view (all sources)
  const handleSourcesClick = useCallback(() => {
    navigate(routes.view.sources())
  }, [])

  // Handlers for source type filter views (subcategories in Sources dropdown)
  const handleSourcesApiClick = useCallback(() => {
    navigate(routes.view.sourcesApi())
  }, [])

  const handleSourcesMcpClick = useCallback(() => {
    navigate(routes.view.sourcesMcp())
  }, [])

  const handleSourcesLocalClick = useCallback(() => {
    navigate(routes.view.sourcesLocal())
  }, [])

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

  // Handler for projects view
  const handleProjectsClick = useCallback(() => {
    navigate(routes.view.projects())
  }, [])

  // Handler for automations views (all / scheduled / event / agentic)
  const handleAutomationsClick = useCallback(() => {
    navigate(routes.view.automations())
  }, [])
  const handleAutomationsScheduledClick = useCallback(() => {
    navigate(routes.view.automationsScheduled())
  }, [])
  const handleAutomationsEventClick = useCallback(() => {
    navigate(routes.view.automationsEvent())
  }, [])
  const handleAutomationsAgenticClick = useCallback(() => {
    navigate(routes.view.automationsAgentic())
  }, [])

  // Handler for pages view
  const handlePagesClick = useCallback(() => {
    navigate(routes.view.pages())
  }, [])

  // Open settings in its dedicated window. A missing subpage keeps the
  // navigator-only `settings` entry and resolves to the app page in the window.
  const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    void openSettingsWindow(subpage ? `settings/${subpage}` : 'settings', activeWorkspaceId ?? undefined)
  }, [activeWorkspaceId])

  // Handler for What's New overlay
  const handleWhatsNewClick = useCallback(async () => {
    const content = await window.electronAPI.getReleaseNotes()
    setReleaseNotesContent(content)
    setShowWhatsNew(true)
    setHasUnseenReleaseNotes(false)
    // Update last seen version
    const latestVersion = await window.electronAPI.getLatestReleaseVersion()
    if (latestVersion) {
      storage.set(storage.KEYS.whatsNewLastSeenVersion, latestVersion)
    }
  }, [])

  // ============================================================================
  // EDIT POPOVER STATE
  // ============================================================================
  // State to control which EditPopover is open (triggered from context menus).
  // We use controlled popovers instead of deep links so the user can type
  // their request in the popover UI before opening a new chat window.
  // add-source variants: add-source (generic), add-source-api, add-source-mcp, add-source-local
  const [editPopoverOpen, setEditPopoverOpen] = useState<'add-source' | 'add-source-api' | 'add-source-mcp' | 'add-source-local' | 'add-skill' | 'add-project' | null>(null)

  // Stores the Y position of the last right-clicked sidebar item so the EditPopover
  // appears near it rather than at a fixed location. Updated synchronously before
  // the setTimeout that opens the popover, ensuring the ref is set before render.
  const editPopoverAnchorY = useRef<number>(120)

  // Stores the trigger element (button) so we can keep it highlighted while the
  // EditPopover is open (after Radix removes data-state="open" on context menu close).
  const editPopoverTriggerRef = useRef<Element | null>(null)

  // Captures the bounding rect of the currently-open context menu trigger (the button).
  // Radix sets data-state="open" on the button (via ContextMenuTrigger asChild)
  // while the menu is visible, so we can locate it in the DOM at click time.
  const captureContextMenuPosition = useCallback(() => {
    const trigger = document.querySelector('.group\\/section > [data-state="open"]')
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      editPopoverAnchorY.current = rect.top
      editPopoverTriggerRef.current = trigger
    }
  }, [])

  // Sync data-edit-active attribute on the trigger element with EditPopover open state.
  // This keeps the sidebar item visually highlighted while the popover is shown,
  // since Radix's data-state="open" disappears when the context menu closes.
  useEffect(() => {
    const el = editPopoverTriggerRef.current
    if (!el) return
    if (editPopoverOpen) {
      el.setAttribute('data-edit-active', 'true')
    } else {
      el.removeAttribute('data-edit-active')
      editPopoverTriggerRef.current = null
    }
  }, [editPopoverOpen])

  // Handler for "Add Source" context menu action
  // Opens the EditPopover for adding a new source
  // Optional sourceType param allows filter-aware context (from subcategory menus or filtered views)
  const openAddSource = useCallback((sourceType?: 'api' | 'mcp' | 'local') => {
    captureContextMenuPosition()
    const key = sourceType ? `add-source-${sourceType}` as const : 'add-source' as const
    setTimeout(() => setEditPopoverOpen(key), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Skill" context menu action
  // Opens the EditPopover for adding a new skill
  const openAddSkill = useCallback(() => {
    captureContextMenuPosition()
    setTimeout(() => setEditPopoverOpen('add-skill'), 50)
  }, [captureContextMenuPosition])

  // Handler for "Add Project" context menu action — creates a project directly
  // Open the "Create Project" dialog so the user can provide a name up front.
  // The previous flow auto-created with the default name and produced ugly
  // permanent slugs (new-project, new-project-1, …).
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false)
  const openAddProject = useCallback(() => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(true)
  }, [activeWorkspace?.id])
  const handleCreateProjectSubmit = useCallback(async (name: string) => {
    if (!activeWorkspace?.id) return
    setCreateProjectDialogOpen(false)
    try {
      const project = await window.electronAPI.createProject(activeWorkspace.id, { name })
      navigate(routes.view.projects(project.slug))
    } catch (err) {
      console.error('[AppShell] Failed to create project:', err)
      toast.error(t('projectsList.createFailed'))
    }
  }, [activeWorkspace?.id, navigate, t])

  /**
   * Resolve the "inherit sole active filter" rule for new sessions: creating
   * from a list narrowed to exactly one project include binds the new session
   * to that project (#970: exclusions are never inherited).
   */
  const resolveInheritedNewSessionParams = useCallback(() => {
    // The selected folder decides the scope, not the project include: a root-tree
    // folder must NOT inherit the included project, or its id is foreign to that
    // project's tree — the binding gets dropped and the new session lands at the
    // project root, invisible in the list it was created from.
    const folderId = activeFolderScopeId
    if (folderId) {
      if (projectScopeProjectId && projectFolderIds.has(folderId)) {
        return { project: projectScopeProjectId, folder: folderId }
      }
      if (rootFolderIds.has(folderId)) return { folder: folderId }
      // Unknown id (stale or deleted folder): fall through to the plain filter rule.
    }
    return resolveInheritedFilterParams(projectFilter)
  }, [projectFilter, activeFolderScopeId, projectScopeProjectId, projectFolderIds, rootFolderIds])

  // Create a new chat and select it
  const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and clear the query so the list isn't filtered during/after creation.
    setSearchActive(false)
    setSearchQuery('')

    // Inherit the current view's status (e.g. creating from the Backlog list
    // creates a Backlog session in-place) or, when unambiguous, a sole include filter.
    const inherited = resolveInheritedNewSessionParams()

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(inherited ?? undefined),
      newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined
    )

    // Focus the chat input after navigation completes. moveFocus:false keeps
    // the zone state correct (hotkey context) but defers DOM focus to the queued
    // mechanism dispatched by NavigationContext after the new session exists —
    // synchronous focus mid-render races Windows TSF IME context registration.
    setTimeout(() => focusZone('chat', { intent: 'programmatic', moveFocus: false }), 50)
  }, [activeWorkspace, focusZone, navigate, resolveInheritedNewSessionParams])

  // Create a brand new dedicated browser window and focus it.
  // Intentionally unbound: this action should always create a NEW window.
  const handleNewBrowserWindow = useCallback(async () => {
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: true,
      })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (error) {
      console.error('[Chat] Failed to create browser window:', error)
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [])

  // Delete Source - simplified since agents system is removed
  const handleDeleteSource = useCallback(async (sourceSlug: string) => {
    if (!activeWorkspace) return
    try {
      await window.electronAPI.deleteSource(activeWorkspace.id, sourceSlug)
      toast.success(t('toast.deletedSource'))
    } catch (error) {
      console.error('[Chat] Failed to delete source:', error)
      toast.error(t('toast.failedToDeleteSource'))
    }
  }, [activeWorkspace])

  // Delete Skill
  const handleDeleteSkill = useCallback(async (skillSlug: string) => {
    if (!activeWorkspace) return
    try {
      await window.electronAPI.deleteSkill(activeWorkspace.id, skillSlug)
      toast.success(t('toast.deletedSkill', { slug: skillSlug }))
    } catch (error) {
      console.error('[Chat] Failed to delete skill:', error)
      toast.error(t('toast.failedToDeleteSkill'))
    }
  }, [activeWorkspace])

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  // Unified sidebar items: nav buttons only (agents system removed)
  type SidebarItem = {
    id: string
    type: 'nav'
    action?: () => void
  }

  const unifiedSidebarItems = React.useMemo((): SidebarItem[] => {
    const result: SidebarItem[] = []

    // 1. Sessions section: All Sessions (expandable) with the folder tree + Archived
    result.push({ id: 'nav:allSessions', type: 'nav', action: handleAllSessionsClick })
    result.push({ id: 'nav:archived', type: 'nav', action: handleArchivedClick })

    // 2. Sources, Skills, Projects, Pages, Settings (visual order)
    result.push({ id: 'nav:sources', type: 'nav', action: handleSourcesClick })
    result.push({ id: 'nav:skills', type: 'nav', action: handleSkillsClick })
    result.push({ id: 'nav:projects', type: 'nav', action: handleProjectsClick })
    result.push({ id: 'nav:pages', type: 'nav', action: handlePagesClick })
    result.push({ id: 'nav:settings', type: 'nav', action: () => handleSettingsClick() })
    result.push({ id: 'nav:whats-new', type: 'nav', action: handleWhatsNewClick })

    return result
  }, [handleAllSessionsClick, handleArchivedClick, handleSourcesClick, handleSkillsClick, handleProjectsClick, handlePagesClick, handleSettingsClick, handleWhatsNewClick])

  // Toggle folder expanded state
  const handleToggleFolder = React.useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // Get props for any sidebar item (unified roving tabindex pattern)
  const getSidebarItemProps = React.useCallback((id: string) => ({
    tabIndex: focusedSidebarItemId === id ? 0 : -1,
    'data-focused': focusedSidebarItemId === id,
    ref: (el: HTMLElement | null) => {
      if (el) {
        sidebarItemRefs.current.set(id, el)
      } else {
        sidebarItemRefs.current.delete(id)
      }
    },
  }), [focusedSidebarItemId])

  // Unified sidebar keyboard navigation
  const handleSidebarKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (!sidebarFocused || unifiedSidebarItems.length === 0) return

    const currentIndex = unifiedSidebarItems.findIndex(item => item.id === focusedSidebarItemId)
    const currentItem = currentIndex >= 0 ? unifiedSidebarItems[currentIndex] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const nextIndex = currentIndex < unifiedSidebarItems.length - 1 ? currentIndex + 1 : 0
        const nextItem = unifiedSidebarItems[nextIndex]
        setFocusedSidebarItemId(nextItem.id)
        sidebarItemRefs.current.get(nextItem.id)?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : unifiedSidebarItems.length - 1
        const prevItem = unifiedSidebarItems[prevIndex]
        setFocusedSidebarItemId(prevItem.id)
        sidebarItemRefs.current.get(prevItem.id)?.focus()
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        // At boundary - do nothing (Left doesn't change zones from sidebar)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        // Move to next zone (navigator) - keyboard navigation
        focusZone('navigator', { intent: 'keyboard' })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (currentItem?.type === 'nav' && currentItem.action) {
          currentItem.action()
        }
        break
      }
      case 'Home': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const firstItem = unifiedSidebarItems[0]
          setFocusedSidebarItemId(firstItem.id)
          sidebarItemRefs.current.get(firstItem.id)?.focus()
        }
        break
      }
      case 'End': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const lastItem = unifiedSidebarItems[unifiedSidebarItems.length - 1]
          setFocusedSidebarItemId(lastItem.id)
          sidebarItemRefs.current.get(lastItem.id)?.focus()
        }
        break
      }
    }
  }, [sidebarFocused, unifiedSidebarItems, focusedSidebarItemId, focusZone])

  // Focus sidebar item when sidebar zone gains focus
  React.useEffect(() => {
    if (sidebarFocused && unifiedSidebarItems.length > 0) {
      // Set focused item if not already set
      const itemId = focusedSidebarItemId || unifiedSidebarItems[0].id
      if (!focusedSidebarItemId) {
        setFocusedSidebarItemId(itemId)
      }
      // Actually focus the DOM element
      requestAnimationFrame(() => {
        sidebarItemRefs.current.get(itemId)?.focus()
      })
    }
  }, [sidebarFocused, focusedSidebarItemId, unifiedSidebarItems])

  /**
   * Empty-space right-click inside the navigator (left-2) panel.
   *
   * Rows own their own menus (session menu, folder menu, toolbars), so anything
   * inside an interactive row is left alone — only genuine background opens
   * this one. This is the entry point for "New Folder" now that the folder tree
   * lives in this panel instead of the nav rail.
   */
  const handleListBackgroundContextMenu = React.useCallback((event: React.MouseEvent) => {
    if (!isSessionsNavigation(navState)) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [role="menuitem"], [role="menu"], [data-session-id], [data-folder-id], [data-sidebar-item]')) {
      return
    }
    event.preventDefault()
    setListMenu({ x: event.clientX, y: event.clientY })
  }, [navState])

  // Dismiss the panel menu: any click outside it, Escape, or a scroll.
  React.useEffect(() => {
    if (!listMenu) return
    const close = () => setListMenu(null)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [listMenu])

  // Get title based on navigation state
  /**
   * Sessions per folder for the CURRENT scope, consumed by the navigator's folder
   * rows (badge on the right). Counted over all workspace sessions, not the
   * filtered set, so the number means "what is in there", not "what matches".
   */
  const folderSessionCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    const scopedSessions = projectScopeProjectId && !isBrowsingRootTreeInProjectMode
      ? workspaceSessionMetas.filter(meta => (meta as { projectId?: string }).projectId === projectScopeProjectId)
      : workspaceSessionMetas.filter(meta => !(meta as { projectId?: string }).projectId)
    for (const meta of scopedSessions) {
      const folderId = meta.folderId ?? null
      // Same ownership rule as the list: an id this tree does not own cannot
      // count toward a folder badge.
      if (!folderId || !activeFolderIds.has(folderId)) continue
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1)
    }
    return counts
  }, [workspaceSessionMetas, projectScopeProjectId, isBrowsingRootTreeInProjectMode, activeFolderIds])

  const listTitle = React.useMemo(() => {
    // Folder path is shown from the selected leaf back toward its scope base.
    const titleWithBase = (base: string): React.ReactNode => {
      const pathParts = getFolderPathParts(activeFolderApi.folders, activeFolderScopeId, base)
      if (pathParts.length <= 1) return base
      const currentName = pathParts[0]
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-semibold">{currentName}</span>
          <span className="shrink-0 text-muted-foreground/50">/</span>
          <span className="min-w-0 truncate text-muted-foreground">{pathParts.slice(1).join(' / ')}</span>
        </span>
      )
    }

    // Sources navigator
    if (isSourcesNavigation(navState)) {
      return t("sidebar.sources")
    }

    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t("sidebar.allSkills")
    }

    // Projects navigator — a specific project is its own base ("以独立项目为基"),
    // not "所有项目". The base is the project's name; the folder path rides on
    // top of it exactly like on "所有会话".
    if (isProjectsNavigation(navState)) {
      if (navState.details?.type === 'project') {
        const project = projects.find(p => p.config.slug === navState.details?.projectSlug)
        if (project) return titleWithBase(project.config.name)
      }
      return t("sidebar.allProjects")
    }

    // Pages navigator
    if (isPagesNavigation(navState)) {
      return t("sidebar.allPages")
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t("sidebar.allAutomations")
      switch (automationFilter.automationType) {
        case 'scheduled': return t("sidebar.scheduled")
        case 'event': return t("sidebar.eventBased")
        case 'agentic': return t("sidebar.agentic")
        default: return t("sidebar.allAutomations")
      }
    }

    // Settings navigator
    if (isSettingsNavigation(navState)) return t("sidebar.settings")

    // Sessions navigator - use sessionFilter
    if (!sessionFilter) return t("sidebar.allSessions")

    // Project scope: the jumped-to project is the base, and its own tree
    // supplies the folder path on top (same titleWithBase grammar).
    if (projectScopeProjectId && !isBrowsingRootTreeInProjectMode) {
      const project = projects.find(p => p.config.id === projectScopeProjectId)
      if (project) return titleWithBase(project.config.name)
    }

    return titleWithBase(t("sidebar.allSessions"))
  }, [navState, t, sessionFilter, activeFolderScopeId, activeFolderApi.folders, projects, projectScopeProjectId, isBrowsingRootTreeInProjectMode])

  /**
   * Parent of the folder currently in scope (null at root). Drives the header's
   * back button: the breadcrumb is the way "down", this is the way "up".
   */
  const parentFolderId = React.useMemo(() => {
    if (!activeFolderScopeId) return null
    const folder = activeFolderApi.folders.find(f => f.id === activeFolderScopeId)
    return folder?.parentId ?? null
  }, [activeFolderScopeId, activeFolderApi.folders])

  const handleGoToParentFolder = React.useCallback(() => {
    if (isBrowsingRootTreeInProjectMode) {
      setRootFolderBrowseId(parentFolderId)
      return
    }
    if (isProjectBrowsingMode) {
      projectFolderSectionRef.current?.collapseFolders(
        getFolderIdsToCollapseOnAncestorNavigation(projectFolderApi.folders, folderScopeId, parentFolderId),
      )
    }
    setFolderScopeId(parentFolderId)
  }, [folderScopeId, isBrowsingRootTreeInProjectMode, isProjectBrowsingMode, parentFolderId, projectFolderApi.folders])

  return (
    <AppShellProvider value={appShellContextValue}>
        {/* === TOP BAR === */}
        <TopBar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          workspaceUnreadMap={workspaceUnreadMap}
          onWorkspaceCreated={() => onRefreshWorkspaces?.()}
          onWorkspaceRemoved={() => onRefreshWorkspaces?.()}
          activeSessionId={effectiveSessionId}
          onNewChat={() => handleNewChat()}
          onNewWindow={() => window.electronAPI.menuNewWindow()}
          onOpenSettings={onOpenSettings}
          onOpenSettingsSubpage={handleSettingsClick}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onBack={goBack}
          onForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onToggleSidebar={handleToggleSidebar}
          onToggleFocusMode={() => setIsSidebarAndNavigatorHidden(prev => !prev)}
          onAddSessionPanel={() => handleNewChat(true)}
          onAddBrowserPanel={() => { void handleNewBrowserWindow() }}
          isCompact={isAutoCompact}
        />

      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingBottom: isAutoCompact ? 0 : PANEL_EDGE_INSET,
          paddingLeft: 0,
          gap: PANEL_GAP,
        }}
      >
        <PanelStackContainer
          sidebarSlot={
            <div
              ref={sidebarRef}
              style={{ width: sidebarWidth }}
              className="h-full font-sans relative"
              data-focus-zone="sidebar"
              tabIndex={sidebarFocused ? 0 : -1}
              onKeyDown={handleSidebarKeyDown}
            >
            <div className="flex h-full flex-col select-none">
              {/* Sidebar Top Section */}
              <div className="flex-1 flex flex-col min-h-0">
                {/* Primary Nav: Projects | All Sessions (▸ folders, Archived) | Sources, Skills, Pages, Settings */}
                {/* pb-4 provides clearance so the last item scrolls above the mask-fade-bottom gradient */}
                <div className="flex-1 overflow-y-auto min-h-0 mask-fade-bottom pb-4">
                <LeftSidebar
                  isCollapsed={false}
                  getItemProps={getSidebarItemProps}
                  focusedItemId={focusedSidebarItemId}
                  links={[
                    // --- Projects (top: a project is the broadest scope a
                    // session can belong to, so it reads first) ---
                    // Two display modes: entries list (mode 1) and, once a
                    // project is entered, its own folder tree under the
                    // breadcrumb title with 设置/返回 on the right (mode 2).
                    (() => {
                      const entered = enteredProjectId
                        ? projects.find(p => p.config.id === enteredProjectId)
                        : undefined
                      // Mode 2 is only valid while the include filter still
                      // points at the entered project — otherwise the project
                      // scope hook falls back to the root tree and the rail
                      // would show root folders under 项目/xxx.
                      const inMode2 = !!entered && projectScopeProjectId === entered.config.id
                      return {
                      id: "nav:projects",
                      title: inMode2 && entered ? `${t("sidebar.projects")}/${entered.config.name}` : t("sidebar.projects"),
                      label: inMode2 ? undefined : String(projects.length),
                      icon: FolderKanban,
                      // Mode 2 browses the project — the section itself is the
                      // active scope; mode 1 highlights only on the Projects view.
                      variant: (inMode2 || isProjectsNavigation(navState)) ? "default" : "ghost",
                      // The project breadcrumb is inert in mode 2; only its
                      // explicit back button returns to the project entries.
                      onClick: inMode2 ? undefined : handleProjectsClick,
                      expandable: inMode2 || projects.length > 0,
                      // Mode 2 shows the entered project tree while the section is expanded.
                      expanded: isExpanded('nav:projects'),
                      onToggle: () => toggleExpanded('nav:projects'),
                      // Use the same rule in both modes: a single click toggles
                      // this section; a double click enters/returns to the project root.
                      clickTogglesExpand: true,
                      onDoubleClick: inMode2 ? handleProjectRootDoubleClick : undefined,
                      // Mode 2 header actions: settings page + back to mode 1.
                      afterTitle: inMode2 && entered ? (
                        <span className="flex items-center gap-1">
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t("sidebarMenu.projectSettings")}
                            data-no-dnd="true"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(routes.view.projects(entered.config.slug))
                            }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                navigate(routes.view.projects(entered.config.slug))
                              }
                            }}
                          >
                            <Settings2 className="h-4 w-4 text-muted-foreground" />
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t("common.back")}
                            data-no-dnd="true"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleExitProjectBrowsing()
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                handleExitProjectBrowsing()
                              }
                            }}
                          >
                            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
                          </span>
                        </span>
                      ) : undefined,
                      contextMenu: inMode2 && entered ? {
                        type: 'allSessions' as const,
                        onNewFolder: () => {
                          if (!isExpanded('nav:projects')) {
                            setCollapsedItems(prev => {
                              const next = new Set(prev)
                              next.delete('nav:projects')
                              return next
                            })
                            window.setTimeout(() => projectFolderSectionRef.current?.openCreate(null), 0)
                          } else {
                            projectFolderSectionRef.current?.openCreate(null)
                          }
                        },
                        onMarkAllRead: () => {
                          if (!activeWorkspaceId) return
                          setSessionMetaMap(prev => {
                            const next = new Map(prev)
                            for (const [id, meta] of next) {
                              if (meta.workspaceId === activeWorkspaceId && meta.projectId === entered.config.id && meta.hasUnread && !meta.isProcessing) {
                                next.set(id, { ...meta, hasUnread: false })
                              }
                            }
                            return next
                          })
                          void window.electronAPI.markAllSessionsRead(activeWorkspaceId, entered.config.id)
                            .catch(error => {
                              console.error('[AppShell] Failed to mark project sessions read:', error)
                              toast.error(t('folders.markReadFailed'))
                            })
                        },
                      } : {
                        type: 'projects' as const,
                        onAddProject: openAddProject,
                      },
                      onDropSession: inMode2 && entered
                        ? (sessionId: string) => { void handleDropSessionToScope(sessionId, entered.config.id, null) }
                        : undefined,
                      onDropFolder: inMode2 && entered
                        ? (folderId: string) => { void handleDropFolderToScope(folderId, dragState.projectId, entered.config.id) }
                        : undefined,
                      items: inMode2 && entered ? [
                        // The project's own folder tree — same structure as the
                        // tree under "All Sessions", backed by the project scope.
                        {
                          id: "project-folder-tree",
                          type: "custom" as const,
                          render: (
                            <FolderSection
                              ref={projectFolderSectionRef}
                              foldersApi={projectFolderApi}
                              folderScopeProjectId={entered.config.id}
                              onDropFolderAcrossScopes={(folderId, fromProjectId, targetParentId) => {
                                void handleDropFolderToScope(folderId, fromProjectId, entered.config.id, targetParentId)
                              }}
                              selectedFolderId={folderScopeId}
                              highlightFolderId={folderScopeId}
                              onSelectFolder={handleSelectProjectFolder}
                              onDropSession={(sessionId, folderId) => {
                                void handleDropSessionToScope(sessionId, entered.config.id, folderId)
                              }}
                            />
                          ),
                        },
                      ] : projects.map(p => ({
                        id: `nav:projects:${p.config.id}`,
                        title: p.config.name,
                        icon: FolderKanban,
                        // Highlight when on the project's jump view AND this is
                        // the included project; a selected folder row inside its
                        // tree takes over the highlight (same grammar as root).
                        variant: (sessionFilter?.kind === 'allSessions' && !folderScopeId && projectFilter.get(p.config.id) === 'include') ? "default" as const : "ghost" as const,
                        onClick: () => handleJumpToProjectSessions(p.config.id),
                        // Double click enters mode 2: the rail swaps the entry
                        // list for the project's own folder tree.
                        onDoubleClick: () => {
                          setRootFolderBrowseId(undefined)
                          setCollapsedItems(prev => {
                            if (!prev.has('nav:projects')) return prev
                            const next = new Set(prev)
                            next.delete('nav:projects')
                            return next
                          })
                          setEnteredProjectId(p.config.id)
                        },
                        // Cross-scope drop targets: root sessions/folders land in
                        // this project (moveToScope rebinds project + folder).
                        onDropSession: (sessionId: string) => {
                          void handleDropSessionToScope(sessionId, p.config.id, null)
                        },
                        onDropFolder: (folderId: string) => {
                          void handleDropFolderToScope(folderId, dragState.projectId, p.config.id)
                        },
                        // Settings affordance on the right: opens the project's
                        // settings page (its detail view). Hover-revealed like
                        // every other row action in this rail.
                        afterTitle: (
                          <span
                            role="button"
                            aria-label={t("sidebarMenu.projectSettings")}
                            data-no-dnd="true"
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(routes.view.projects(p.config.slug))
                            }}
                          >
                            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        ),
                        // Same shape as the session menu: details / rename / delete.
                        contextMenu: {
                          type: 'project' as const,
                          onViewDetails: () => navigate(routes.view.projects(p.config.slug)),
                          onRename: () => setRenamingProjectId(p.config.id),
                          onDelete: () => void handleDeleteProject(p.config.slug, p.config.name),
                        },
                        editing: renamingProjectId === p.config.id,
                        onRenameCommit: (value: string) => void handleRenameProject(p.config.slug, p.config.name, value),
                        onRenameCancel: () => setRenamingProjectId(null),
                      })),
                      }
                    })(),
                    // --- Sessions Section ---
                    // Folders are NOT here: the tree belongs to the "All Sessions"
                    // view's own panel (navigator column), not to the nav rail.
                    {
                      id: "nav:allSessions",
                      title: t("sidebar.allSessions"),
                      label: String(workspaceSessionMetas.length),
                      icon: Inbox,
                      // Selected only for the plain root list: inside a folder
                      // scope the folder row owns the selection, under a
                      // project include the project entry does — the rail
                      // highlights exactly one scope row at a time.
                      variant: (sessionFilter?.kind === 'allSessions' && !folderScopeId && !hasProjectInclude) ? "default" : "ghost",
                      onClick: isProjectBrowsingMode
                        ? () => handleBrowseRootFolderInProjectMode(null)
                        : handleAllSessionsClick,
                      expandable: true,
                      expanded: isExpanded('nav:allSessions'),
                      onToggle: () => toggleExpanded('nav:allSessions'),
                      // Keep the same navigation rule in every scope: a single
                      // click toggles the folder block; a double click enters the
                      // workspace root list (or the root tree while in project mode).
                      clickTogglesExpand: true,
                      // Dropping a session here files it back to the root — the only
                      // way out of a subfolder by drag. A session dragged out of a
                      // project also loses its project binding (atomic cross-scope
                      // move; the session lands at the all-sessions root).
                      onDropSession: (sessionId) => {
                        // Atomic move to the workspace root — see the note on the
                        // folder-tree drop above: never branch on cached metadata.
                        void handleDropSessionToScope(sessionId, null, null)
                        // No navigator side effects: the drop only changes the
                        // session's binding. Re-scoping left-2 here made the list
                        // jump and hid the folder the user was looking at.
                      },
                      // Folders come back to the root the same way — a nested folder
                      // dragged onto "All Sessions" is un-nested; one dragged out of
                      // a project (Mode 2 tree) moves its whole subtree across scopes.
                      onDropFolder: (folderId) => {
                        void handleDropFolderToScope(folderId, dragState.projectId, null)
                      },
                      contextMenu: {
                        type: 'allSessions',
                        // Creating a folder is an "All Sessions" action: the tree under
                        // this row is where the new node appears.
                        onNewFolder: () => folderSectionRef.current?.openCreate(null),
                        onMarkAllRead: () => {
                          if (!activeWorkspaceId) return
                          // Optimistic: clear hasUnread on all workspace session metas
                          setSessionMetaMap(prev => {
                            const next = new Map(prev)
                            for (const [id, meta] of next) {
                              if (meta.workspaceId === activeWorkspaceId && meta.hasUnread && !meta.hidden && !meta.isArchived && !meta.isProcessing) {
                                next.set(id, { ...meta, hasUnread: false })
                              }
                            }
                            return next
                          })
                          window.electronAPI.markAllSessionsRead(activeWorkspaceId)
                        },
                      },
                      items: [
                        // Folder tree — lives INSIDE "All Sessions" (nested subitems) so
                        // the rail reads: All Sessions → folders → Archived.
                        {
                          id: "folder-tree",
                          type: "custom" as const,
                          render: (
                            <FolderSection
                              ref={folderSectionRef}
                              foldersApi={rootFolderApi}
                              folderScopeProjectId={null}
                              onDropFolderAcrossScopes={(folderId, fromProjectId, targetParentId) => {
                                void handleDropFolderToScope(folderId, fromProjectId, null, targetParentId)
                              }}
                              // Folder ids are unique per scope config, not
                              // globally: while a project scope is active the
                              // selected id may be a project folder, which must
                              // not highlight same-id rows in the root tree.
                              selectedFolderId={isProjectBrowsingMode && rootFolderBrowseId === undefined ? null : rootFolderBrowseId !== undefined ? rootFolderBrowseId : folderScopeId}
                              onSelectFolder={isProjectBrowsingMode ? handleBrowseRootFolderInProjectMode : handleSelectFolderScope}
                              highlightFolderId={isProjectBrowsingMode ? rootFolderBrowseId : projectScopeProjectId ? null : session.selected ? (sessionMetaMap.get(session.selected)?.folderId ?? null) : null}
                              onDropSession={(sessionId, folderId) => {
                                // Always the atomic cross-scope move: branching on the
                                // cached meta (projectId?) silently failed whenever the
                                // cache was stale — the plain setFolder command then
                                // validated the folder against the session's real scope
                                // and threw, with nothing caught, so the drop looked dead.
                                void handleDropSessionToScope(sessionId, null, folderId)
                              }}
                            />
                          ),
                        },
                        // Divider above the Archived tail (it is its own block).
                        { id: "separator:folders-archived", type: "separator" as const },
                        {
                          id: "nav:archived",
                          title: t("sidebar.archived"),
                          label: archivedCount > 0 ? String(archivedCount) : undefined,
                          icon: Archive,
                          variant: (sessionFilter?.kind === 'archived' ? "default" : "ghost") as "default" | "ghost",
                          onClick: handleArchivedClick,
                        },
                      ],
                    },
                    // --- Separator ---
                    { id: "separator:chats-sources", type: "separator" },
                    // --- Sources & Skills Section ---
                    {
                      id: "nav:sources",
                      title: t("sidebar.sources"),
                      label: String(sources.length),
                      icon: DatabaseZap,
                      variant: (isSourcesNavigation(navState) && !sourceFilter) ? "default" : "ghost",
                      onClick: handleSourcesClick,
                      dataTutorial: "sources-nav",
                      expandable: true,
                      expanded: isExpanded('nav:sources'),
                      onToggle: () => toggleExpanded('nav:sources'),
                      contextMenu: {
                        type: 'sources',
                        onAddSource: () => openAddSource(),
                      },
                      items: [
                        {
                          id: "nav:sources:api",
                          title: t("sidebar.apis"),
                          label: String(sourceTypeCounts.api),
                          icon: Globe,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'api') ? "default" : "ghost",
                          onClick: handleSourcesApiClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('api'),
                            sourceType: 'api',
                          },
                        },
                        {
                          id: "nav:sources:mcp",
                          title: t("sidebar.mcps"),
                          label: String(sourceTypeCounts.mcp),
                          icon: <McpIcon className="h-3.5 w-3.5" />,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'mcp') ? "default" : "ghost",
                          onClick: handleSourcesMcpClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('mcp'),
                            sourceType: 'mcp',
                          },
                        },
                        {
                          id: "nav:sources:local",
                          title: t("sidebar.localFolders"),
                          label: String(sourceTypeCounts.local),
                          icon: FolderOpen,
                          variant: (sourceFilter?.kind === 'type' && sourceFilter.sourceType === 'local') ? "default" : "ghost",
                          onClick: handleSourcesLocalClick,
                          contextMenu: {
                            type: 'sources' as const,
                            onAddSource: () => openAddSource('local'),
                            sourceType: 'local',
                          },
                        },
                        {
                          id: "nav:sources:memories",
                          title: t("memory.globalTitle"),
                          label: String(memoryCount > 0 ? memoryCount : ''),
                          icon: Brain,
                          variant: navState.navigator === 'sources' && navState.details?.type === 'memory' ? "default" : "ghost",
                          onClick: () => navigate(routes.view.memories()),
                        },
                      ],
                    },
                    {
                      id: "nav:skills",
                      title: t("sidebar.skills"),
                      label: String(skills.length),
                      icon: Zap,
                      variant: isSkillsNavigation(navState) ? "default" : "ghost",
                      onClick: handleSkillsClick,
                      contextMenu: {
                        type: 'skills',
                        onAddSkill: openAddSkill,
                      },
                    },
                    {
                      id: "nav:pages",
                      title: t("sidebar.pages"),
                      label: String(pages.length),
                      icon: PanelsTopLeft,
                      // Highlight on the library grid only, not when a page is open (mirrors Projects)
                      variant: (isPagesNavigation(navState) && !navState.details) ? "default" : "ghost",
                      onClick: handlePagesClick,
                      expandable: pages.length > 0,
                      expanded: isExpanded('nav:pages'),
                      onToggle: () => toggleExpanded('nav:pages'),
                      items: pages.map(p => ({
                        id: `nav:pages:${p.config.id}`,
                        title: p.config.name,
                        icon: PanelsTopLeft,
                        variant: (isPagesNavigation(navState) && navState.details?.pageSlug === p.config.slug) ? "default" as const : "ghost" as const,
                        onClick: () => {
                          if (activeWorkspaceId) {
                            void window.electronAPI.pageWindow.open({
                              workspaceId: activeWorkspaceId,
                              pageSlug: p.config.slug,
                            })
                          }
                        },
                      })),
                    },
                    {
                      id: "nav:automations",
                      title: t("sidebar.automations"),
                      label: String(automations.length),
                      icon: ListTodo,
                      variant: (isAutomationsNavigation(navState) && !automationFilter) ? "default" : "ghost",
                      onClick: handleAutomationsClick,
                      expandable: true,
                      expanded: isExpanded('nav:automations'),
                      onToggle: () => toggleExpanded('nav:automations'),
                      items: [
                        {
                          id: "nav:automations:scheduled",
                          title: t("sidebar.scheduled"),
                          label: String(automationTypeCounts.scheduled),
                          icon: Clock,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'scheduled') ? "default" : "ghost",
                          onClick: handleAutomationsScheduledClick,
                        },
                        {
                          id: "nav:automations:event",
                          title: t("sidebar.eventBased"),
                          label: String(automationTypeCounts.event),
                          icon: Radio,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'event') ? "default" : "ghost",
                          onClick: handleAutomationsEventClick,
                        },
                        {
                          id: "nav:automations:agentic",
                          title: t("sidebar.agentic"),
                          label: String(automationTypeCounts.agentic),
                          icon: Bot,
                          variant: (automationFilter?.kind === 'type' && automationFilter.automationType === 'agentic') ? "default" : "ghost",
                          onClick: handleAutomationsAgenticClick,
                        },
                      ],
                    },
                  ]}
                />
                {/* Agent Tree: Hierarchical list of agents */}
                {/* Agents section removed */}
                </div>
                {/* Rail footer: Settings and What's New (with their divider) are
                  * pinned to the bottom of the rail instead of trailing the nav
                  * list, so a long list can never scroll them out of reach. */}
                <div className="flex-none">
                  <LeftSidebar
                    isCollapsed={false}
                    getItemProps={getSidebarItemProps}
                    focusedItemId={focusedSidebarItemId}
                    links={[
                      // --- Separator ---
                      { id: "separator:skills-settings", type: "separator" },
                      // --- Settings ---
                      {
                        id: "nav:settings",
                        title: t("sidebar.settings"),
                        icon: Settings,
                        variant: isSettingsNavigation(navState) ? "default" : "ghost",
                        onClick: () => handleSettingsClick(),
                      },
                      // --- What's New ---
                      {
                        id: "nav:whats-new",
                        title: t("sidebar.whatsNew"),
                        icon: hasUnseenReleaseNotes ? (
                          <span className="relative">
                            <Cake className="h-3.5 w-3.5" />
                            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                          </span>
                        ) : Cake,
                        variant: "ghost" as const,
                        onClick: handleWhatsNewClick,
                      },
                    ]}
                  />
                </div>
              </div>

            </div>
          </div>
          }
          sidebarWidth={effectiveSidebarAndNavigatorHidden ? 0 : (isSidebarVisible ? sidebarWidth : 0)}
          navigatorSlot={
            <div
              style={{ width: isAutoCompact ? '100%' : sessionListWidth }}
              className="h-full flex flex-col min-w-0 relative z-panel"
              onContextMenu={handleListBackgroundContextMenu}
            >
            <PanelHeader
              // The title stays visible even when the rail is collapsed: hiding
              // it left the list panel with an empty header and no way to tell
              // which view was open. Stoplight padding is macOS-only (Windows
              // uses a native frame), so it must not indent the title there.
              title={listTitle}
              compensateForStoplight={!isSidebarVisible && isMac}
              leadingAction={activeFolderScopeId ? (
                <HeaderIconButton
                  icon={<ChevronLeft className="h-4 w-4" />}
                  tooltip={t("folders.back")}
                  aria-label={t("folders.back")}
                  onClick={handleGoToParentFolder}
                />
              ) : undefined}

              actions={
                <>
                  {/* Search — the header's own affordance (the old filter dropdown that
                      used to host it was removed). Collapsed it is an icon; opened it
                      grows leftwards over the title. */}
                  {isSessionsNavigation(navState) && (
                    <HeaderSearchControl
                      active={searchActive}
                      query={searchQuery}
                      onOpen={() => setSearchActive(true)}
                      onChange={setSearchQuery}
                      onClose={() => {
                        setSearchActive(false)
                        setSearchQuery('')
                      }}
                      // Blur collapse keeps the draft: only the search *state* is
                      // dropped, the typed text survives in memory (never persisted).
                      onCollapse={() => setSearchActive(false)}
                    />
                  )}
                  {/* List ⇄ Board view switch (sessions mode, desktop widths only).
                      In board view the navigator is collapsed, so the board hosts its own copy. */}
                  {/* Add Source button (only for sources mode) - uses filter-aware edit config */}
                  {isSourcesNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSource")}
                          data-tutorial="add-source-button"
                        />
                      }
                      {...getEditConfig(
                        sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                        activeWorkspace.rootPath
                      )}
                    />
                  )}
                  {/* Add Skill button (only for skills mode) */}
                  {isSkillsNavigation(navState) && activeWorkspace && (
                    <EditPopover
                      trigger={
                        <HeaderIconButton
                          icon={<Plus className="h-4 w-4" />}
                          tooltip={t("sidebarMenu.addSkill")}
                          data-tutorial="add-skill-button"
                        />
                      }
                      {...getEditConfig('add-skill', activeWorkspace.rootPath)}
                    />
                  )}
                  {/* Add Project button (only for projects mode) */}
                  {isProjectsNavigation(navState) && activeWorkspace && (
                    <HeaderIconButton
                      icon={<Plus className="h-4 w-4" />}
                      tooltip={t("sidebarMenu.addProject")}
                      onClick={openAddProject}
                    />
                  )}
                </>
              }
            />
            {/* New Session — first row of the navigator body (not the header):
                icon + label centred as one group, full width. */}
            {isSessionsNavigation(navState) && (
              <div className="shrink-0 px-2 pt-1 pb-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <ContextMenu modal={true}>
                        <ContextMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            onClick={(e) => handleNewChat(e.metaKey || e.ctrlKey)}
                            className="flex h-[30px] w-full items-center justify-center gap-2 rounded-[6px] border border-foreground/10 bg-foreground/[0.06] px-2 text-[13px] font-normal shadow-minimal transition-colors hover:bg-foreground/[0.10]"
                            data-tutorial="new-chat-button"
                          >
                            <SquarePenRounded className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{t("session.newSession")}</span>
                          </Button>
                        </ContextMenuTrigger>
                        <StyledContextMenuContent>
                          <ContextMenuProvider>
                            <SidebarMenu type="newSession" />
                          </ContextMenuProvider>
                        </StyledContextMenuContent>
                      </ContextMenu>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{newChatHotkey}</TooltipContent>
                </Tooltip>
              </div>
            )}
            {/* Content: SessionList, SourcesListPanel, or SettingsNavigator based on navigation state */}
            {/* Memory manager view replaces the sources list in the navigator */}
            {isSourcesNavigation(navState) && navState.details?.type !== 'memory' && (
              /* Sources List - filtered by type if sourceFilter is active */
              <SourcesListPanel
                sources={sources}
                sourceFilter={sourceFilter}
                workspaceRootPath={activeWorkspace?.rootPath}
                onDeleteSource={handleDeleteSource}
                onSourceClick={handleSourceSelect}
                selectedSourceSlug={isSourcesNavigation(navState) && navState.details?.type === 'source' ? navState.details.sourceSlug : null}
                localMcpEnabled={localMcpEnabled}
                usageStats={usageStats}
              />
            )}
            {isSkillsNavigation(navState) && activeWorkspaceId && (
              /* Skills List */
              <SkillsListPanel
                skills={skills}
                workspaceId={activeWorkspaceId}
                workspaceRootPath={activeWorkspace?.rootPath}
                onSkillClick={handleSkillSelect}
                onDeleteSkill={handleDeleteSkill}
                selectedSkillSlug={isSkillsNavigation(navState) && navState.details?.type === 'skill' ? navState.details.skillSlug : null}
                usageStats={usageStats}
              />
            )}
            {isAutomationsNavigation(navState) && activeWorkspaceId && (
              /* Automations List */
              <AutomationsListPanel
                automations={automations}
                automationFilter={automationFilter ? { kind: AUTOMATION_TYPE_TO_FILTER_KIND[automationFilter.automationType] ?? 'all' } : undefined}
                onAutomationClick={handleAutomationSelect}
                onTestAutomation={handleTestAutomation}
                onToggleAutomation={handleToggleAutomation}
                onDuplicateAutomation={handleDuplicateAutomation}
                onDeleteAutomation={handleDeleteAutomation}
                selectedAutomationId={isAutomationsNavigation(navState) && navState.details ? navState.details.automationId : null}
                workspaceRootPath={activeWorkspace?.rootPath}
              />
            )}
            {isProjectsNavigation(navState) && activeWorkspaceId && (
              /* Projects List */
              <ProjectsListPanel
                projects={projects}
                workspaceId={activeWorkspaceId}
                onProjectClick={(slug) => navigate(routes.view.projects(slug))}
                onAddProject={openAddProject}
                onJumpToSessions={handleJumpToProjectSessions}
                selectedProjectSlug={isProjectsNavigation(navState) ? navState.details?.projectSlug ?? null : null}
              />
            )}
            {isSettingsNavigation(navState) && (
              /* Settings Navigator */
              <SettingsNavigator
                selectedSubpage={navState.subpage}
                onSelectSubpage={(subpage) => handleSettingsClick(subpage)}
              />
            )}
            {isSessionsNavigation(navState) && (
              /* Sessions List */
              <>
                {/* SessionList: Scrollable list of session cards */}
                {/* Key on sidebarMode forces full remount when switching views, skipping animations */}
                <SessionList
                  key={sessionFilter?.kind}
                  items={filteredSessionMetas}
                  onDelete={handleDeleteSession}
                  onArchive={onArchiveSession}
                  onUnarchive={onUnarchiveSession}
                  onMarkUnread={onMarkSessionUnread}
                  onRename={onRenameSession}
                  onNewSession={() => handleNewChat()}
                  onFocusChatInput={(targetSessionId) => {
                    focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
                  }}
                  onSessionSelect={(selectedMeta) => {
                    navigateToSession(selectedMeta.id)
                  }}
                  onSearchResultSelect={handleSearchResultSelect}
                  onOpenInNewWindow={(selectedMeta) => {
                    if (activeWorkspaceId) {
                      window.electronAPI.openSessionInNewWindow(activeWorkspaceId, selectedMeta.id)
                    }
                  }}
                  searchActive={searchActive}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSearchClose={() => {
                    setSearchActive(false)
                    setSearchQuery('')
                  }}
                  projects={projectMenuOptions}
                  onSetProjectId={handleSessionProjectChange}
                  workspaceId={activeWorkspaceId ?? undefined}
                  inProjectScope={!!projectScopeProjectId && !isBrowsingRootTreeInProjectMode}
                  foldersApi={activeFolderApi}
                  folderScopeId={activeFolderScopeId}
                  onEnterFolder={isBrowsingRootTreeInProjectMode ? handleBrowseRootFolderInProjectMode : handleSelectProjectFolder}
                  folderSessionCounts={folderSessionCounts}
                  folderListRef={navigatorFolderListRef}
                  folderScopeProjectId={isBrowsingRootTreeInProjectMode ? null : projectScopeProjectId}
                  onDropSessionToFolder={(sessionId, folderId) => {
                    void handleDropSessionToScope(sessionId, isBrowsingRootTreeInProjectMode ? null : projectScopeProjectId, folderId)
                  }}
                  focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
                  onNavigateToSession={panelCount > 1 ? navigateToSessionInPanel : undefined}
                  hasPendingPrompt={hasPendingPrompt}
                  activeChatMatchInfo={chatMatchInfo}
                />
              </>
            )}
            {/* Mobile/compact-only FAB for starting a new chat — only on the
                session list itself, not when a chat is open (it would overlap
                the chat input). */}
            {isAutoCompact && isSessionsNavigation(navState) && !navState.details && (
              <FabNewChat onClick={() => handleNewChat()} />
            )}
            </div>
          }
          navigatorWidth={isAutoCompact ? sessionListWidth : (effectiveSidebarAndNavigatorHidden || isPagesView || isMemoryView ? 0 : sessionListWidth)}
          isSidebarAndNavigatorHidden={effectiveSidebarAndNavigatorHidden}
          isRightSidebarVisible={false}
          isCompact={isAutoCompact}
          isResizing={!!isResizing}
        />

        {/* Sidebar Resize Handle (absolute, hidden in focused mode) */}
        {!effectiveSidebarAndNavigatorHidden && (
        <div
          ref={resizeHandleRef}
          onMouseDown={(e) => { e.preventDefault(); setIsResizing('sidebar') }}
          onMouseMove={(e) => {
            if (resizeHandleRef.current) {
              const rect = resizeHandleRef.current.getBoundingClientRect()
              setSidebarHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => { if (!isResizing) setSidebarHandleY(null) }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left: isSidebarVisible
              ? sidebarWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH
              : -PANEL_GAP,
            transition: isResizing === 'sidebar' ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(sidebarHandleY, resizeHandleRef.current?.clientHeight ?? null),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

        {/* Session List Resize Handle (absolute, hidden in focused mode, board view, pages, and memory) */}
        {!effectiveSidebarAndNavigatorHidden && !isPagesView && !isMemoryView && (
        <div
          ref={sessionListHandleRef}
          onMouseDown={(e) => { e.preventDefault(); setIsResizing('session-list') }}
          onMouseMove={(e) => {
            if (sessionListHandleRef.current) {
              const rect = sessionListHandleRef.current.getBoundingClientRect()
              setSessionListHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => { if (isResizing !== 'session-list') setSessionListHandleY(null) }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left:
              (isSidebarVisible ? sidebarWidth + PANEL_GAP : PANEL_EDGE_INSET) +
              sessionListWidth +
              (PANEL_GAP / 2) -
              PANEL_SASH_HALF_HIT_WIDTH,
            transition: isResizing === 'session-list' ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(sessionListHandleY, sessionListHandleRef.current?.clientHeight ?? null),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

      </div>

      {/* ============================================================================
       * CONTEXT MENU TRIGGERED EDIT POPOVERS
       * ============================================================================
       * These EditPopovers are opened programmatically from sidebar context menus.
       * They use controlled state (editPopoverOpen) and invisible anchors for positioning.
       * The anchor Y position is captured from the right-clicked item (editPopoverAnchorY ref)
       * so the popover appears near the triggering item rather than at a fixed location.
       * modal={true} prevents auto-close when focus shifts after context menu closes.
       */}
      {activeWorkspace && (
        <>
          {/* Add Source EditPopovers - one for each variant (generic + filter-specific)
           * editPopoverOpen can be: 'add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'
           * Each variant uses its corresponding EditContextKey for filter-aware agent context */}
          {(['add-source', 'add-source-api', 'add-source-mcp', 'add-source-local'] as const).map((variant) => (
            <EditPopover
              key={variant}
              open={editPopoverOpen === variant}
              onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? variant : null)}
              modal={true}
              trigger={
                <div
                  className="fixed w-0 h-0 pointer-events-none"
                  style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                  aria-hidden="true"
                />
              }
              side="bottom"
              align="start"
              {...getEditConfig(variant, activeWorkspace.rootPath)}
            />
          ))}
          {/* Add Skill EditPopover */}
          <EditPopover
            open={editPopoverOpen === 'add-skill'}
            onOpenChange={(isOpen) => setEditPopoverOpen(isOpen ? 'add-skill' : null)}
            modal={true}
            trigger={
              <div
                className="fixed w-0 h-0 pointer-events-none"
                style={{ left: sidebarWidth + 20, top: editPopoverAnchorY.current }}
                aria-hidden="true"
              />
            }
            side="bottom"
            align="start"
            {...getEditConfig('add-skill', activeWorkspace.rootPath)}
          />
        </>
      )}

      {/* What's New overlay */}
      <DocumentFormattedMarkdownOverlay
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
        content={releaseNotesContent}
        onOpenUrl={(url) => window.electronAPI.openUrl(url)}
      />

      {/* Send to Workspace dialog (driven by sendToWorkspaceAtom) */}
      <SendToWorkspaceDialog
        open={sendToWorkspaceIds.length > 0}
        onOpenChange={(open) => { if (!open) setSendToWorkspaceIds([]) }}
        sessionIds={sendToWorkspaceIds}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onTransferComplete={handleTransferComplete}
      />

      {/* Create Project dialog — prompts for a name so slugs stay meaningful */}
      <CreateProjectDialog
        open={createProjectDialogOpen}
        onCancel={() => setCreateProjectDialogOpen(false)}
        onSubmit={handleCreateProjectSubmit}
      />

      {/* Messaging dialogs (pairing-code + WA connect) — driven by messagingDialogAtom.
          Mounted here so they survive context-menu / dropdown close. */}
      <MessagingDialogHost />

      {/* Navigator panel's empty-space menu (New Session / New Folder). Rendered
          through a portal so the panel's overflow cannot clip it. */}
      {listMenu && createPortal(
        <div
          className="fixed z-[100] min-w-[180px] overflow-hidden rounded-md border border-foreground/10 bg-popover p-1 text-sm text-popover-foreground shadow-2xl"
          style={{ left: listMenu.x, top: listMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.preventDefault(); setListMenu(null) }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => { setListMenu(null); handleNewChat() }}
          >
            <SquarePenRounded className="h-3.5 w-3.5 shrink-0" />
            {t("session.newSession")}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => {
              setListMenu(null)
              // Create where the user clicked: the navigator's own folder list.
              // (Falling back to the tree would pop the editor into the wrong panel.)
              setSearchActive(false)
              navigatorFolderListRef.current?.openCreate()
            }}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            {t("folders.new")}
          </button>
        </div>,
        document.body
      )}

    </AppShellProvider>
  )
}
