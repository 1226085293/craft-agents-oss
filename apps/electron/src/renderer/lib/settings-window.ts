import { isValidSettingsSubpage, type SettingsSubpage } from '../../shared/settings-registry'
import { routes, type Route } from '../../shared/routes'

/** The settings shell always has a concrete content page, even for bare `settings`. */
export const DEFAULT_SETTINGS_SUBPAGE: SettingsSubpage = 'app'

/** Query keys used by the Electron window bootstrap. */
export const SETTINGS_WINDOW_MODE_PARAM = 'windowMode'
export const SETTINGS_WINDOW_MODE = 'settings'
export const SETTINGS_ROUTE_PARAM = 'route'

/** Normalize arbitrary user/deep-link input to a known settings subpage. */
export function normalizeSettingsSubpage(value: string | null | undefined): SettingsSubpage {
  return value && isValidSettingsSubpage(value) ? value : DEFAULT_SETTINGS_SUBPAGE
}

/** Normalize a settings route and always return a renderable settings route. */
export function normalizeSettingsRoute(value: string | null | undefined): string {
  const raw = value?.trim().replace(/^\/+/, '')
  const subpage = raw?.startsWith('settings/')
    ? raw.slice('settings/'.length).split('/')[0]
    : raw === 'settings'
      ? DEFAULT_SETTINGS_SUBPAGE
      : raw
  return routes.view.settings(normalizeSettingsSubpage(subpage))
}

/** Read the canonical settings subpage from a settings route. */
export function settingsSubpageFromRoute(value: string | null | undefined): SettingsSubpage {
  const normalized = normalizeSettingsRoute(value)
  return normalizeSettingsSubpage(normalized.slice('settings/'.length).split('/')[0])
}

/** Whether the current browser window was opened as the independent settings shell. */
export function isSettingsWindowMode(location: Pick<Location, 'search'> = window.location): boolean {
  return new URLSearchParams(location.search).get(SETTINGS_WINDOW_MODE_PARAM) === SETTINGS_WINDOW_MODE
}

/** Read the initial route passed by the main process. */
export function settingsRouteFromLocation(location: Pick<Location, 'search'> = window.location): string {
  const params = new URLSearchParams(location.search)
  return normalizeSettingsRoute(params.get(SETTINGS_ROUTE_PARAM))
}

function encodeWorkspaceId(workspaceId: string): string {
  return encodeURIComponent(workspaceId)
}

/**
 * Build a workspace-scoped Craft deep link.
 * Workspace scoping is important when the caller is a settings window: it must
 * never route a session click through the settings shell's own URL history.
 */
export function buildWorkspaceDeepLink(route: string, workspaceId?: string | null): string {
  if (workspaceId) {
    return `craftagents://workspace/${encodeWorkspaceId(workspaceId)}/${route.replace(/^\/+/, '')}`
  }
  return `craftagents://${route.replace(/^\/+/, '')}`
}

/** Build the URL used to open/reuse a settings window for a workspace. */
export function buildSettingsWindowDeepLink(
  subpage?: string | null,
  workspaceId?: string | null,
): string {
  return buildWorkspaceDeepLink(normalizeSettingsRoute(subpage), workspaceId)
}

/**
 * Ask the main process to open or focus the settings shell. Missing Electron
 * APIs are intentionally a no-op so the helper remains safe in web previews.
 */
export async function openSettingsWindow(
  subpage?: string | null,
  workspaceId?: string | null,
): Promise<void> {
  const url = buildSettingsWindowDeepLink(subpage, workspaceId)
  await window.electronAPI?.openUrl(url)
}

/** Open a session in the regular chat window from a settings window. */
export async function openMainWindowSession(sessionId: string, workspaceId?: string | null): Promise<void> {
  await window.electronAPI?.openUrl(buildWorkspaceDeepLink(routes.view.allSessions(sessionId), workspaceId))
}

/** Build a settings route from arbitrary deep-link navigation data. */
export function settingsRouteFromDeepLinkView(view: string | null | undefined): string {
  return normalizeSettingsRoute(view)
}
