import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { loadAgents } from '@craft-agent/shared/agents';
import { ensureAgentMemoryDomain, loadMemoryDomains, type MemoryDomainsFile } from '@craft-agent/shared/memory';
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
    // 每个助手自动注册一个可写个人域（幂等；v7 §九④ 最小动作——缺省兜底语义在
    // resolveAgentMemoryDomain：memoryDomain 未设/失效 → 个人域，查询时兜底不落库）
    for (const agent of loadAgents(workspace.rootPath).agents) {
      ensureAgentMemoryDomain(workspace.rootPath, agent.id);
    }
    return loadMemoryDomains(workspace.rootPath, false);
  });
}
