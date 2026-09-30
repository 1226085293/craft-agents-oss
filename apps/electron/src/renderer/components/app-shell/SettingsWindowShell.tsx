import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'

import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { NavigationContext, type Route } from '@/contexts/NavigationContext'
import SettingsNavigator from '@/pages/settings/SettingsNavigator'
import { getSettingsPageComponent } from '@/pages/settings/settings-pages'
import { SETTINGS_ICONS } from '@/components/icons/SettingsIcons'
import { isMac, isWebUI } from '@/lib/platform'
import { NAVIGATE_EVENT, type NavigateOptions } from '@/lib/navigate'
import {
  buildWorkspaceDeepLink,
  normalizeSettingsRoute,
  openMainWindowSession,
  settingsRouteFromLocation,
  settingsSubpageFromRoute,
  SETTINGS_ROUTE_PARAM,
  SETTINGS_WINDOW_MODE,
  SETTINGS_WINDOW_MODE_PARAM,
} from '@/lib/settings-window'
import { routes } from '../../../shared/routes'
import type { NavigationState, RightSidebarPanel, SettingsSubpage } from '../../../shared/types'
import { cn } from '@/lib/utils'

const SETTINGS_TITLEBAR_HEIGHT = 48

/**
 * Local error boundary for settings subpages. A crash in one settings page
 * (e.g. a data table) must not take the whole settings window down into the
 * app-level CrashFallback. We log the real stack (tagged for DevTools capture)
 * and offer an in-place retry instead of a full-window "restart the app" screen.
 */
class SettingsPageErrorBoundary extends Component<
  {
    children: ReactNode
    subpage: SettingsSubpage
    onRetry: () => void
  },
  { hasError: boolean; message: string; stack: string; componentStack: string }
> {
  state = { hasError: false, message: '', stack: '', componentStack: '' }

  static getDerivedStateFromError() {
    return { hasError: true, message: '', stack: '', componentStack: '' }
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack ?? String(error) : String(error)
    const componentStack = errorInfo.componentStack ?? ''
    console.error('[SettingsCrash] uncaught error in settings page', this.props.subpage, stack, componentStack)
    // Surface the real stack in the fallback card so it can be read/screenshotted.
    this.setState({ message, stack, componentStack })
  }

  render() {
    if (this.state.hasError) {
      return (
        <SettingsPageErrorFallback
          subpage={this.props.subpage}
          onRetry={this.props.onRetry}
          detail={{
            message: this.state.message,
            stack: this.state.stack,
            componentStack: this.state.componentStack,
          }}
        />
      )
    }
    return this.props.children
  }
}

interface SettingsPageCrashDetail {
  message?: string
  stack?: string
  componentStack?: string
}

