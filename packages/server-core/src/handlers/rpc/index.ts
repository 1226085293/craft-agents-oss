import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAuthHandlers } from './auth'
import { registerFilesHandlers } from './files'
import { registerFoldersHandlers } from './folders'
import { registerLlmConnectionsHandlers } from './llm-connections'
import { registerLlmGatewayHandlers } from './llm-gateway'
import { registerOAuthHandlers } from './oauth'
import { registerResourcesHandlers } from './resources'
import { registerOnboardingHandlers } from './onboarding'
import { registerSessionsHandlers } from './sessions'
export { registerSessionsHandlers, cleanupSessionFileWatchForClient } from './sessions'
import { registerServerHandlers } from './server'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
export type { ServerHandlerContext } from '../../bootstrap/headless-start'
export { getHealthCheck } from './server'
import { registerSettingsHandlers } from './settings'
import { registerProjectsHandlers } from './projects'
import { registerPagesHandlers } from './pages'
import { registerSkillsHandlers } from './skills'
import { registerSourcesHandlers } from './sources'
import { registerSystemCoreHandlers } from './system'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'
import { registerMessagingHandlers } from './messaging'
import { registerMemoryHandlers } from './memory'
import { registerUsageHandlers } from './usage'
import { registerAutomationsHandlers } from './automations'

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerAuthHandlers(server, deps)
  registerFilesHandlers(server, deps)
  registerFoldersHandlers(server, deps)
registerLlmConnectionsHandlers(server, deps)
  registerLlmGatewayHandlers(server, deps)
  registerOAuthHandlers(server, deps)
  registerOnboardingHandlers(server, deps)
  registerResourcesHandlers(server, deps)
  registerSessionsHandlers(server, deps)
  if (serverCtx) registerServerHandlers(server, deps, serverCtx)
  registerSettingsHandlers(server, deps)
  registerProjectsHandlers(server, deps)
  registerPagesHandlers(server, deps)
  registerSkillsHandlers(server, deps)
  registerSourcesHandlers(server, deps)
  registerSystemCoreHandlers(server, deps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, deps)
  registerMessagingHandlers(server, deps)
  registerMemoryHandlers(server, deps)
  registerUsageHandlers(server, deps)
  registerAutomationsHandlers(server, deps)
}
