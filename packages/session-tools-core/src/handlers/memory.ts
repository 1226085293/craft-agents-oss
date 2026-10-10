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

/**
 * Character-bigram Jaccard similarity (0..1), no dependencies.
 * Used for server-side near-duplicate detection before writes.
 */
function entrySimilarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>()
    const t = s.replace(/\s+/g, '').toLowerCase()
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/** Similarity above this → treat as a duplicate of an existing entry. */
const MEMORY_DEDUP_SIMILARITY = 0.8

/**
 * UPDATE an existing one (same subject, same slot, newer value) rather than
 * be added as a new entry. Surface similarity alone cannot tell "名字从 A
 * 改成 B" apart from genuinely new facts — that judgement requires a model.
 * Storage path is off the critical latency path, so one mini-LLM call is
 * acceptable. Returns the existing entry id, or null (also on timeout /
 * missing callback / malformed reply — always fail open).
 */
async function detectUpdateTarget(
  ctx: SessionToolContext,
  content: string,
  existing: Array<{ id: string; content: string }>,
): Promise<string | null> {
  const runMini = ctx.callbacks?.runMiniCompletion
  if (!runMini || existing.length === 0) return null
  // Candidate prefilter: keep the most surface-similar entries so the prompt
  // stays small; a same-slot update shares at least some wording in practice.
  const candidates = existing
    .map(e => ({ e, sim: entrySimilarity(e.content, content) }))
    .filter(c => c.sim >= 0.15)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5)
  if (candidates.length === 0) return null
  try {
    const prompt = [
      'You are a memory update judge. A new memory is being stored. One of the',
      'existing memories may be the SAME fact/preference slot with an OLDER value',
      '(same subject, same attribute, newer value — e.g. a name that changed).',
      'If so, the new memory should UPDATE that existing entry instead of being',
      'added as a duplicate.',
      '',
      'Existing memories:',
      ...candidates.map(c => `- [${c.e.id}] ${c.e.content}`),
      '',
      `New memory: ${content}`,
      '',
      'Reply with ONLY the id of the existing memory that the new one should',
      'update, or NONE if the new memory is genuinely new information.',
    ].join('\n')
    const raw = await Promise.race([
      runMini(prompt),
      new Promise<string | null>(resolve => setTimeout(() => resolve(null), 10_000)),
    ])
    if (!raw) return null
    const id = raw.trim()
    if (id.toUpperCase() === 'NONE') return null
    // Accept an exact id or a stable prefix (models sometimes truncate UUIDs).
    const match = candidates.find(c => c.e.id === id || (id.length >= 12 && c.e.id.startsWith(id)))
    return match ? match.e.id : null
  } catch {
    return null
  }
}

/**
 * Semantic query expansion: derive synonym/paraphrase search terms from the
 * user's query via the default-model mini completion (thinking disabled,
 * timeout-guarded). Returns [] on failure — callers fall back to the raw
 * surface matches. Using the default session model, not the main agent model.
 */
async function expandQueryTerms(
  ctx: SessionToolContext,
  query: string,
): Promise<string[]> {
  const runMini = ctx.callbacks?.runMiniCompletion
  if (!runMini) return []
  try {
    const prompt = [
      'You are a memory search assistant. Given a user query, produce 4-6 SHORT synonym or paraphrase search terms',
      '(single words or short phrases, no explanations) that could appear in stored notes about the same topic.',
      'Cover different wording/angles of the same intent. Respond with a JSON array of strings only:',
      '["term1","term2"]',
      '',
      `User query: ${query}`,
    ].join('\n')
    const raw = await Promise.race([
      runMini(prompt),
      new Promise<string | null>(resolve => setTimeout(() => resolve(null), 10_000)),
    ])
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 1)
      .map(t => t.trim().toLocaleLowerCase())
      .slice(0, 8)
  } catch {
    return []
  }
}

/**
 * Write-side retrieval keyword generation (scheme C): when a memory is
 * stored, ask the mini model what phrasing a user might LATER use to ask
 * about it ("名字", "称呼", "怎么叫你"…). Matching the read path against
 * content ∪ these keywords gives semantic reach with pure string ops — no
 * LLM call on the read path, keeping injection at zero added latency.
 * Failure/timeout degrades to [] (keyword-less entries behave as before).
 */