function SettingsPageErrorFallback({
  subpage,
  onRetry,
  detail,
}: {
  subpage: SettingsSubpage
  onRetry: () => void
  detail?: SettingsPageCrashDetail
}) {
  const { t } = useTranslation()
  const hasDetail = Boolean(detail && (detail.message || detail.stack || detail.componentStack))
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-8 text-center">
      <div className="text-sm font-medium text-foreground">
        {t('crash.somethingWentWrong')}
      </div>
      <div className="max-w-xs text-xs text-muted-foreground">
        {t('settings.pageError', { defaultValue: 'The "{{subpage}}" page failed to load.', subpage })}
      </div>
      {hasDetail && (
        <div className="w-full max-w-[520px] space-y-2 text-left">
          {detail?.message ? (
            <div className="rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] text-foreground/90">
              <div className="mb-1 font-medium text-muted-foreground">message</div>
              <div className="whitespace-pre-wrap break-words">{detail.message}</div>
            </div>
          ) : null}
          {detail?.stack ? (
            <div className="rounded-md border border-border/60 bg-background p-2 text-[11px] leading-snug text-foreground/80">
              <div className="mb-1 font-medium text-muted-foreground">stack</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                {detail.stack}
              </pre>
            </div>
          ) : null}
          {detail?.componentStack ? (
            <div className="rounded-md border border-border/60 bg-background p-2 text-[11px] leading-snug text-foreground/80">
              <div className="mb-1 font-medium text-muted-foreground">component stack</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                {detail.componentStack}
              </pre>
            </div>
          ) : null}
        </div>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-background px-4 py-1.5 text-[13px] text-foreground/80 shadow-minimal"
      >
        {t('crash.reload')}
      </button>
    </div>
  )
}

interface SettingsWindowNavigationProviderProps {
  children: ReactNode
  workspaceId: string | null
  onSubpageChange?: (subpage: SettingsSubpage) => void
}

function writeSettingsLocation(subpage: SettingsSubpage, replace: boolean): void {
  const url = new URL(window.location.href)
  url.searchParams.set(SETTINGS_WINDOW_MODE_PARAM, SETTINGS_WINDOW_MODE)
  url.searchParams.set(SETTINGS_ROUTE_PARAM, routes.view.settings(subpage))

  // These parameters belong to the main chat shell. Keeping them here would
  // make a later NavigationProvider restore look as if this were a chat window.
  for (const key of ['window', 'focused', 'sessionId', 'ws', 'panels', 'fi', 'sidebar']) {
    url.searchParams.delete(key)
  }

  const method = replace ? 'replaceState' : 'pushState'
  window.history[method]({ settingsWindow: true, subpage }, '', url.toString())
}

/**
 * Lightweight navigation context for the independent settings shell.
 *
 * The regular NavigationContext is intentionally chat/panel oriented: it
 * restores panel stacks, writes workspace URL state, and auto-deletes empty
 * sessions. Settings only needs a small URL-driven route history and a way
 * to send non-settings routes back to the main workspace window.
 */
function SettingsWindowNavigationProvider({
  children,
  workspaceId,
  onSubpageChange,
}: SettingsWindowNavigationProviderProps) {
  const [subpage, setSubpage] = useState<SettingsSubpage>(() =>
    settingsSubpageFromRoute(settingsRouteFromLocation()),
  )
  const subpageRef = useRef(subpage)

  const applyRoute = useCallback((route: string, replace = false) => {
    const normalized = normalizeSettingsRoute(route)
    const next = settingsSubpageFromRoute(normalized)
    if (!replace && subpageRef.current === next) return
    subpageRef.current = next
    setSubpage(next)
    onSubpageChange?.(next)
    writeSettingsLocation(next, replace)
  }, [onSubpageChange])

  // Canonicalize the bootstrap URL once. This also removes legacy main-window
  // parameters that may have been carried into a restored settings URL.
  useEffect(() => {
    const initial = settingsSubpageFromRoute(settingsRouteFromLocation())
    subpageRef.current = initial
    setSubpage(initial)
    onSubpageChange?.(initial)
    writeSettingsLocation(initial, true)
  }, [onSubpageChange])

  useEffect(() => {
    const handlePopState = () => {
      const next = settingsSubpageFromRoute(settingsRouteFromLocation())
      subpageRef.current = next
      setSubpage(next)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ route?: Route }>).detail
      if (detail?.route) applyRoute(detail.route)
    }
    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
  }, [applyRoute])

  useEffect(() => {
    const cleanup = window.electronAPI?.onDeepLinkNavigate((navigation) => {
      if (navigation.view) applyRoute(navigation.view)
    })
    return () => cleanup?.()
  }, [applyRoute])

  const navigate = useCallback((route: Route, _options?: NavigateOptions) => {
    if (route.startsWith('settings')) {
      applyRoute(route)
      return
    }

    // A settings window must not turn a session click into a settings URL.
    // Forward ordinary routes to the workspace's regular chat window.
    void window.electronAPI?.openUrl(buildWorkspaceDeepLink(route, workspaceId))
  }, [applyRoute, workspaceId])

  const navigateToSession = useCallback((sessionId: string) => {
    void openMainWindowSession(sessionId, workspaceId)
  }, [workspaceId])

  const navigateToSource = useCallback((sourceSlug?: string) => {
    void window.electronAPI?.openUrl(buildWorkspaceDeepLink(
      routes.view.sources(sourceSlug ? { sourceSlug } : undefined),
      workspaceId,
    ))
  }, [workspaceId])

  const navigationState = useMemo<NavigationState>(() => ({
    navigator: 'settings',
    subpage,
  }), [subpage])

  const contextValue = useMemo(() => ({
    navigate,
    isReady: true,
    navigationState,
    canGoBack: window.history.length > 1,
    canGoForward: false,
    goBack: () => window.history.back(),
    goForward: () => window.history.forward(),
    updateRightSidebar: (_panel: RightSidebarPanel | undefined) => {},
    toggleRightSidebar: (_panel?: RightSidebarPanel) => {},
    navigateToSource,
    navigateToSession,
  }), [navigate, navigationState, navigateToSource, navigateToSession])

  return (
    <NavigationContext.Provider value={contextValue}>
      {children}
    </NavigationContext.Provider>
  )
}

