import { RPC_CHANNELS, type PageWindowInfo } from '../../shared/types'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.pageWindow.OPEN,
  RPC_CHANNELS.pageWindow.LIST,
  RPC_CHANNELS.pageWindow.FOCUS,
  RPC_CHANNELS.pageWindow.CLOSE,
  RPC_CHANNELS.pageWindow.MINIMIZE_SELF,
  RPC_CHANNELS.pageWindow.CLOSE_SELF,
] as const

/**
 * Standalone Page windows (real OS windows). These are GUI-only: the main
 * window opens/focuses/closes them, and each page window can minimize or
 * close itself from its custom title bar.
 */
export function registerPageWindowHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager
  if (!windowManager) return

  server.handle(
    RPC_CHANNELS.pageWindow.OPEN,
    (ctx, input: { workspaceId?: string; pageSlug?: string }) => {
      const workspaceId = input?.workspaceId ?? ctx.workspaceId
      if (!workspaceId) throw new Error('workspaceId is required to open a page window')
      if (!input?.pageSlug) throw new Error('pageSlug is required to open a page window')
      return windowManager.openPageWindow({ workspaceId, pageSlug: input.pageSlug })
    },
  )

  server.handle(RPC_CHANNELS.pageWindow.LIST, () => windowManager.listPageWindows())

  server.handle(RPC_CHANNELS.pageWindow.FOCUS, (_ctx, id: string) => {
    windowManager.focusPageWindow(id)
  })

  server.handle(RPC_CHANNELS.pageWindow.CLOSE, (_ctx, id: string) => {
    windowManager.closePageWindow(id)
  })

  server.handle(RPC_CHANNELS.pageWindow.MINIMIZE_SELF, (ctx) => {
    if (ctx.webContentsId != null) windowManager.minimizePageWindowSelf(ctx.webContentsId)
  })

  server.handle(RPC_CHANNELS.pageWindow.CLOSE_SELF, (ctx) => {
    if (ctx.webContentsId != null) windowManager.closePageWindowSelf(ctx.webContentsId)
  })

  // Broadcast to every renderer; each filters by workspace (same contract as
  // browser windows — remote-mirror workspace ids never match a targeted push).
  windowManager.onPageWindowStateChange?.((info: PageWindowInfo) => {
    pushTyped(server, RPC_CHANNELS.pageWindow.STATE_CHANGED, { to: 'all' }, info)
  })

  windowManager.onPageWindowRemoved?.((id: string) => {
    pushTyped(server, RPC_CHANNELS.pageWindow.REMOVED, { to: 'all' }, id)
  })
}
