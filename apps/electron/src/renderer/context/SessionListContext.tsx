import { createContext, useContext } from "react"
import type { SessionMeta } from "@/atoms/sessions"
import type { ContentSearchResult } from "@/hooks/useSessionSearch"

export interface SessionListContextValue {
  // Session action callbacks (shared across all items)
  onRenameClick: (sessionId: string, currentName: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  /** Set or clear the project binding for a session (null = unbind) */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** Available workspace projects for the context-menu submenu */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  onSelectSessionById: (sessionId: string) => void
  onOpenInNewWindow: (item: SessionMeta) => void
  onSendToWorkspace?: (sessionIds: string[]) => void
  onFocusZone: () => void
  onKeyDown: (e: React.KeyboardEvent, item: SessionMeta) => void

  // Shared config
  searchQuery?: string
  selectedSessionId?: string | null
  isMultiSelectActive: boolean
  /** True inside a project's jump view — project rows hide their hover name suffix. */
  inProjectScope?: boolean

  // Per-session lookup maps
  contentSearchResults: Map<string, ContentSearchResult>
  /** DOM-verified match info for the active session (count, highlighting state) */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
  /** Whether a session currently has a pending permission/admin prompt */
  hasPendingPrompt?: (sessionId: string) => boolean
}

const SessionListContext = createContext<SessionListContextValue | null>(null)

export function useSessionListContext(): SessionListContextValue {
  const ctx = useContext(SessionListContext)
  if (!ctx) throw new Error("useSessionListContext must be used within SessionList")
  return ctx
}

export const SessionListProvider = SessionListContext.Provider