interface SettingsWindowShellProps {
  contextValue: AppShellContextType
  workspaceId: string | null
}

/**
 * The auxiliary settings window. It intentionally does not mount AppShell or
 * NavigationProvider, so opening settings cannot alter chat selection, drafts,
 * panel layout, or the last-selected-session storage key.
 */
export function SettingsWindowShell({ contextValue, workspaceId }: SettingsWindowShellProps) {
  const { t } = useTranslation()
  const { activeWorkspaceSlug } = contextValue
  const [subpage, setSubpage] = useState<SettingsSubpage>(() =>
    settingsSubpageFromRoute(settingsRouteFromLocation()),
  )
  // Bumped on in-place retry to remount (and reset) the page error boundary.
  const [pageResetKey, setPageResetKey] = useState(0)
  const SettingsPageComponent = getSettingsPageComponent(subpage)
  const CurrentIcon = SETTINGS_ICONS[subpage as keyof typeof SETTINGS_ICONS] ?? Settings2
  const hasMacStoplights = isMac && !isWebUI

  // Keep the shell in sync with URL changes performed by the lightweight
  // provider. The provider owns history writes; this effect only mirrors state.
  useEffect(() => {
    const sync = () => setSubpage(settingsSubpageFromRoute(settingsRouteFromLocation()))
    const syncFromRouteEvent = (event: Event) => {
      const route = (event as CustomEvent<{ route?: string }>).detail?.route
      if (route) setSubpage(settingsSubpageFromRoute(route))
    }
    window.addEventListener('popstate', sync)
    window.addEventListener(NAVIGATE_EVENT, syncFromRouteEvent)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(NAVIGATE_EVENT, syncFromRouteEvent)
    }
  }, [])

  return (
    <SettingsWindowNavigationProvider
      workspaceId={workspaceId}
      onSubpageChange={setSubpage}
    >
      <AppShellProvider value={contextValue}>
        <EscapeInterruptProvider>
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
          <header
            className={cn(
              'titlebar-drag-region flex shrink-0 items-center border-b border-border/60',
              hasMacStoplights ? 'pl-[84px]' : 'pl-4',
              'pr-4',
            )}
            style={{ height: SETTINGS_TITLEBAR_HEIGHT } as CSSProperties}
          >
            <div className="flex min-w-0 items-center gap-2">
              <CurrentIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">{t('menu.settings')}</span>
            </div>
            {activeWorkspaceSlug && (
              <div className="titlebar-no-drag ml-auto max-w-[45%] truncate rounded-md bg-foreground/5 px-2 py-1 text-xs text-muted-foreground">
                {activeWorkspaceSlug}
              </div>
            )}
          </header>

          <div className="flex min-h-0 flex-1">
            <aside className="w-[260px] shrink-0 overflow-hidden border-r border-border/60 bg-foreground/[0.015] max-[700px]:w-[220px]">
              <SettingsNavigator
                selectedSubpage={subpage}
                onSelectSubpage={(next) => {
                  // The navigator's click is routed through the same history
                  // contract as every other settings navigation.
                  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, {
                    detail: { route: routes.view.settings(next) },
                    bubbles: true,
                  }))
                }}
                showOpenInNewWindow={false}
              />
            </aside>
            <main className="min-w-0 flex-1 overflow-hidden">
              <SettingsPageErrorBoundary
                key={`settings-page-${subpage}-${pageResetKey}`}
                subpage={subpage}
                onRetry={() => setPageResetKey((k) => k + 1)}
              >
                <SettingsPageComponent />
              </SettingsPageErrorBoundary>
            </main>
          </div>
        </div>
        </EscapeInterruptProvider>
      </AppShellProvider>
    </SettingsWindowNavigationProvider>
  )
}
