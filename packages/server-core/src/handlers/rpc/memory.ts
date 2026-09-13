import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  loadMemoryStore,
  saveMemoryStore,
  addMemoryEntry,
  deleteMemoryEntry,
  getMemoryStats,
} from '@craft-agent/shared/memory/store'
import type { HandlerDeps } from '../handler-deps'
import type { RpcServer } from '@craft-agent/server-core/transport'

type MemoryAddPayload = {
  content: string
  type: string
  tags?: string[]
  confidence?: number
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.memory.MEMORY_GET_STATS,
  RPC_CHANNELS.memory.MEMORY_ADD,
  RPC_CHANNELS.memory.MEMORY_DELETE,
  RPC_CHANNELS.memory.MEMORY_EXTRACT,
] as const

/**
 * Memory is workspace-scoped: the store must live at `<workspaceRoot>/memory.json`
 * so the agent (BaseAgent) and this handler read/write the same file.
 */
export function registerMemoryHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_STATS, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const store = loadMemoryStore(workspaceRootPath)
    const stats = getMemoryStats(store)
    return { entries: store.entries, stats }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_ADD, async (_ctx: unknown, workspaceRootPath: string, data: MemoryAddPayload) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    if (!data?.content?.trim()) throw new Error('content is required')

    const store = loadMemoryStore(workspaceRootPath)
    const entry = addMemoryEntry(
      store,
      data.content.trim(),
      data.type as any,
      'manual',
      data.tags || [],
      data.confidence ?? 1.0,
    )
    saveMemoryStore(workspaceRootPath, store)
    return { id: entry.id }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE, async (_ctx: unknown, workspaceRootPath: string, id: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const store = loadMemoryStore(workspaceRootPath)
    deleteMemoryEntry(store, id)
    saveMemoryStore(workspaceRootPath, store)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_EXTRACT, async (_ctx: unknown, sessionId: string) => {
    const agent = sessionManager.getSessionAgent?.(sessionId)
    if (!agent?.extractSessionMemories) {
      throw new Error('Agent not initialized for this session')
    }
    return agent.extractSessionMemories()
  })
}
