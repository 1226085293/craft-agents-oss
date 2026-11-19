/**
 * Route Parser
 *
 * Parses route strings back into structured navigation objects.
 * Used by both the navigate() function and deep link handler.
 *
 * Supports route formats:
 * - Action: action/{name}[/{id}] - Trigger side effects
 * - Compound: {filter}[/session/{sessionId}] - View routes for full navigation state
 */

import type {
  NavigationState,
  SessionFilter,
  SourceFilter,
  RightSidebarPanel,
} from './types'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

// =============================================================================
// Route Types
// =============================================================================

export type RouteType = 'action' | 'view'

export interface ParsedRoute {
  type: RouteType
  name: string
  id?: string
  params: Record<string, string>
}

// =============================================================================
// Compound Route Types (new format)
// =============================================================================

export type NavigatorType =
  | 'sessions'
  | 'sources'
  | 'skills'
  | 'projects'
  | 'pages'
  | 'events'
  | 'tasks'
  | 'agents'
  | 'settings'

export interface ParsedCompoundRoute {
  /** The navigator type */
  navigator: NavigatorType
  /** Session filter (only for sessions navigator) */
  sessionFilter?: SessionFilter
  /** Source filter (only for sources navigator) */
  sourceFilter?: SourceFilter
  /** Which section of the events navigator: the log, the listener cards, or the two queues. */
  eventsSection?: 'list' | 'listeners' | 'inbox' | 'outbox'
  /** Selected task (only for the tasks navigator). */
  selectedTaskId?: string | null
  /** Details page info (null for empty state) */
  details: {
    type: string
    id: string
  } | null
}

// =============================================================================
// Compound Route Parsing
// =============================================================================

/**
 * Known prefixes that indicate a compound route
 */
const COMPOUND_ROUTE_PREFIXES = [
  'allSessions', 'archived', 'state', 'view', 'sources', 'skills', 'projects', 'pages', 'events', 'tasks', 'agents', 'settings'
]

/**
 * Check if a route is a compound route (new format)
 */
export function isCompoundRoute(route: string): boolean {
  const firstSegment = route.split('?')[0].split('/')[0]
  return COMPOUND_ROUTE_PREFIXES.includes(firstSegment)
}

/**
 * Parse a compound route into structured navigation
 *
 * Examples:
 *   'allSessions' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: null }
 *   'allSessions/session/abc123' -> { navigator: 'sessions', sessionFilter: { kind: 'allSessions' }, details: { type: 'session', id: 'abc123' } }
 *   'sources' -> { navigator: 'sources', details: null }
 *   'sources/api' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'api' }, details: null }
 *   'sources/mcp' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'mcp' }, details: null }
 *   'sources/local' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'local' }, details: null }
 *   'sources/source/github' -> { navigator: 'sources', details: { type: 'source', id: 'github' } }
 *   'sources/api/source/gmail' -> { navigator: 'sources', sourceFilter: { kind: 'type', sourceType: 'api' }, details: { type: 'source', id: 'gmail' } }
 *   'settings' -> { navigator: 'settings', details: null }  // navigator-only view
 *   'settings/shortcuts' -> { navigator: 'settings', details: { type: 'shortcuts', id: 'shortcuts' } }
 */
