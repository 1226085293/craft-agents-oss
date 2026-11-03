import type { HandlerDeps } from './handler-deps'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { registerCoreRpcHandlers, type ServerHandlerContext } from '@craft-agent/server-core/handlers/rpc'
export { registerCoreRpcHandlers }

// GUI-only handlers remain local (Electron-specific imports)
import { registerSystemGuiHandlers } from './system'
import { registerWorkspaceGuiHandlers } from './workspace'
import { registerBrowserHandlers } from './browser'
import { registerPageWindowHandlers } from './page-window'
import { registerSettingsGuiHandlers } from './settings'

export function registerGuiRpcHandlers(server: RpcServer, deps: HandlerDeps): void {
  registerSystemGuiHandlers(server, deps)
  registerWorkspaceGuiHandlers(server, deps)
  registerBrowserHandlers(server, deps)
  registerPageWindowHandlers(server, deps)
  registerSettingsGuiHandlers(server, deps)
}

/**
 * Start the Event Center for every workspace.
 *
 * The ingest endpoint and the enabled listeners must be live before anyone
 * opens the Events page — otherwise a mail arriving at 9am is simply lost
 * because nobody clicked the tab. Started here (not in the RPC handler) so the
 * first `events:*` call never races the boot.
 */
function warmUpEventCenter(deps: HandlerDeps): void {
  void (async () => {
    try {
      const { getWorkspaces } = await import('@craft-agent/shared/config')
      const { getEventService } = await import('@craft-agent/server-core/events/event-service')
      for (const workspace of getWorkspaces()) {
        const service = await getEventService(
          workspace.id,
          workspace.rootPath,
          undefined,
          deps.sessionManager?.createEventDispatchTarget?.(),
        )
        await service.startAllEnabled(workspace.rootPath)
      }
    } catch (error) {
      // A broken listener must never block app startup.
      console.warn('[events] warm-up failed:', error)
    }
  })()
}

export function registerAllRpcHandlers(server: RpcServer, deps: HandlerDeps, serverCtx?: ServerHandlerContext): void {
  registerCoreRpcHandlers(server, deps, serverCtx)
  registerGuiRpcHandlers(server, deps)
  warmUpEventCenter(deps)
}
