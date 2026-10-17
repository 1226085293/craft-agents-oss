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
 * Format a memory entry's last-update time as LOCAL "YYYY/M/D HH:mm".
 * Mirrors `formatLocalTime` in @craft-agent/shared's memory injector so
 * `query_memories` output and the injected <cross_session_memory> block carry
 * byte-identical timestamps — the system prompt promises "each entry carries
 * its last-update time automatically" on read-back, and this handler is one
 * of the two read paths. Local copy: this package must stay dependency-free
 * of @craft-agent/shared (see create_task.ts / pages.ts).
 *
 * Returns '' for a missing/invalid stamp rather than a bogus date.
 */
function formatMemoryStamp(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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
 * Recommended per-entry budget, in characters.
 *
 * The read path injects at most `maxTokens: 1500` across up to `maxMemories: 8`
 * entries (DEFAULT_MEMORY_INJECTION_CONFIG) — ~187 tokens (~750 chars) per
 * entry on average. The schema allows 4000 chars, enough for ONE entry to eat
 * the whole injection budget and crowd out every other memory.
 *
 * Soft budget: over-length entries are still stored (some facts are genuinely
 * long), but the reply carries a split hint so the caller can decompose
 * "full report" memories into a summary + a session/file pointer.
 */
const MEMORY_RECOMMENDED_MAX_CHARS = 800

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
 * Write-side retrieval keyword generation (scheme C): when a memory is
 * stored, ask the mini model what phrasing a user might LATER use to ask
 * about it ("名字", "称呼", "怎么叫你"…). Matching the read path against
 * content ∪ these keywords gives semantic reach with pure string ops — no
 * LLM call on the read path, keeping injection at zero added latency.
 * Failure/timeout degrades to [] (keyword-less entries behave as before).
 */
export async function handleAddMemory(ctx: SessionToolContext, args: { action: 'add' | 'update' | 'delete'; scope: 'session' | 'global'; id?: string; content?: string; type?: string }): Promise<ToolResult> {
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
        embedding?: number[]; confidence: number; createdAt: string; injectedCount: number;
      } = {
        id: crypto.randomUUID(), type: args.type ?? 'factual', content, sourceSessionId: args.scope === 'global' ? 'manual' : ctx.sessionId,
        confidence: 0.9, createdAt: new Date().toISOString(), injectedCount: 0,
      }
      // Write-side semantic indexing: store the embedding vector with the
      // entry so read-path retrieval is pure cosine (zero LLM, 3-4ms).
      // Failure degrades to entry WITHOUT vector (read path encodes on demand).
      try {
        if (ctx.callbacks?.encodeEmbedding) {
          entry.embedding = await ctx.callbacks.encodeEmbedding(content)
        }
      } catch {
        // Model unavailable — entry still stored; read path falls back.
      }
      store.entries.push(entry)
      mkdirSync(dirname(path), { recursive: true })
      ctx.fs.writeFile(path, JSON.stringify(store, null, 2))
      // Host-side notification: UI badges/counts stay live after tool writes.
      if (args.scope === 'global') ctx.callbacks?.onMemoryChanged?.()
      // Soft length guard: keep the entry (some facts are genuinely long), but
      // nudge toward a split when it would dominate the injection budget on
      // every future read and crowd out other memories.
      const oversizeHint = content.length > MEMORY_RECOMMENDED_MAX_CHARS
        ? ` Note: this entry is ${content.length} chars, above the ~${MEMORY_RECOMMENDED_MAX_CHARS}-char budget, so it will crowd out other memories when injected. Consider replacing it with a short summary plus a pointer to the session/file holding the detail.`
        : ''
      return ok(`Added ${args.scope} memory ${entry.id}.${oversizeHint}`)
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
        entry.updatedAt = new Date().toISOString()
        if (args.scope === 'session') store.consolidatedEntryIds = (store.consolidatedEntryIds ?? []).filter((entryId: string) => entryId !== entry.id)
      }
    }
    mkdirSync(dirname(path), { recursive: true })
    ctx.fs.writeFile(path, JSON.stringify(store, null, 2))
    if (args.scope === 'global') ctx.callbacks?.onMemoryChanged?.()
    return ok(`${args.scope} memory ${action} completed.`)
  } catch (cause) {
    return error(`Failed to add memory: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export async function handleQueryMemories(ctx: SessionToolContext, args: { query: string; type?: 'factual' | 'behavioral' | 'reminder'; limit?: number }): Promise<ToolResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(ctx.sessionId)) return error('Invalid session ID')
  try {
    const stores = [memoryPath(ctx, 'global'), memoryPath(ctx, 'session')]
      .filter(path => ctx.fs.exists(path))
      .map(path => JSON.parse(ctx.fs.readFile(path)) as { sessionId?: string; entries?: Array<{ type: string; content: string; embedding?: number[]; createdAt?: string; updatedAt?: string }> })
    // Fold legacy 5-class types into the three-class space so old session
    // stores (pre- extractions) stay searchable and filterable.
    const fold = (type: string): string => {
      if (type === 'fact' || type === 'context') return 'factual'
      if (type === 'preference' || type === 'workflow') return 'behavioral'
      return type === 'reminder' ? 'reminder' : type
    }

    // Stage 1: semantic retrieval via embedding (cosine top-k). The query is
    // encoded with the same engine as injection; entries carry stored vectors
    // (written at add time) or are encoded on demand. Zero LLM — 3-4ms.
    let results: Array<{ type: string; content: string; score: number; stamp: string }> = []
    const encode = ctx.callbacks?.encodeEmbedding
    if (encode) {
      try {
        const queryVector = await encode(args.query)
        const all = stores.flatMap(store => (store.entries ?? [])
          .filter(entry => !store.sessionId || store.sessionId === ctx.sessionId)
          .filter(entry => !args.type || fold(entry.type) === args.type))
        const scored: Array<{ type: string; content: string; score: number; stamp: string }> = []
        for (const entry of all) {
          let vec = entry.embedding
          if (!vec || vec.length === 0) {
            try { vec = await encode(entry.content) } catch { /* skip un-encodable */ }
          }
          if (!vec || vec.length === 0) continue
          let dot = 0
          const len = Math.min(vec.length, queryVector.length)
          for (let i = 0; i < len; i++) dot += (vec[i] ?? 0) * (queryVector[i] ?? 0)
          // updatedAt wins over createdAt: the injected block uses the same
          // precedence, so a freshly updated memory reads the same in both.
          scored.push({ type: fold(entry.type), content: entry.content, score: dot, stamp: formatMemoryStamp(entry.updatedAt ?? entry.createdAt) })
        }
        scored.sort((a, b) => b.score - a.score)
        results = scored
      } catch {
        // Engine unavailable — fall through to lexical stage.
        results = []
      }
    }

    // Stage 2 (fallback only): surface keyword match (zero LLM). Used when the
    // embedding engine is unavailable or produced no hits for a raw query.
    if (results.length === 0) {
      const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
      results = stores.flatMap(store => (store.entries ?? [])
        .filter(entry => !store.sessionId || store.sessionId === ctx.sessionId)
        .filter(entry => !args.type || fold(entry.type) === args.type)
        .filter(entry => terms.some(term => entry.content.toLocaleLowerCase().includes(term)))
        .map(entry => ({ type: fold(entry.type), content: entry.content, score: 1, stamp: formatMemoryStamp(entry.updatedAt ?? entry.createdAt) })))
    }

    const limit = args.limit ?? 10
    const unique = results
      .filter((entry, index, self) => self.findIndex(s => s.content === entry.content) === index)
      .slice(0, limit)
    // Stamp prefix matches the injected <cross_session_memory> line format
    // (`<time>: <content>`), so both read paths render identically. Entries
    // with no usable timestamp degrade to the old stamp-less form.
    return ok(unique.length
      ? unique.map(entry => `${entry.stamp ? `${entry.stamp}: ` : ''}[${entry.type}] ${entry.content}`).join('\n')
      : 'No relevant memories found.')
  } catch (cause) {
    return error(`Failed to query memories: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