async function generateRetrievalKeywords(
  ctx: SessionToolContext,
  content: string,
): Promise<string[]> {
  const runMini = ctx.callbacks?.runMiniCompletion
  if (!runMini) return []
  try {
    const prompt = [
      'You are a memory recall assistant. Below is a stored memory. List 4-6 SHORT',
      'keywords or questions a user might later use to ASK about this exact fact',
      '(synonyms, paraphrases, likely phrasings). Plain terms only, no explanations,',
      'Chinese + English where applicable. Respond with a JSON array of strings only:',
      '["term1","term2"]',
      '',
      `Memory: ${content}`,
    ].join('\n')
    const raw = await Promise.race([
      runMini(prompt),
      new Promise<string | null>(resolve => setTimeout(() => resolve(null), 10_000)),
    ])
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 1)
      .map(t => t.trim().toLocaleLowerCase())
      .slice(0, 10)
  } catch {
    return []
  }
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
        ? { version: 1, schemaVersion: 3, entries: [], trash: [], extractionHistory: [], totalInjectionTokens: 0 }
        : { version: 1, sessionId: ctx.sessionId, entries: [], consolidatedEntryIds: [], extractionHistory: [] }
    if (args.scope === 'session' && store.sessionId !== ctx.sessionId) return error('Session memory store identity mismatch')
    const action = args.action
    if (action === 'add') {
      const content = args.content!.trim()
      // Server-side near-duplicate guard: measure similarity against ALL
      // existing entries in this store BEFORE writing. A hit returns guidance
      // (with the existing id) so the model naturally switches to update —
      // no dependence on the model having read the description.
      const existing = (store.entries ?? []) as Array<{ id: string; content: string }>
      const dup = existing.find(e => entrySimilarity(e.content, content) >= MEMORY_DEDUP_SIMILARITY)
      if (dup) {
        return ok(`Similar memory already exists [${dup.id}]: ${dup.content.slice(0, 120) === dup.content ? dup.content : dup.content.slice(0, 120) + '…'}. Use action="update" with id "${dup.id}" to modify it instead of adding a duplicate.`)
      }
      // Second tier: same-slot-with-newer-value detection. Surface similarity
      // cannot recognize "the name changed" — ask the mini model (failure
      // falls back to plain add, never blocks).
      const updateTarget = await detectUpdateTarget(ctx, content, existing)
      if (updateTarget) {
        const target = existing.find(e => e.id === updateTarget)
        return ok(`A memory for this already exists [${updateTarget}]: ${target ? target.content.slice(0, 120) : ''}${target && target.content.length > 120 ? '…' : ''}. Use action="update" with id "${updateTarget}" to set the new value instead of adding a duplicate.`)
      }
      const entry: {
        id: string; type: string; content: string; sourceSessionId: string;
        tags: string[]; confidence: number; createdAt: string; injectedCount: number;
        retrievalKeywords?: string[];
      } = {
        id: crypto.randomUUID(), type: args.type ?? 'factual', content, sourceSessionId: args.scope === 'global' ? 'manual' : ctx.sessionId,
        tags: args.tags ?? [], confidence: 0.9, createdAt: new Date().toISOString(), injectedCount: 0,
      }
      // Write-side semantic indexing: precompute likely question phrasings so
      // the read path can hit this entry with pure string matching. Same
      // stored-path LLM budget as dedup; failure degrades to [] silently.
      entry.retrievalKeywords = await generateRetrievalKeywords(ctx, content)
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

export async function handleQueryMemories(ctx: SessionToolContext, args: { query: string; type?: 'factual' | 'behavioral' | 'reminder'; tags?: string[]; limit?: number }): Promise<ToolResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(ctx.sessionId)) return error('Invalid session ID')
  try {
    const stores = [memoryPath(ctx, 'global'), memoryPath(ctx, 'session')]
      .filter(path => ctx.fs.exists(path))
      .map(path => JSON.parse(ctx.fs.readFile(path)) as { sessionId?: string; entries?: Array<{ type: string; content: string; tags?: string[] }> })
    // Fold legacy 5-class types into the three-class space so old session
    // stores (pre- extractions) stay searchable and filterable.
    const fold = (type: string): string => {
      if (type === 'fact' || type === 'context') return 'factual'
      if (type === 'preference' || type === 'workflow') return 'behavioral'
      return type === 'reminder' ? 'reminder' : type
    }
    const search = (terms: string[]): Array<{ type: string; content: string }> =>
      stores.flatMap(store => (store.entries ?? [])
        .filter(entry => !store.sessionId || store.sessionId === ctx.sessionId)
        .filter(entry => terms.some(term =>
          entry.content.toLocaleLowerCase().includes(term)
          || (entry as { retrievalKeywords?: string[] }).retrievalKeywords?.some(k => k.includes(term) || term.includes(k))
        ))
        .filter(entry => !args.type || fold(entry.type) === args.type)
        .filter(entry => !args.tags?.length || (entry.tags ?? []).some(tag => args.tags!.includes(tag)))
        .map(entry => ({ type: fold(entry.type), content: entry.content })))

    // Stage 1: surface keyword match (zero latency).
    let matches = search(args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean))

    // Stage 2 (only when stage 1 was empty): semantic expansion via the
    // default-model mini completion (no thinking, timeout-guarded). Failed or
    // timed-out expansion falls back to the surface result.
    if (matches.length === 0) {
      const expanded = await expandQueryTerms(ctx, args.query)
      if (expanded.length > 0) {
        matches = search(expanded)
      }
    }

    const limit = args.limit ?? 10
    const results = matches
      .filter((entry, index, self) => self.findIndex(s => s.content === entry.content) === index)
      .slice(0, limit)
    return ok(results.length
      ? results.map(entry => `[${entry.type}] ${entry.content}`).join('\n')
      : 'No relevant memories found.')
  } catch (cause) {
    return error(`Failed to query memories: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
