import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import {
  loadMemoryStore,
  saveMemoryStore,
  addMemoryEntry,
  updateMemoryEntry,
  softDeleteMemoryEntry,
  restoreMemoryEntry,
  clearMemoryTrash,
  permanentlyDeleteTrashEntries,
  getMemoryStats,
} from '@craft-agent/shared/memory/store'
import { consolidateSessionMemories, MemoryConsolidationScheduler, withMemoryWriteLock, type MemoryStore } from '@craft-agent/shared/memory'
import { resolveTitleLanguageName, getDefaultLlmConnection, getLlmConnection } from '@craft-agent/shared/config'
import { listSessions as listStoredSessions } from '@craft-agent/shared/sessions'
import { addSessionMemory, deleteSessionMemory, updateSessionMemory, loadSessionMemoryStore, saveSessionMemoryStore, normalizeTag } from '@craft-agent/shared/memory'
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
  RPC_CHANNELS.memory.MEMORY_CONSOLIDATE_CANCEL,
  RPC_CHANNELS.memory.MEMORY_CONSOLIDATE_STATE_GET,
  RPC_CHANNELS.memory.MEMORY_TRASH_DELETE_MANY,
  RPC_CHANNELS.memory.MEMORY_SCHEDULE_GET,
  RPC_CHANNELS.memory.MEMORY_SCHEDULE_SET,
  RPC_CHANNELS.memory.MEMORY_GET_BLOCKED,
  RPC_CHANNELS.memory.MEMORY_LIST_BACKUPS,
  RPC_CHANNELS.memory.MEMORY_RESTORE_BACKUP,
  RPC_CHANNELS.memory.MEMORY_GET_VOCABULARY,
  RPC_CHANNELS.memory.MEMORY_SET_VOCABULARY,
  RPC_CHANNELS.memory.MEMORY_DELETE_BACKUP,
] as const


/**
 * Load → mutate → save under the process write lock (§1.4). UI 操作与 cron 整理
 * 共用同一 mutex，避免交错写坏 memory.json。
 */
async function mutateStore<T>(workspaceRootPath: string, mutate: (store: MemoryStore) => T | Promise<T>): Promise<T> {
  return withMemoryWriteLock(async () => {
    const store = loadMemoryStore(workspaceRootPath)
    const result = await mutate(store)
    saveMemoryStore(workspaceRootPath, store)
    return result
  })
}

/**
 * Memory is workspace-scoped: the store must live at `<workspaceRoot>/memory.json`
 * so the agent (BaseAgent) and this handler read/write the same file.
 */
