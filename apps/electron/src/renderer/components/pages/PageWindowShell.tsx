/**
 * PageWindowShell
 *
 * Root of a standalone Page window: no sidebar, no panels, no top bar — just
 * the page with its custom title bar (minimize / close). Dragging is handled
 * by the CSS `titlebar-drag-region` on the PageView header.
 */

import type { AppShellContextType } from '@/context/AppShellContext'
import { AppShellProvider } from '@/context/AppShellContext'
import { PageView } from './PageView'

interface PageWindowShellProps {
  pageSlug: string
  contextValue: AppShellContextType
}

export function PageWindowShell({ pageSlug, contextValue }: PageWindowShellProps) {
  return (
    <AppShellProvider value={contextValue}>
      <div className="h-full min-h-0 bg-background">
        <PageView
          pageSlug={pageSlug}
          chrome="window"
          onMinimize={() => {
            void window.electronAPI.pageWindow.minimizeSelf()
          }}
          onClose={() => {
            void window.electronAPI.pageWindow.closeSelf()
          }}
        />
      </div>
    </AppShellProvider>
  )
}