export function parseCompoundRoute(route: string): ParsedCompoundRoute | null {
  // Compound routes are pure slash-segment paths; defensively strip any query tail
  // so a stray `?x=y` never leaks into segment parsing (e.g. into a labelId).
  const [pathPart] = route.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  if (segments.length === 0) return null

  const first = segments[0]

  // Settings navigator
  if (first === 'settings') {
    const subpage = segments[1]
    if (subpage === undefined) {
      // Bare `settings` route — navigator-only view (compact) / App fallback (desktop).
      return { navigator: 'settings', details: null }
    }
    if (!isValidSettingsSubpage(subpage)) return null
    return {
      navigator: 'settings',
      details: { type: subpage, id: subpage },
    }
  }

  // Sources navigator - supports type filters (api, mcp, local)
  if (first === 'sources') {
    if (segments[1] === 'memories') return { navigator: 'sources', details: { type: 'memory', id: 'global' } }
    if (segments.length === 1) {
      return { navigator: 'sources', details: null }
    }

    // Check for type filter: sources/api, sources/mcp, sources/local
    const validSourceTypes = ['api', 'mcp', 'local']
    if (validSourceTypes.includes(segments[1])) {
      const sourceType = segments[1] as 'api' | 'mcp' | 'local'
      const sourceFilter: SourceFilter = { kind: 'type', sourceType }

      // Check for source selection within filtered view: sources/api/source/{sourceSlug}
      if (segments[2] === 'source' && segments[3]) {
        return {
          navigator: 'sources',
          sourceFilter,
          details: { type: 'source', id: segments[3] },
        }
      }

      // Just the filter, no selection
      return { navigator: 'sources', sourceFilter, details: null }
    }

    // Unfiltered source selection: sources/source/{sourceSlug}
    if (segments[1] === 'source' && segments[2]) {
      return {
        navigator: 'sources',
        details: { type: 'source', id: segments[2] },
      }
    }

    return null
  }

  // Agents navigator: 'agents' (list) / 'agents/agent/{agentId}' (detail).
  if (first === 'agents') {
    if (segments.length === 1) {
      return { navigator: 'agents', details: null }
    }
    if (segments[1] === 'agent' && segments[2]) {
      return {
        navigator: 'agents',
        details: { type: 'agent', id: segments[2] },
      }
    }
    return null
  }

  // Skills navigator
  if (first === 'skills') {
    if (segments.length === 1) {
      return { navigator: 'skills', details: null }
    }

    // skills/skill/{skillSlug}
    if (segments[1] === 'skill' && segments[2]) {
      return {
        navigator: 'skills',
        details: { type: 'skill', id: segments[2] },
      }
    }

    return null
  }

  // Pages navigator
  if (first === 'pages') {
    if (segments.length === 1) {
      return { navigator: 'pages', details: null }
    }
    if (segments[1] === 'page' && segments[2]) {
      return {
        navigator: 'pages',
        details: { type: 'page', id: segments[2] },
      }
    }
    return null
  }

  // Events navigator: events/list[/event/:id], events/listeners[/listener/:id],
  // and the queue views events/inbox / events/outbox (list views, no detail level).
  if (first === 'events') {
    const section =
      segments[1] === 'listeners' ? 'listeners'
      : segments[1] === 'inbox' ? 'inbox'
      : segments[1] === 'outbox' ? 'outbox'
      : 'list'
    const detailsType = section === 'listeners' ? 'listener' : 'event'
    if (segments.length === 1) {
      return { navigator: 'events', eventsSection: 'list', details: null }
    }
    if (segments[1] === 'list' && segments.length === 2) {
      return { navigator: 'events', eventsSection: 'list', details: null }
    }
    if (segments[1] === 'listeners' && segments.length === 2) {
      return { navigator: 'events', eventsSection: 'listeners', details: null }
    }
    if ((segments[1] === 'inbox' || segments[1] === 'outbox') && segments.length === 2) {
      return { navigator: 'events', eventsSection: section, details: null }
    }
    // Outbox drill-down is the compact 3-segment form: events/outbox/<recordId>.
    // (Event / listener details keep the 4-segment events/<section>/<type>/<id>.)
    if (section === 'outbox' && segments.length === 3 && segments[2]) {
      return {
        navigator: 'events',
        eventsSection: 'outbox',
        details: { type: 'outbox', id: segments[2] },
      }
    }
    if (segments[2] === detailsType && segments[3]) {
      return {
        navigator: 'events',
        eventsSection: section,
        details: { type: detailsType, id: segments[3] },
      }
    }
    return null
  }

  // Tasks navigator: tasks[/:id]
  if (first === 'tasks') {
    if (segments.length === 1) {
      return { navigator: 'tasks', selectedTaskId: null, details: null }
    }
    if (segments.length === 2) {
      return {
        navigator: 'tasks',
        selectedTaskId: decodeURIComponent(segments[1]),
        details: { type: 'task', id: decodeURIComponent(segments[1]) },
      }
    }
    return null
  }

  // Sessions navigator (allSessions, archived, state)
  let sessionFilter: SessionFilter
  let detailsStartIndex: number

  switch (first) {
    case 'allSessions':
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 1
      break
    case 'archived':
      sessionFilter = { kind: 'archived' }
      detailsStartIndex = 1
      break
    case 'view':
      // View dimension removed — legacy view routes land on all sessions
      sessionFilter = { kind: 'allSessions' }
      detailsStartIndex = 2
      break
    default:
      return null
  }

  // Check for details
  if (segments.length > detailsStartIndex) {
    const detailsType = segments[detailsStartIndex]
    const detailsId = segments[detailsStartIndex + 1]
    if (detailsType === 'session' && detailsId) {
      return {
        navigator: 'sessions',
        sessionFilter,
        details: { type: 'session', id: detailsId },
      }
    }
  }

  return {
    navigator: 'sessions',
    sessionFilter,
    details: null,
  }
}

