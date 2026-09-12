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

export function registerMemoryHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_STATS, async (_ctx: unknown, workspaceRootPath: string) => {
    const store = loadMemoryStore(workspaceRootPath)
    const stats = getMemoryStats(store)
    return { entries: store.entries, stats }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_ADD, async (_ctx: unknown, workspaceRootPath: string, data: { content: string; type: string; tags?: string[]; confidence?: number }) => {
    const store = loadMemoryStore(workspaceRootPath)
    const entry = addMemoryEntry(store, data.content, data.type as any, 'manual', data.tags || [], data.confidence ?? 1.0)
    saveMemoryStore(workspaceRootPath, store)
    return { id: entry.id }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE, async (_ctx: unknown, workspaceRootPath: string, id: string) => {
    const store = loadMemoryStore(workspaceRootPath)
    deleteMemoryEntry(store, id)
    saveMemoryStore(workspaceRootPath, store)
    return null
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_EXTRACT, async (_ctx: unknown, sessionId: string) => {
    // Access the managed session to get the agent
    const managed = (sessionManager as any)._managedSessions?.get(sessionId)
    if (!managed) throw new Error('Session not found')
    const agent = managed.agent
    if (!agent) throw new Error('Agent not initialized')
    // @ts-ignore - extractSessionMemories is a protected method on BaseAgent
    const result = await agent.extractSessionMemories()
    return result
  })
}
