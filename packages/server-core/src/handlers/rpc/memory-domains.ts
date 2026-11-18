import { existsSync, readFileSync } from 'node:fs';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { loadAgents } from '@craft-agent/shared/agents';
import { ensureAgentMemoryDomain, loadMemoryDomains, type MemoryDomainsFile } from '@craft-agent/shared/memory';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

export const HANDLED_CHANNELS = [RPC_CHANNELS.memoryDomains.LIST, RPC_CHANNELS.memoryDomains.READ] as const;

/** Hard cap on a single domain read: MEMORY.md is a curated note, not a dump. */
const MAX_DOMAIN_CONTENT_CHARS = 200_000;

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

  /**
   * Read one domain's memory file for the settings view. The slug must match
   * a registered domain; the path is taken from the registry entry, never
   * from the caller — an unknown slug yields the empty shape, not a 404
   * race against the filesystem.
   */
  server.handle(
    RPC_CHANNELS.memoryDomains.READ,
    async (
      _ctx,
      workspaceId: string,
      slug: string,
    ): Promise<{
      slug: string;
      kind?: 'personal' | 'project';
      path?: string;
      mattersMost?: string;
      exists: boolean;
      content: string;
      truncated: boolean;
    }> => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) return { slug, exists: false, content: '', truncated: false };
      const file = loadMemoryDomains(workspace.rootPath, false);
      const domain = file.domains.find((entry) => entry.slug === slug);
      if (!domain) return { slug, exists: false, content: '', truncated: false };
      let exists = false;
      let content = '';
      const domainPath = domain.path;
      try {
        if (domainPath && existsSync(domainPath)) {
          content = readFileSync(domainPath, 'utf8');
          exists = true;
        }
      } catch (error) {
        log.warn(`MEMORY_DOMAINS_READ: ${slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const truncated = content.length > MAX_DOMAIN_CONTENT_CHARS;
      return {
        slug,
        kind: domain.kind,
        path: domain.path,
        ...(domain.mattersMost ? { mattersMost: domain.mattersMost } : {}),
        exists,
        content: truncated ? content.slice(0, MAX_DOMAIN_CONTENT_CHARS) : content,
        truncated,
      };
    },
  );
}