/**
 * Build a compound route string from parsed state
 */
export function buildCompoundRoute(parsed: ParsedCompoundRoute): string {
  if (parsed.navigator === 'settings') {
    if (!parsed.details) return 'settings'
    return `settings/${parsed.details.type}`
  }

  if (parsed.navigator === 'sources') {
    // Build base from filter (sources, sources/api, sources/mcp, sources/local)
    let base = 'sources'
    if (parsed.sourceFilter?.kind === 'type') {
      base = `sources/${parsed.sourceFilter.sourceType}`
    }
    if (!parsed.details) return base
    return parsed.details.type === 'memory' ? 'sources/memories' : `${base}/source/${parsed.details.id}`
  }

  if (parsed.navigator === 'skills') {
    if (!parsed.details) return 'skills'
    return `skills/skill/${parsed.details.id}`
  }

  if (parsed.navigator === 'projects') {
    if (!parsed.details) return 'projects'
    return `projects/project/${parsed.details.id}`
  }

  if (parsed.navigator === 'pages') {
    if (!parsed.details) return 'pages'
    return `pages/page/${parsed.details.id}`
  }

  if (parsed.navigator === 'events') {
    const section = parsed.eventsSection ?? 'list'
    if (!parsed.details) return `events/${section}`
    // Outbox records keep the compact 3-segment form; everything else is
    // events/<section>/<detailsType>/<id>.
    if (section === 'outbox' && parsed.details.type === 'outbox') {
      return `events/outbox/${parsed.details.id}`
    }
    return `events/${section}/${parsed.details.type}/${parsed.details.id}`
  }

  if (parsed.navigator === 'tasks') {
    // `tasks` opens the board; a selected task drills into its detail view.
    return parsed.selectedTaskId ? `tasks/${parsed.selectedTaskId}` : 'tasks'
  }

  if (parsed.navigator === 'agents') {
    if (!parsed.details) return 'agents'
    return `agents/agent/${parsed.details.id}`
  }

  // Sessions navigator

  let base: string
  const filter = parsed.sessionFilter
  if (!filter) return 'allSessions'

  switch (filter.kind) {
    case 'allSessions':
      base = 'allSessions'
      break
    case 'archived':
      base = 'archived'
      break
    default:
      base = 'allSessions'
  }

  if (!parsed.details) return base
  return `${base}/session/${parsed.details.id}`
}

// =============================================================================
// Route Parsing
// =============================================================================

/**
 * Parse a route string into structured navigation
 *
 * Examples:
 *   'allSessions' -> { type: 'view', name: 'allSessions', params: {} }
 *   'allSessions/session/abc123' -> { type: 'view', name: 'session', id: 'abc123', params: { filter: 'allSessions' } }
 *   'settings/shortcuts' -> { type: 'view', name: 'shortcuts', params: {} }
 *   'action/new-session' -> { type: 'action', name: 'new-session', params: {} }
 */
export function parseRoute(route: string): ParsedRoute | null {
  try {
    // Check if this is a compound route (preferred format)
    if (isCompoundRoute(route)) {
      const compound = parseCompoundRoute(route)
      if (compound) {
        return convertCompoundToViewRoute(compound)
      }
    }

    // Parse action routes: action/{name}[/{id}]
    const [pathPart, queryPart] = route.split('?')
    const segments = pathPart.split('/').filter(Boolean)

    if (segments.length < 2) {
      return null
    }

    const type = segments[0]
    if (type !== 'action') {
      return null
    }

    const name = segments[1]
    const id = segments[2]

    // Parse query params
    const params: Record<string, string> = {}
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart)
      searchParams.forEach((value, key) => {
        params[key] = value
      })
    }

    return { type: 'action', name, id, params }
  } catch {
    return null
  }
}

/**
 * Convert a parsed compound route to ParsedRoute format (type: 'view')
 */