export function registerMemoryHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  const scheduled = new Map<string, { signature: string; scheduler: MemoryConsolidationScheduler }>()
  // Cooperative cancellation flag per workspace, set by MEMORY_CONSOLIDATE_CANCEL
  // and checked between LLM batches by the running consolidation.
  const consolidationCancelled = new Map<string, boolean>()
  // Live state of the consolidation run per workspace. Survives renderer
  // remounts (navigating away/back) so the UI can restore the "organizing"
  // indicator and progress for a run that is still in flight.
  const consolidationRunState = new Map<string, { active: boolean; done: number; total: number; cancelling?: boolean }>()

  const runWorkspaceConsolidation = async (
    workspaceRootPath: string,
    onSessionConsolidated?: (progress: { done: number; total: number; sessionId: string; promoted: number; trashed: number; message?: string }) => void,
  ): Promise<{ promoted: number; trashed: number; sessionsProcessed: number }> => {
    const workspace = sessionManager.getWorkspaces().find(item => item.rootPath === workspaceRootPath)
    if (!workspace) return { promoted: 0, trashed: 0, sessionsProcessed: 0 }
    const sessions = listStoredSessions(workspaceRootPath)
    const stores = sessions.map(session => loadSessionMemoryStore(workspaceRootPath, session.id))
      .filter(store => store.entries.some(entry => !(store.consolidatedEntryIds ?? []).includes(entry.id)))
    if (!stores.length) return { promoted: 0, trashed: 0, sessionsProcessed: 0 }
    // Consolidation runs on the app's DEFAULT LLM connection + default model
    // (Settings → AI Connections), not on a session's keyword-matched mini
    // model ("flash"/last-in-list): mini models are the ones that typically
    // hit rate limits, and consolidation prompts need a full model.
    const defaultSlug = getDefaultLlmConnection()
    const defaultModel = defaultSlug ? getLlmConnection(defaultSlug)?.defaultModel : undefined
    const defaultAgentSession = defaultModel
      ? sessions.find(session => session.llmConnection === defaultSlug
        && sessionManager.getSessionAgent?.(session.id)?.queryLlm)
      : undefined
    const defaultAgent = defaultAgentSession ? sessionManager.getSessionAgent?.(defaultAgentSession.id) : undefined
    const agent = defaultAgent
      ?? sessions.map(session => sessionManager.getSessionAgent?.(session.id)).find(candidate => candidate?.runMiniCompletion)
    if (!agent || (!agent.queryLlm && !agent.runMiniCompletion)) {
      throw new Error('No active session agent is available for memory consolidation')
    }
    const globalStore = loadMemoryStore(workspaceRootPath)
    // Promoted memories follow the app's UI language setting.
    const language = resolveTitleLanguageName()
    // Reset the cancel flag at the start of every run (manual or scheduled).
    consolidationCancelled.set(workspaceRootPath, false)
    // Publish the run as active so a remounted panel can restore its state.
    consolidationRunState.set(workspaceRootPath, { active: true, done: 0, total: stores.length })
    let done = 0
    try {
    const result = await consolidateSessionMemories(globalStore, stores, async prompt => {
      // Cooperative cancel: checked before each LLM batch. Throwing aborts the
      // run between batches, so the in-flight session is never marked (and the
      // completed sessions stay persisted from their onSessionConsolidated).
      if (consolidationCancelled.get(workspaceRootPath)) {
        consolidationCancelled.set(workspaceRootPath, false)
        throw new Error('Memory consolidation cancelled')
      }
      if (defaultAgent && defaultModel) {
        // Default connection + default model — exactly what the user sees in
        // Settings (e.g. the "auto" routing model), bypassing the mini model.
        const completion = await defaultAgent.queryLlm!({ model: defaultModel, prompt })
        const text = completion?.text?.trim()
        if (!text) throw new Error('Memory consolidation returned an empty response')
        return text
      }
      const response = await agent.runMiniCompletion!(prompt)
      if (!response) throw new Error('Memory consolidation returned an empty response')
      return response
    }, {
      language,
      // Write-time adjudication gate needs the mini-model completion (§5.1).
      runMiniCompletion: agent.runMiniCompletion ? agent.runMiniCompletion.bind(agent) : undefined,
      // Check the cooperative-cancel flag between LLM calls and backoff
      // sleeps so "Cancel" settles quickly even while retrying.
      isCancelled: () => consolidationCancelled.get(workspaceRootPath) === true,
      onRetry: ({ attempt, message }) => {
        onSessionConsolidated?.({
          done,
          total: stores.length,
          sessionId: '',
          promoted: 0,
          trashed: 0,
          message: `retrying: ${message} (attempt ${attempt})`,
        })
      },
      onSessionConsolidated: (session, sessionResult) => {
        // Persist ONLY after this session fully succeeded (across all of its
        // batches). Session stores are saved one-by-one, so a restart or
        // model failure mid-run never marks a session as organized without
        // its work having completed — completed sessions keep their markers.
        // Writes go under the shared memory write lock (§1.4 UI/cron 共用).
        void withMemoryWriteLock(() => {
          saveMemoryStore(workspaceRootPath, globalStore)
          saveSessionMemoryStore(workspaceRootPath, session)
        })
        done += 1
        const runState = consolidationRunState.get(workspaceRootPath)
        if (runState) runState.done = done
        onSessionConsolidated?.({ done, total: stores.length, sessionId: session.sessionId, ...sessionResult })
      },
    })
    return { ...result, sessionsProcessed: stores.length }
    } finally {
      const runState = consolidationRunState.get(workspaceRootPath)
      // Only clear the active flag if this very run still owns the state (a
      // newer run may have replaced it after a quick re-trigger).
      if (runState) runState.active = false
    }
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

    return mutateStore(workspaceRootPath, (store) => {
      const entry = addMemoryEntry(
        store,
        data.content.trim(),
        data.type as any,
        'manual',
        data.tags || [],
        data.confidence ?? 1.0,
      )
      return { id: entry.id }
    })
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE, async (_ctx: unknown, workspaceRootPath: string, id: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return mutateStore(workspaceRootPath, (store) => ({ success: softDeleteMemoryEntry(store, id) }))
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE_MANY, async (_ctx: unknown, workspaceRootPath: string, ids: string[]) => {
    if (!workspaceRootPath || !Array.isArray(ids)) throw new Error('workspaceRootPath and ids are required')
    return mutateStore(workspaceRootPath, (store) => ({ deleted: ids.filter(id => softDeleteMemoryEntry(store, id)).length }))
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_UPDATE, async (_ctx: unknown, workspaceRootPath: string, id: string, updates: { content?: string; type?: string; tags?: string[] }) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return mutateStore(workspaceRootPath, (store) => ({ success: !!updateMemoryEntry(store, id, { ...updates, type: updates.type as any }) }))
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_TRASH, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return loadMemoryStore(workspaceRootPath).trash ?? []
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_RESTORE, async (_ctx: unknown, workspaceRootPath: string, id: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return mutateStore(workspaceRootPath, (store) => ({ success: restoreMemoryEntry(store, id) }))
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CLEAR_TRASH, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return mutateStore(workspaceRootPath, (store) => ({ count: clearMemoryTrash(store) }))
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_TRASH_DELETE_MANY, async (_ctx: unknown, workspaceRootPath: string, ids: string[]) => {
    if (!workspaceRootPath || !Array.isArray(ids)) throw new Error('workspaceRootPath and ids are required')
    return mutateStore(workspaceRootPath, (store) => ({ deleted: permanentlyDeleteTrashEntries(store, ids) }))
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
    return mutateStore(workspaceRootPath, (store) => {
      store.consolidationSchedule = { enabled: schedule.enabled, cron: schedule.cron, ...(schedule.timezone ? { timezone: schedule.timezone } : {}) }
      return { success: true }
    })
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CONSOLIDATE_CANCEL, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    consolidationCancelled.set(workspaceRootPath, true)
    // Persist the cancel-in-progress flag with the run state so a panel
    // remount (page switch) restores the "cancelling…" UI while the
    // cooperative cancel finishes on the server.
    const runState = consolidationRunState.get(workspaceRootPath)
    if (runState?.active) runState.cancelling = true
    return { success: true }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CONSOLIDATE_STATE_GET, async (_ctx: unknown, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    return consolidationRunState.get(workspaceRootPath) ?? { active: false, done: 0, total: 0 }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_CONSOLIDATE, async (ctx, workspaceRootPath: string) => {
    if (!workspaceRootPath) throw new Error('workspaceRootPath is required')
    const workspace = sessionManager.getWorkspaces().find(item => item.rootPath === workspaceRootPath)
    if (!workspace) throw new Error('Workspace not found')
    const sessions = listStoredSessions(workspaceRootPath)
    const stores = sessions.map(session => loadSessionMemoryStore(workspaceRootPath, session.id))
      .filter(store => store.entries.some(entry => !(store.consolidatedEntryIds ?? []).includes(entry.id)))
    const total = stores.length
    const target = { to: 'client', clientId: ctx.clientId } as const
    const push = (payload: Record<string, unknown>) => server.push(RPC_CHANNELS.memory.MEMORY_CONSOLIDATE_PROGRESS, target, payload)

    // A consolidation run spans many LLM batches and can take minutes, far
    // beyond the RPC timeout. The invoke returns immediately (fire-and-forget)
    // and every state transition flows back through the progress channel:
    // phase 'running' (with done/total) → 'done' | 'cancelled' | 'error'.
    if (total === 0) {
      push({ phase: 'done', done: 0, total: 0, sessionId: '', promoted: 0, trashed: 0 })
      return { started: false, total: 0 }
    }
    push({ phase: 'running', done: 0, total, sessionId: '', promoted: 0, trashed: 0 })
    void (async () => {
      try {
        const result = await runWorkspaceConsolidation(workspaceRootPath, progress => {
          push({ phase: 'running', ...progress, cancelling: consolidationRunState.get(workspaceRootPath)?.cancelling })
        })
        push({ phase: 'done', done: result.sessionsProcessed, total, sessionId: '', promoted: result.promoted, trashed: result.trashed })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.toLowerCase().includes('cancel')) {
          push({ phase: 'cancelled', done: 0, total, sessionId: '', promoted: 0, trashed: 0 })
        } else {
          push({ phase: 'error', done: 0, total, sessionId: '', promoted: 0, trashed: 0, message })
        }
      }
    })()
    return { started: true, total }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_EXTRACT, async (_ctx: unknown, sessionId: string) => {
    const agent = sessionManager.getSessionAgent?.(sessionId)
    if (!agent?.extractSessionMemories) {
      throw new Error('Agent not initialized for this session')
    }
    return agent.extractSessionMemories()
  })

  // ---- audit & retention UI (§5.4) -------------------------------------

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_BLOCKED, async (_ctx: unknown, workspaceRootPath: string) => {
    const store = loadMemoryStore(workspaceRootPath)
    return [...(store.blocked ?? [])].reverse()
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_LIST_BACKUPS, async (_ctx: unknown, workspaceRootPath: string) => {
    const filePath = join(workspaceRootPath, 'memory.json')
    const dir = dirname(filePath)
    const base = basename(filePath, '.json')
    const backups: Array<{ index: number, size: number, updatedAt: string }> = []
    try {
      for (let i = 0; i < 5; i++) {
        const p = join(dir, `${base}.backup.${i}.json`)
        if (!existsSync(p)) continue
        const st = statSync(p)
        backups.push({ index: i, size: st.size, updatedAt: st.mtime.toISOString() })
      }
    } catch { /* listing is best-effort */ }
    const current = existsSync(filePath) ? statSync(filePath).size : 0
    return { current, backups }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_RESTORE_BACKUP, async (_ctx: unknown, workspaceRootPath: string, index: number) => {
    if (typeof index !== 'number' || index < 0 || index >= 5) return { ok: false, reason: 'invalid backup index' }
    const filePath = join(workspaceRootPath, 'memory.json')
    const backupPath = join(dirname(filePath), `${basename(filePath, '.json')}.backup.${index}.json`)
    if (!existsSync(backupPath)) return { ok: false, reason: 'backup not found' }
    try {
      const tmpPath = filePath + '.restore.tmp'
      copyFileSync(backupPath, tmpPath)
      const { renameSync } = await import('node:fs')
      renameSync(tmpPath, filePath)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_DELETE_BACKUP, async (_ctx: unknown, workspaceRootPath: string, index: number) => {
    if (typeof index !== 'number' || index < 0 || index >= 5) return { ok: false, reason: 'invalid backup index' }
    const filePath = join(workspaceRootPath, 'memory.json')
    const backupPath = join(dirname(filePath), `${basename(filePath, '.json')}.backup.${index}.json`)
    if (!existsSync(backupPath)) return { ok: false, reason: 'backup not found' }
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(backupPath)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_GET_VOCABULARY, async (_ctx: unknown, workspaceRootPath: string) => {
    const store = loadMemoryStore(workspaceRootPath)
    return { tagVocabulary: store.tagVocabulary ?? [], priorityTags: store.priorityTags ?? [] }
  })

  server.handle(RPC_CHANNELS.memory.MEMORY_SET_VOCABULARY, async (_ctx: unknown, workspaceRootPath: string, payload: { tagVocabulary?: string[]; priorityTags?: string[] }) => {
    return mutateStore(workspaceRootPath, (store) => {
      if (Array.isArray(payload.tagVocabulary)) {
        store.tagVocabulary = payload.tagVocabulary
          .map((t: string) => String(t).trim().toLowerCase())
          .filter((t: string) => t.length > 0)
      }
      if (Array.isArray(payload.priorityTags)) {
        const vocab = new Set(store.tagVocabulary ?? [])
        store.priorityTags = payload.priorityTags
          .map((t: string) => String(t).trim().toLowerCase())
          .filter((t: string) => t.length > 0 && vocab.has(t)) // controlled subset of the vocabulary
      }
      return { ok: true, tagVocabulary: store.tagVocabulary ?? [], priorityTags: store.priorityTags ?? [] }
    })
  })
}
