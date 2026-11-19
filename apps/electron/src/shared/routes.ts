/**
 * Route Registry
 *
 * Type-safe route definitions for navigation throughout the app.
 * All navigation should use these route builders instead of hardcoded strings.
 *
 * Route Formats:
 * - action/{name}[/{id}] - Trigger side effects
 * - {filter}[/session/{sessionId}] - Compound view routes for full navigation state
 *
 * Usage:
 *   import { routes } from '@/shared/routes'
 *   navigate(routes.action.newSession())
 *   navigate(routes.view.allSessions())
 *   navigate(routes.view.settings('shortcuts'))
 */

import type { SettingsSubpage } from './settings-registry'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'

// Helper to build query strings from params
function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return ''
  const filtered = Object.entries(params).filter(([, v]) => v !== undefined)
  if (filtered.length === 0) return ''
  const searchParams = new URLSearchParams(
    filtered as [string, string][]
  )
  return `?${searchParams.toString()}`
}

/**
 * Route definitions with type-safe builders
 */
export const routes = {
  // ============================================
  // Action Routes - Trigger actions
  // ============================================
  action: {
    /**
     * Create a new session
     * @param input - Optional initial message to pre-fill or send
     * @param name - Optional session name
     * @param send - If true and input is provided, immediately sends the message
     * @param project - Optional project id to bind the new session to
     */
    newSession: (params?: { input?: string; name?: string; send?: boolean; project?: string }) =>
      `action/new-session${toQueryString(params ? { ...params, send: params.send ? 'true' : undefined } : undefined)}` as const,

    /** Rename a session */
    renameSession: (sessionId: string, name: string) =>
      `action/rename-session/${sessionId}?name=${encodeURIComponent(name)}` as const,

    /** Delete a session (with confirmation) */
    deleteSession: (sessionId: string) =>
      `action/delete-session/${sessionId}` as const,

    /** Start OAuth flow for a source */
    oauth: (sourceSlug: string) => `action/oauth/${sourceSlug}` as const,

    /** Open add source UI */
    addSource: () => 'action/add-source' as const,

    // Note: test-source route can be added when API support is available
    // testSource: (sourceSlug: string) => `action/test-source/${sourceSlug}` as const,

    /** Delete a source */
    deleteSource: (sourceSlug: string) =>
      `action/delete-source/${sourceSlug}` as const,

    /** Set permission mode for a session */
    setPermissionMode: (
      sessionId: string,
      mode: PermissionMode
    ) => `action/set-mode/${sessionId}?mode=${mode}` as const,

    /** Copy text to clipboard */
    copyToClipboard: (text: string) =>
      `action/copy?text=${encodeURIComponent(text)}` as const,
  },

  // ============================================
  // View Routes - Compound sidebar/navigator/details routes
  // ============================================
  view: {
    /** All sessions view (sessions navigator, allSessions filter) */
    allSessions: (sessionId?: string) =>
      sessionId ? `allSessions/session/${sessionId}` as const : 'allSessions' as const,

    /**
     * Task board (multi-agent tasks).
     *
     * `taskId` selects one task's detail; omitted shows the grouped list.
     */
    tasks: (taskId?: string) =>
      taskId ? `tasks/${encodeURIComponent(taskId)}` as const : 'tasks' as const,

    /** Archived view (sessions navigator, archived filter) */
    archived: (sessionId?: string) =>
      sessionId ? `archived/session/${sessionId}` as const : 'archived' as const,

    /** Folder scope (sessions navigator). Folder ids are slugs inside one project/root tree. */
    folder: (folderId: string, sessionId?: string) =>
      sessionId
        ? `folder/${encodeURIComponent(folderId)}/session/${sessionId}` as const
        : `folder/${encodeURIComponent(folderId)}` as const,

    /** Archive tree (projects / folders / sessions). `nodeId` = `project:{id}` | `folder:{id}`. */
    archive: (nodeId?: string, sessionId?: string) => {
      const base = nodeId ? `archive/${encodeURIComponent(nodeId)}` : 'archive'
      return (sessionId ? `${base}/session/${sessionId}` : base) as string
    },

    /** Sources view (sources navigator) - supports type filtering */
    sources: (params?: { sourceSlug?: string; type?: 'api' | 'mcp' | 'local' }) => {
      const { sourceSlug, type } = params ?? {}
      // Build base from filter type
      const base = type ? `sources/${type}` : 'sources'
      if (sourceSlug) {
        return `${base}/source/${sourceSlug}` as const
      }
      return base as 'sources' | `sources/${'api' | 'mcp' | 'local'}`
    },

    /** Global memory manager under the Sources navigator. */
    memories: () => 'sources/memories' as const,

    /** Agents view (agents navigator). Pass an agent id for a specific agent's detail. */
    agents: (agentId?: string) => {
      if (!agentId) return 'agents' as const
      return `agents/agent/${agentId}` as const
    },

    /** API sources view (sources navigator, api filter) */
    sourcesApi: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/api/source/${sourceSlug}` as const
        : 'sources/api' as const,

    /** MCP sources view (sources navigator, mcp filter) */
    sourcesMcp: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/mcp/source/${sourceSlug}` as const
        : 'sources/mcp' as const,

    /** Local folder sources view (sources navigator, local filter) */
    sourcesLocal: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/local/source/${sourceSlug}` as const
        : 'sources/local' as const,

    /** Skills view (skills navigator). Pass a slug string for a local skill detail view. */
    skills: (skillSlug?: string) => {
      if (!skillSlug) return 'skills' as const
      return `skills/skill/${skillSlug}` as const
    },

    /** Settings view (settings navigator) - uses SettingsSubpage from registry */
    settings: (subpage?: SettingsSubpage) =>
      subpage
        ? `settings/${subpage}` as const
        : 'settings' as const,

    /** Projects view (projects navigator) */
    projects: (projectSlug?: string) =>
      projectSlug
        ? `projects/project/${projectSlug}` as const
        : 'projects' as const,

    /** Pages view (full-width library grid, or one page's embedded render) */
    pages: (pageSlug?: string) =>
      pageSlug
        ? `pages/page/${pageSlug}` as const
        : 'pages' as const,

    /** Events: received-event log (default section of the events navigator) */
    events: (eventId?: string) =>
      eventId
        ? `events/list/event/${eventId}` as const
        : 'events/list' as const,

    /** Events: installed listener cards */
    eventListeners: (listenerId?: string) =>
      listenerId
        ? `events/listeners/listener/${listenerId}` as const
        : 'events/listeners' as const,

    /**
     * Inbox: events that arrived but no session has finished acting on them
     * yet — the queue half of the event center, in the article's sense.
     */
    inbox: (eventId?: string) =>
      eventId ? `events/inbox/event/${eventId}` as const : 'events/inbox' as const,

    /** Outbox: outbound messages with their delivery state (sent / pending / failed).
     *  With an id, drills into that record's detail view. */
    outbox: (outboxId?: string) =>
      outboxId
        ? `events/outbox/${outboxId}` as const
        : 'events/outbox' as const,

  },
} as const

/**
 * Type representing any valid route string
 */
export type ActionRoute = ReturnType<(typeof routes.action)[keyof typeof routes.action]>
export type ViewRoute = ReturnType<(typeof routes.view)[keyof typeof routes.view]>
export type Route = ActionRoute | ViewRoute