function convertCompoundToViewRoute(compound: ParsedCompoundRoute): ParsedRoute {
  // Task board
  if (compound.navigator === 'tasks') {
    return {
      type: 'view',
      name: 'tasks',
      id: compound.selectedTaskId ?? compound.details?.id,
      params: {},
    }
  }

  // Settings
  if (compound.navigator === 'settings') {
    const subpage = compound.details?.type || 'app'
    if (subpage === 'app') {
      return { type: 'view', name: 'settings', params: {} }
    }
    return { type: 'view', name: subpage, params: {} }
  }

  // Sources
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return { type: 'view', name: 'sources', params: {} }
    }
    if (compound.details.type === 'memory') return { type: 'view', name: 'memories', params: {} }
    return { type: 'view', name: 'source-info', id: compound.details.id, params: {} }
  }

  // Agents
  if (compound.navigator === 'agents') {
    if (!compound.details) {
      return { type: 'view', name: 'agents', params: {} }
    }
    return { type: 'view', name: 'agents', id: compound.details.id, params: {} }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { type: 'view', name: 'skills', params: {} }
    }
    return { type: 'view', name: 'skill-info', id: compound.details.id, params: {} }
  }

  // Projects
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { type: 'view', name: 'projects', params: {} }
    }
    return { type: 'view', name: 'project-info', id: compound.details.id, params: {} }
  }

  // Pages
  if (compound.navigator === 'pages') {
    if (!compound.details) {
      return { type: 'view', name: 'pages', params: {} }
    }
    return { type: 'view', name: 'page-info', id: compound.details.id, params: {} }
  }

  // Events
  if (compound.navigator === 'events') {
    const section = compound.eventsSection ?? 'list'
    if (!compound.details) {
      const name =
        section === 'listeners' ? 'event-listeners'
        : section === 'inbox' ? 'inbox'
        : section === 'outbox' ? 'outbox'
        : 'event-list'
      return { type: 'view', name, params: {} }
    }
    return { type: 'view', name: compound.details.type === 'outbox' ? 'outbox-info' : 'event-info', id: compound.details.id, params: {} }
  }

  // Sessions
  if (compound.sessionFilter) {
    const filter = compound.sessionFilter
    if (compound.details) {
      return {
        type: 'view',
        name: 'session',
        id: compound.details.id,
        params: {
          filter: filter.kind,
        },
      }
    }
    return {
      type: 'view',
      name: filter.kind,
      id: undefined,
      params: {},
    }
  }

  return { type: 'view', name: 'allSessions', params: {} }
}

// =============================================================================
// NavigationState Parsing (new unified system)
// =============================================================================

/**
 * Parse a route string directly to NavigationState (the unified state)
 *
 * This is the preferred way to parse routes - returns the unified state that
 * determines all 3 panels (sidebar, navigator, main content).
 *
 * Supports:
 * - Compound routes: allSessions, allSessions/session/abc, sources, sources/source/github, settings/shortcuts
 * - Right sidebar param: ?sidebar=files or ?sidebar=history
 *
 * Returns null for action routes (they don't map to a navigation state) and invalid routes.
 */
export function parseRouteToNavigationState(
  route: string,
  sidebarParam?: string
): NavigationState | null {
  // Parse compound routes
  if (isCompoundRoute(route)) {
    const compound = parseCompoundRoute(route)
    if (compound) {
      const state = convertCompoundToNavigationState(compound)
      // Add rightSidebar if param provided
      const rightSidebar = parseRightSidebarParam(sidebarParam)
      if (rightSidebar) {
        return { ...state, rightSidebar }
      }
      return state
    }
  }

  // Parse as route (may be action or view)
  const parsed = parseRoute(route)
  if (!parsed) return null

  // Actions don't map to navigation state
  if (parsed.type === 'action') return null

  // Convert view routes to NavigationState
  const state = convertParsedRouteToNavigationState(parsed)
  if (state) {
    // Add rightSidebar if param provided
    const rightSidebar = parseRightSidebarParam(sidebarParam)
    if (rightSidebar) {
      return { ...state, rightSidebar }
    }
  }
  return state
}

/**
 * Convert a ParsedCompoundRoute to NavigationState
 */
