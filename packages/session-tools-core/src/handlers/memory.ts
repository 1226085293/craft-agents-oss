import type { SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const error = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function memoryPath(ctx: SessionToolContext, scope: 'session' | 'global'): string {
  return scope === 'global'
    ? `${ctx.workspacePath}/memory.json`
    : `${ctx.workspacePath}/sessions/${ctx.sessionId}/memory.json`
}

export async function handleAddMemory(ctx: SessionToolContext, args: { action: 'add' | 'update' | 'delete'; scope: 'session' | 'global'; id?: string; content?: string; type?: string; tags?: string[] }): Promise<ToolResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(ctx.sessionId)) return error('Invalid session ID')
  if (args.action === 'add' && !args.content?.trim()) return error('content is required')
  if (args.action !== 'add' && !args.id) return error('id is required')
  try {
    const path = memoryPath(ctx, args.scope)
    if (!path.startsWith(`${ctx.workspacePath}/`) && !path.startsWith(`${ctx.workspacePath}\\`)) return error('Invalid memory store path')
    const store = ctx.fs.exists(path)
      ? JSON.parse(ctx.fs.readFile(path)) as Record<string, any>
      : args.scope === 'global'
        ? { version: 1, entries: [], trash: [], extractionHistory: [], totalInjectionTokens: 0 }
        : { version: 1, sessionId: ctx.sessionId, entries: [], consolidatedEntryIds: [], extractionHistory: [] }
    if (args.scope === 'session' && store.sessionId !== ctx.sessionId) return error('Session memory store identity mismatch')
    const action = args.action
    if (action === 'add') {
      const entry = {
        id: crypto.randomUUID(), type: args.type ?? 'fact', content: args.content!.trim(), sourceSessionId: args.scope === 'global' ? 'manual' : ctx.sessionId,
        tags: args.tags ?? [], confidence: 0.9, createdAt: new Date().toISOString(), injectedCount: 0,
      }
      store.entries.push(entry)
      mkdirSync(dirname(path), { recursive: true })
      ctx.fs.writeFile(path, JSON.stringify(store, null, 2))
      return ok(`Added ${args.scope} memory ${entry.id}.`)
    }
    const index = store.entries.findIndex((entry: { id: string; sourceSessionId?: string }) => entry.id === args.id && (args.scope === 'global' || entry.sourceSessionId === ctx.sessionId))
    if (index < 0) return error('Memory entry not found.')
    if (action === 'delete') {
      const [entry] = store.entries.splice(index, 1)
      if (args.scope === 'global' && entry) {
        store.trash ??= []
        store.trash.push({ entry, deletedAt: new Date().toISOString(), reason: 'Deleted by agent memory tool' })
      }
    } else {
      const entry = store.entries[index]
      if (entry) {
        if (args.content !== undefined) entry.content = args.content.trim()
        if (args.type !== undefined) entry.type = args.type
        if (args.tags !== undefined) entry.tags = args.tags
        entry.updatedAt = new Date().toISOString()
        if (args.scope === 'session') store.consolidatedEntryIds = (store.consolidatedEntryIds ?? []).filter((entryId: string) => entryId !== entry.id)
      }
    }
    mkdirSync(dirname(path), { recursive: true })
    ctx.fs.writeFile(path, JSON.stringify(store, null, 2))
    return ok(`${args.scope} memory ${action} completed.`)
  } catch (cause) {
    return error(`Failed to add memory: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export async function handleQueryMemories(ctx: SessionToolContext, args: { query: string }): Promise<ToolResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(ctx.sessionId)) return error('Invalid session ID')
  try {
    const stores = [memoryPath(ctx, 'global'), memoryPath(ctx, 'session')]
      .filter(path => ctx.fs.exists(path))
      .map(path => JSON.parse(ctx.fs.readFile(path)) as { sessionId?: string; entries?: Array<{ type: string; content: string }> })
    const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const matches = stores.flatMap(store => (store.entries ?? [])
      .filter(entry => !store.sessionId || store.sessionId === ctx.sessionId)
      .filter(entry => terms.some(term => entry.content.toLocaleLowerCase().includes(term)))
      .map(entry => `[${entry.type}] ${entry.content}`))
    return ok(matches.length ? matches.join('\n') : 'No relevant memories found.')
  } catch (cause) {
    return error(`Failed to query memories: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
