/**
 * TopBarShelf
 *
 * The top-right "what do I have open" strip. Two kinds of entries share it:
 *   - standalone Page windows (real OS windows created by the main process)
 *   - browser windows (native, owned by the main process)
 *
 * They are visually grouped with a hairline separator but keep their own
 * verbs: browser badges open browser-window actions, page badges focus or
 * close the page window.
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useAppShellContext } from '@/context/AppShellContext'
import { pagesAtom } from '@/atoms/pages'
import {
  pageWindowsAtom,
  removePageWindowAtom,
  setPageWindowsAtom,
  updatePageWindowAtom,
} from '@/atoms/page-windows'
import { browserInstancesAtom, filterInstancesForWorkspace } from '@/atoms/browser-pane'
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import { PAGE_KIND_ICONS } from '@/components/pages/page-visuals'
import { BrowserTabStrip } from '@/components/browser/BrowserTabStrip'
import type { PageWindowInfo } from '../../../shared/types'

interface TopBarShelfProps {
  activeSessionId?: string | null
  /** Width-derived budget for browser badges (1–3). */
  maxVisibleBrowserBadges: number
}

export function TopBarShelf({ activeSessionId, maxVisibleBrowserBadges }: TopBarShelfProps) {
  const { activeWorkspaceId, workspaces } = useAppShellContext()
  const pageWindows = useAtomValue(pageWindowsAtom)
  const pages = useAtomValue(pagesAtom)
  const allInstances = useAtomValue(browserInstancesAtom)
  const setPageWindows = useSetAtom(setPageWindowsAtom)
  const updatePageWindow = useSetAtom(updatePageWindowAtom)
  const removePageWindow = useSetAtom(removePageWindowAtom)
  const { t } = useTranslation()

  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
  const remoteWorkspaceId = activeWorkspace?.remoteServer?.remoteWorkspaceId ?? null

  const browserCount = filterInstancesForWorkspace(
    allInstances,
    activeWorkspaceId,
    remoteWorkspaceId,
  ).length

  // Sync the standalone-window list from the main process.
  React.useEffect(() => {
    const api = window.electronAPI?.pageWindow
    if (!api) return
    if (!window.electronAPI.isChannelAvailable('page-window:list')) return

    void api.list().then(setPageWindows).catch(error => {
      console.warn('[TopBarShelf] Failed to list page windows:', error)
    })
    const offState = api.onStateChanged(updatePageWindow)
    const offRemoved = api.onRemoved(removePageWindow)
    return () => {
      offState()
      offRemoved()
    }
  }, [setPageWindows, updatePageWindow, removePageWindow])

  const visibleWindows = React.useMemo(
    () =>
      pageWindows.filter(
        win =>
          win.workspaceId === activeWorkspaceId || win.workspaceId === remoteWorkspaceId,
      ),
    [pageWindows, activeWorkspaceId, remoteWorkspaceId],
  )

  const pageName = React.useCallback(
    (win: PageWindowInfo) =>
      pages.find(p => p.config.slug === win.pageSlug)?.config.name ?? win.title ?? win.pageSlug,
    [pages],
  )

  const focusWindow = React.useCallback((win: PageWindowInfo) => {
    void window.electronAPI.pageWindow.focus(win.id)
  }, [])

  const closeWindow = React.useCallback((win: PageWindowInfo) => {
    void window.electronAPI.pageWindow.close(win.id)
  }, [])

  const renderWindowActions = React.useCallback(
    (win: PageWindowInfo) => (
      <>
        <StyledDropdownMenuItem onSelect={() => focusWindow(win)}>
          <Icons.Monitor className="h-3.5 w-3.5" />
          {t('pages.showWindow')}
        </StyledDropdownMenuItem>
        <StyledDropdownMenuSeparator />
        <StyledDropdownMenuItem variant="destructive" onSelect={() => closeWindow(win)}>
          <Icons.XCircle className="h-3.5 w-3.5" />
          {t('pages.closeWindow')}
        </StyledDropdownMenuItem>
      </>
    ),
    [focusWindow, closeWindow, t],
  )

  if (visibleWindows.length === 0) {
    return (
      <BrowserTabStrip
        activeSessionId={activeSessionId}
        maxVisibleBadges={maxVisibleBrowserBadges}
      />
    )
  }

  // Pages take priority in the shelf; browsers keep at least one slot.
  const maxPageChips = maxVisibleBrowserBadges >= 3 ? 2 : 1
  const chips = visibleWindows.slice(0, maxPageChips)
  const overflow = visibleWindows.slice(maxPageChips)
  const browserBudget = Math.max(1, maxVisibleBrowserBadges - chips.length)

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {chips.map(win => {
        const page = pages.find(p => p.config.slug === win.pageSlug)
        const KindIcon = PAGE_KIND_ICONS[page?.config.kind ?? 'interactive']
        return (
          <DropdownMenu key={win.id}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'group flex h-[26px] max-w-[160px] items-center gap-1 rounded-lg bg-background pl-2.5 pr-1.5',
                  'text-[11px] leading-tight shadow-minimal transition-colors titlebar-no-drag',
                  win.isFocused
                    ? 'text-foreground ring-1 ring-foreground/15'
                    : 'text-foreground/70 hover:bg-foreground/[0.03]',
                )}
                aria-label={`${pageName(win)} window actions`}
              >
                <KindIcon className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
                <span className="ml-0.5 truncate leading-[12px]">{pageName(win)}</span>
                {win.isMinimized && (
                  <Icons.Minimize2 className="h-2.5 w-2.5 shrink-0 opacity-55" aria-hidden />
                )}
                <span className="flex h-3 w-3 shrink-0 items-center justify-center opacity-55 transition-opacity group-hover:opacity-90">
                  <Icons.ChevronDown className="h-2.5 w-2.5" />
                </span>
              </button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end" minWidth="min-w-56">
              {renderWindowActions(win)}
            </StyledDropdownMenuContent>
          </DropdownMenu>
        )
      })}

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="h-[26px] rounded-lg bg-background px-1.5 text-[11px] text-foreground/50 shadow-minimal transition-colors hover:bg-foreground/[0.03] titlebar-no-drag"
            >
              +{overflow.length}
            </button>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-64">
            {overflow.map(win => (
              <DropdownMenuSub key={win.id}>
                <StyledDropdownMenuSubTrigger>
                  <Icons.Globe className="h-3.5 w-3.5" />
                  <span className="truncate">{pageName(win)}</span>
                </StyledDropdownMenuSubTrigger>
                <StyledDropdownMenuSubContent minWidth="min-w-56">
                  {renderWindowActions(win)}
                </StyledDropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}

      {browserCount > 0 && <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden />}

      <BrowserTabStrip
        activeSessionId={activeSessionId}
        maxVisibleBadges={browserBudget}
      />
    </div>
  )
}