function convertCompoundToNavigationState(compound: ParsedCompoundRoute): NavigationState {
  // Task board
  if (compound.navigator === 'tasks') {
    return {
      navigator: 'tasks',
      selectedTaskId: compound.selectedTaskId ?? compound.details?.id ?? null,
    }
  }

  // Settings
  if (compound.navigator === 'settings') {
    if (!compound.details) {
      return { navigator: 'settings', subpage: null }
    }
    return { navigator: 'settings', subpage: compound.details.type as SettingsSubpage }
  }

  // Sources - include filter if present
  if (compound.navigator === 'sources') {
    if (!compound.details) {
      return {
        navigator: 'sources',
        filter: compound.sourceFilter,
        details: null,
      }
    }
    return {
      navigator: 'sources',
      filter: compound.sourceFilter,
      details: compound.details.type === 'memory'
        ? { type: 'memory', id: 'global' }
        : { type: 'source', sourceSlug: compound.details.id },
    }
  }

  // Agents
  if (compound.navigator === 'agents') {
    if (!compound.details) {
      return { navigator: 'agents', details: null }
    }
    return {
      navigator: 'agents',
      details: { type: 'agent', id: compound.details.id },
    }
  }

  // Skills
  if (compound.navigator === 'skills') {
    if (!compound.details) {
      return { navigator: 'skills', details: null }
    }
    return {
      navigator: 'skills',
      details: { type: 'skill', skillSlug: compound.details.id },
    }
  }

  // Projects
  if (compound.navigator === 'projects') {
    if (!compound.details) {
      return { navigator: 'projects', details: null }
    }
    return {
      navigator: 'projects',
      details: { type: 'project', projectSlug: compound.details.id },
    }
  }

  // Pages
  if (compound.navigator === 'pages') {
    if (!compound.details) {
      return { navigator: 'pages', details: null }
    }
    return {
      navigator: 'pages',
      details: { type: 'page', pageSlug: compound.details.id },
    }
  }

  // Events
  if (compound.navigator === 'events') {
    const section = compound.eventsSection ?? 'list'
    if (!compound.details) {
      return { navigator: 'events', section, details: null }
    }
    return {
      navigator: 'events',
      section,
      details:
        compound.details.type === 'listener'
          ? { type: 'listener', listenerId: compound.details.id }
          : compound.details.type === 'outbox'
            ? { type: 'outbox', outboxId: compound.details.id }
            : { type: 'event', eventId: compound.details.id },
    }
  }

  // Sessions
  const filter = compound.sessionFilter || { kind: 'allSessions' as const }
  if (compound.details) {
    return {
      navigator: 'sessions',
      filter,
      details: { type: 'session', sessionId: compound.details.id },
    }
  }
  return {
    navigator: 'sessions',
    filter,
    details: null,
  }
}

/**
 * Convert a ParsedRoute (view type) to NavigationState
 */
function convertParsedRouteToNavigationState(parsed: ParsedRoute): NavigationState | null {
  // Only handle view routes (compound routes converted to view type)
  if (parsed.type !== 'view') {
    return null
  }

  switch (parsed.name) {
    case 'settings':
      return { navigator: 'settings', subpage: 'app' }
    case 'workspace':
      return { navigator: 'settings', subpage: 'workspace' }
    case 'permissions':
      return { navigator: 'settings', subpage: 'permissions' }
    case 'shortcuts':
      return { navigator: 'settings', subpage: 'shortcuts' }
    case 'sources':
      return { navigator: 'sources', details: null }
    case 'memories':
      return { navigator: 'sources', details: { type: 'memory', id: 'global' } }
    case 'source-info':
      if (parsed.id) {
        return {
          navigator: 'sources',
          details: {
            type: 'source',
            sourceSlug: parsed.id,
          },
        }
      }
      return { navigator: 'sources', details: null }
    case 'skills':
      return { navigator: 'skills', details: null }
    case 'skill-info':
      if (parsed.id) {
        return {
          navigator: 'skills',
          details: {
            type: 'skill',
            skillSlug: parsed.id,
          },
        }
      }
      return { navigator: 'skills', details: null }
    case 'projects':
      return { navigator: 'projects', details: null }
    case 'project-info':
      if (parsed.id) {
        return {
          navigator: 'projects',
          details: { type: 'project', projectSlug: parsed.id },
        }
      }
      return { navigator: 'projects', details: null }
    case 'pages':
      return { navigator: 'pages', details: null }
    case 'page-info':
      if (parsed.id) {
        return {
          navigator: 'pages',
          details: { type: 'page', pageSlug: parsed.id },
        }
      }
      return { navigator: 'pages', details: null }
    case 'session':
      if (parsed.id) {
        // Reconstruct filter from params
        const filterKind = (parsed.params.filter || 'allSessions') as SessionFilter['kind']
        const filter: SessionFilter =
          filterKind === 'archived' ? { kind: 'archived' } : { kind: 'allSessions' }
        return {
          navigator: 'sessions',
          filter,
          details: { type: 'session', sessionId: parsed.id },
        }
      }
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'allSessions':
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      }
    case 'archived':
      return {
        navigator: 'sessions',
        filter: { kind: 'archived' },
        details: null,
      }
    case 'state':
      // Status dimension removed — legacy state routes land on all sessions
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'view':
      // View dimension removed — legacy view routes land on all sessions
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    default:
      return null
  }
}

