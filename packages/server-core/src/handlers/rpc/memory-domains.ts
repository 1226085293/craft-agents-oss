import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { loadMemoryDomains, type MemoryDomainsFile } from '@craft-agent/shared/memory';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

export const HANDLED_CHANNELS = [RPC_CHANNELS.memoryDomains.LIST] as const;

/**
 * Memory domains (v6/v7 slice C minimal): the table the 助手卡 "记忆域" dropdown
 * reads. Existing projects auto-register as shared domains (零搬家); the
 * domain resolution logic (L1 分家 / L3 注入) lands in stage 4 and reads this
 * same table — it does not grow a second one.
 */
export function registerMemoryDomainsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger;

  server.handle(RPC_CHANNELS.memoryDomains.LIST, async (_ctx, workspaceId: string): Promise<MemoryDomainsFile> => {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace) {
      log.error(`MEMORY_DOMAINS_LIST: Workspace not found: ${workspaceId}`);
      return { version: 1, domains: [] };
    }
    return loadMemoryDomains(workspace.rootPath);
  });
}
