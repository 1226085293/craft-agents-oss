import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  loadMemoryStore,
  saveMemoryStore,
  addMemoryEntry,
  updateMemoryEntry,
  softDeleteMemoryEntry,
  restoreMemoryEntry,
  clearMemoryTrash,
  getMemoryStats,
} from '@craft-agent/shared/memory/store'
import { consolidateSessionMemories, MemoryConsolidationScheduler } from '@craft-agent/shared/memory'
import { listSessions as listStoredSessions } from '@craft-agent/shared/sessions'
import { addSessionMemory, deleteSessionMemory, updateSessionMemory, loadSessionMemoryStore, saveSessionMemoryStore } from '@craft-agent/shared/memory'
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
  RPC_CHANNELS.memory.MEMORY_DELETE_MANY,
  RPC_CHANNELS.memory.MEMORY_EXTRACT,
  RPC_CHANNELS.memory.MEMORY_UPDATE,
  RPC_CHANNELS.memory.MEMORY_GET_TRASH,
  RPC_CHANNELS.memory.MEMORY_RESTORE,
  RPC_CHANNELS.memory.MEMORY_CLEAR_TRASH,
  RPC_CHANNELS.memory.MEMORY_SESSION_GET,
  RPC_CHANNELS.memory.MEMORY_SESSION_ADD,
  RPC_CHANNELS.memory.MEMORY_SESSION_UPDATE,
  RPC_CHANNELS.memory.MEMORY_SESSION_DELETE,
  RPC_CHANNELS.memory.MEMORY_CONSOLIDATE,
  RPC_CHANNELS.memory.MEMORY_SCHEDULE_GET,
  RPC_CHANNELS.memory.MEMORY_SCHEDULE_SET,
] as const

/**
 * Memory is workspace-scoped: the store must live at `<workspaceRoot>/memory.json`
 * so the agent (BaseAgent) and this handler read/write the same file.
 */
