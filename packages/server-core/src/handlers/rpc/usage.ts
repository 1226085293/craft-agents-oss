import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getUsageStats, readUsageRecords } from '@craft-agent/shared/usage'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.usage.GET_STATS,
  RPC_CHANNELS.usage.GET_HISTORY,
] as const

export function registerUsageHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Aggregated per-slug stats, optionally scoped to a workspace.
  server.handle(RPC_CHANNELS.usage.GET_STATS, async (_ctx: unknown, workspaceId?: string) => {
    return getUsageStats(workspaceId ? { workspaceId } : undefined)
  })

  // Raw history (optionally filtered), for detail views / future expansion.
  server.handle(
    RPC_CHANNELS.usage.GET_HISTORY,
    async (_ctx: unknown, workspaceId?: string, kind?: string, slug?: string) => {
      const records = readUsageRecords(workspaceId ? { workspaceId } : undefined)
      let filtered = records
      if (kind === 'source' || kind === 'skill') filtered = filtered.filter(r => r.kind === kind)
      if (slug) filtered = filtered.filter(r => r.slug === slug)
      return filtered
    },
  )
}