/**
 * Convert NavigationState to ParsedCompoundRoute
 */
function navigationStateToCompoundRoute(state: NavigationState): ParsedCompoundRoute {
  if (state.navigator === 'settings') {
    if (state.subpage === null) {
      return { navigator: 'settings', details: null }
    }
    return {
      navigator: 'settings',
      details: { type: state.subpage, id: state.subpage },
    }
  }

  if (state.navigator === 'sources') {
    return {
      navigator: 'sources',
      sourceFilter: state.filter ?? undefined,
      details: state.details
        ? state.details.type === 'memory'
          ? { type: 'memory', id: 'global' }
          : { type: 'source', id: state.details.sourceSlug }
        : null,
    }
  }

  if (state.navigator === 'skills') {
    return {
      navigator: 'skills',
      details: state.details?.type === 'skill' ? { type: 'skill', id: state.details.skillSlug } : null,
    }
  }

  if (state.navigator === 'projects') {
    return {
      navigator: 'projects',
      details: state.details ? { type: 'project', id: state.details.projectSlug } : null,
    }
  }

  if (state.navigator === 'pages') {
    return {
      navigator: 'pages',
      details: state.details ? { type: 'page', id: state.details.pageSlug } : null,
    }
  }

  if (state.navigator === 'events') {
    return {
      navigator: 'events',
      eventsSection: state.section,
      details:
        state.details?.type === 'event'
          ? { type: 'event', id: state.details.eventId }
          : state.details?.type === 'listener'
            ? { type: 'listener', id: state.details.listenerId }
            : state.details?.type === 'outbox'
              ? { type: 'outbox', id: state.details.outboxId }
              : null,
    }
  }

  if (state.navigator === 'tasks') {
    return {
      navigator: 'tasks',
      selectedTaskId: state.selectedTaskId ?? null,
      details: null,
    }
  }

  if (state.navigator === 'agents') {
    return {
      navigator: 'agents',
      details: state.details ? { type: 'agent', id: state.details.id } : null,
    }
  }

  // Sessions (the only remaining variant that carries filter/details)
  if (state.navigator !== 'sessions') {
    // Anything added later must get an explicit branch above; falling through
    // here would silently produce an empty sessions state.
    return { navigator: 'sessions', details: null, sessionFilter: undefined }
  }
  return {
    navigator: 'sessions',
    sessionFilter: state.filter,
    details: state.details ? { type: 'session', id: state.details.sessionId } : null,
  }
}

/**
 * Build a route string from NavigationState
 */
export function buildRouteFromNavigationState(state: NavigationState): string {
  return buildCompoundRoute(navigationStateToCompoundRoute(state))
}

// =============================================================================
// Right Sidebar Param Parsing
// =============================================================================

/**
 * Parse right sidebar param from URL query string
 *
 * Examples:
 *   'history' -> { type: 'history' }
 *   'files' -> { type: 'files' }
 *   'files/src/main.ts' -> { type: 'files', path: 'src/main.ts' }
 *   'none' -> { type: 'none' }
 */
export function parseRightSidebarParam(sidebarStr?: string): RightSidebarPanel | undefined {
  if (!sidebarStr) return undefined

  if (sidebarStr === 'history') {
    return { type: 'history' }
  }
  if (sidebarStr.startsWith('files')) {
    const path = sidebarStr.substring(6) // Remove 'files/' prefix
    return { type: 'files', path: path || undefined }
  }
  if (sidebarStr === 'none') {
    return { type: 'none' }
  }

  return undefined
}

/**
 * Build right sidebar param for URL query string
 *
 * Returns undefined for 'none' type (omit from URL to keep URLs clean)
 */
export function buildRightSidebarParam(panel?: RightSidebarPanel): string | undefined {
  if (!panel || panel.type === 'none') return undefined

  switch (panel.type) {
    case 'history':
      return 'history'
    case 'files':
      return panel.path ? `files/${panel.path}` : 'files'
    default:
      return undefined
  }
}
