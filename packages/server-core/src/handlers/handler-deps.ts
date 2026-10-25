import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { GatewayRuntime } from '@craft-agent/shared/config'
import type { LlmUsageRecord } from '@craft-agent/shared/config'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
/**
 * Access to the in-process LLM gateway.
 *
 * Injected rather than imported directly so the RPC handlers stay testable and
 * so a host that never arms the gateway can pass an inert implementation.
 */
export interface LlmGatewayAccess {
  runtime: GatewayRuntime
  /** Read the append-only usage log. */
  readUsage: () => LlmUsageRecord[]
  /** Tell the config watcher the next events are our own save echoing back. */
  markSelfWrite: (withinMs?: number) => void
}

export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry
  /** In-process LLM gateway access. Optional so hosts need not provide it. */
  llmGateway?: LlmGatewayAccess
}