export function registerMemoryHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  const scheduled = new Map<string, { signature: string; scheduler: MemoryConsolidationScheduler }>()

  const runWorkspaceConsolidation = async (workspaceRootPath: string): Promise<{ promoted: number; trashed: number; sessionsProcessed: number }> => {
    const workspace = sessionManager.getWorkspaces().find(item => item.rootPath === workspaceRootPath)
    if (!workspace) return { promoted: 0, trashed: 0, sessionsProcessed: 0 }
    const sessions = listStoredSessions(workspaceRootPath)
    const stores = sessions.map(session => loadSessionMemoryStore(workspaceRootPath, session.id))
      .filter(store => store.entries.some(entry => !(store.consolidatedEntryIds ?? []).includes(entry.id)))
    if (!stores.length) return { promoted: 0, trashed: 0, sessionsProcessed: 0 }
    const agent = sessions.map(session => sessionManager.getSessionAgent?.(session.id)).find(candidate => candidate?.runMiniCompletion)
    if (!agent?.runMiniCompletion) throw new Error('No active session agent is available for memory consolidation')
    const globalStore = loadMemoryStore(workspaceRootPath)
    const result = await consolidateSessionMemories(globalStore, stores, async prompt => {
      const response = await agent.runMiniCompletion!(prompt)
      if (!response) throw new Error('Memory consolidation returned an empty response')
      return response
    })
    saveMemoryStore(workspaceRootPath, globalStore)
    for (const store of stores) saveSessionMemoryStore(workspaceRootPath, store)
    return { ...result, sessionsProcessed: stores.length }
  }

  const scheduleTimer = setInterval(() => {
    for (const workspace of sessionManager.getWorkspaces()) {
      const schedule = loadMemoryStore(workspace.rootPath).consolidationSchedule ?? { enabled: false, cron: '0 3 * * *' }
      const signature = JSON.stringify(schedule)
      const current = scheduled.get(workspace.rootPath)
      if (current?.signature !== signature) {
        current?.scheduler.stop()
        if (!schedule.enabled) {
          scheduled.delete(workspace.rootPath)
          continue
        }
        scheduled.set(workspace.rootPath, {
          signature,
          scheduler: new MemoryConsolidationScheduler(schedule, () => runWorkspaceConsolidation(workspace.rootPath)),
        })
      }
      void scheduled.get(workspace.rootPath)?.scheduler.tick().catch(error => console.error('[Memory] Scheduled consolidation failed:', error))
    }
    for (const [rootPath, current] of scheduled) {
      if (!sessionManager.getWorkspaces().some(workspace => workspace.rootPath === rootPath)) {
        current.scheduler.stop()
        scheduled.delete(rootPath)
      }
    }
  }, 30_000)
  scheduleTimer.unref?.()

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
    const success = softDeleteMemoryEntry(store, id)
    saveMemoryStore(workspaceRootPath, store)
    return { success }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE_MANY, async (_ctx: unknown, workspaceRootPath: string, ids: string[]) => {
    if (!workspaceRootPath || !Array.isArray(ids)) throw new Error('workspaceRootPath and ids are required')
    const store = loadMemoryStore(workspaceRootPath)
    const deleted = ids.filter(id => softDeleteMemoryEntry(store, id))
    saveMemoryStore(workspaceRootPath, store)
    return { deleted: deleted.length }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_UPDATE, async (_ctx: unknown, workspaceRootPath: string, id: string, updates: { content?: string; type?: string; tags?: string[] }) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const store = loadMemoryStore(workspaceRootPath)
    const entry = updateMemoryEntry(store, id, { ...updates, type: updates.type as any })
    saveMemoryStore(workspaceRootPath, store)
    return { success: !!entry }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_TRASH, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return loadMemoryStore(workspaceRootPath).trash ?? []
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_RESTORE, async (_ctx: unknown, workspaceRootPath: string, id: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const store = loadMemoryStore(workspaceRootPath)
    const success = restoreMemoryEntry(store, id)
    if (success) saveMemoryStore(workspaceRootPath, store)
    return { success }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CLEAR_TRASH, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const store = loadMemoryStore(workspaceRootPath)
    const count = clearMemoryTrash(store)
    saveMemoryStore(workspaceRootPath, store)
    return { count }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SESSION_GET, async (_ctx: unknown, workspaceRootPath: string, sessionId: string) => {
    if (!workspaceRootPath || !sessionId) throw new Error('workspaceRootPath and sessionId are required')
    return loadSessionMemoryStore(workspaceRootPath, sessionId)
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SESSION_ADD, async (_ctx: unknown, workspaceRootPath: string, sessionId: string, data: MemoryAddPayload) => {
    if (!workspaceRootPath || !sessionId || !data?.content?.trim()) throw new Error('workspaceRootPath, sessionId, and content are required')
    const store = loadSessionMemoryStore(workspaceRootPath, sessionId)
    const entry = addSessionMemory(store, data.content, data.type as any, data.tags ?? [], data.confidence ?? 1)
    saveSessionMemoryStore(workspaceRootPath, store)
    return { id: entry.id }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SESSION_UPDATE, async (_ctx: unknown, workspaceRootPath: string, sessionId: string, id: string, updates: { content?: string; type?: string; tags?: string[]; confidence?: number }) => {
    if (!workspaceRootPath || !sessionId || !id) throw new Error('workspaceRootPath, sessionId, and id are required')
    const store = loadSessionMemoryStore(workspaceRootPath, sessionId)
    const success = !!updateSessionMemory(store, id, { ...updates, type: updates.type as any })
    if (success) saveSessionMemoryStore(workspaceRootPath, store)
    return { success }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SESSION_DELETE, async (_ctx: unknown, workspaceRootPath: string, sessionId: string, id: string) => {
    if (!workspaceRootPath || !sessionId || !id) throw new Error('workspaceRootPath, sessionId, and id are required')
    const store = loadSessionMemoryStore(workspaceRootPath, sessionId)
    const success = deleteSessionMemory(store, id)
    if (success) saveSessionMemoryStore(workspaceRootPath, store)
    return { success }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SCHEDULE_GET, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return loadMemoryStore(workspaceRootPath).consolidationSchedule ?? { enabled: false, cron: '0 3 * * *' }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SCHEDULE_SET, async (_ctx: unknown, workspaceRootPath: string, schedule: { enabled: boolean; cron: string; timezone?: string }) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    if (typeof schedule?.enabled !== 'boolean') throw new Error('enabled is required')
    const { Cron } = await import('croner')
    try { new Cron(schedule.cron, { timezone: schedule.timezone }) } catch { throw new Error('Invalid consolidation cron expression') }
    const store = loadMemoryStore(workspaceRootPath)
    store.consolidationSchedule = { enabled: schedule.enabled, cron: schedule.cron, ...(schedule.timezone ? { timezone: schedule.timezone } : {}) }
    saveMemoryStore(workspaceRootPath, store)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CONSOLIDATE, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const workspace = sessionManager.getWorkspaces().find(item => item.rootPath === workspaceRootPath)
    if (!workspace) throw new Error('Workspace not found')
    const sessions = listStoredSessions(workspaceRootPath)
    const stores = sessions.map(session => loadSessionMemoryStore(workspaceRootPath, session.id))
      .filter(store => store.entries.some(entry => !(store.consolidatedEntryIds ?? []).includes(entry.id)))
    if (!stores.length) return { promoted: 0, trashed: 0, sessionsProcessed: 0 }
    return runWorkspaceConsolidation(workspaceRootPath)
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_EXTRACT, async (_ctx: unknown, sessionId: string) => {
    const agent = sessionManager.getSessionAgent?.(sessionId)
    if (!agent?.extractSessionMemories) {
      throw new Error('Agent not initialized for this session')
    }
    return agent.extractSessionMemories()
  })
}
