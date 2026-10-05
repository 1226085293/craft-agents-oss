import type { MemoryEntry, MemoryStore, MemoryType, SessionMemoryStore } from './types.ts'
import { isSemanticDuplicate } from './extractor.ts'

interface ConsolidationResponse {
  promotions: Array<{ id: string; content: string; type: MemoryType; tags: string[] }>
  conflicts: Array<{ oldId: string; newId: string; reason: string }>
}

function parseResponse(response: string): ConsolidationResponse {
  const parsed = JSON.parse(response) as Partial<ConsolidationResponse>
  if (!Array.isArray(parsed.promotions) || !Array.isArray(parsed.conflicts)) throw new Error('Invalid consolidation response')
  for (const item of parsed.promotions) {
    if (!item || typeof item.id !== 'string' || typeof item.content !== 'string' || !['fact', 'preference', 'workflow', 'reminder', 'context'].includes(item.type) || !Array.isArray(item.tags)) throw new Error('Invalid memory promotion')
  }
  for (const item of parsed.conflicts) {
    if (!item || typeof item.oldId !== 'string' || typeof item.newId !== 'string' || typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Invalid memory conflict')
  }
  return parsed as ConsolidationResponse
}

/**
 * Rough estimated characters a candidate entry occupies once rendered into the
 * consolidation prompt (entry content + tags + the JSON wrapper overhead).
 */
function candidatePromptChars(entry: MemoryEntry): number {
  return entry.content.length + entry.tags.join(',').length + 80
}

/**
 * Max estimated prompt characters for a single consolidation batch.
 * Sessions with many memory entries are processed in multiple batches so the
 * LLM prompt stays within a safe context size instead of failing wholesale.
 */
export const CONSOLIDATION_BATCH_MAX_CHARS = 6000

/**
 * Split a session's candidate entries into prompt-sized batches.
 * Guarantees a non-empty result for a non-empty input.
 */
export function splitConsolidationBatches(candidates: MemoryEntry[]): MemoryEntry[][] {
  const batches: MemoryEntry[][] = []
  let current: MemoryEntry[] = []
  let currentChars = 0
  for (const candidate of candidates) {
    const size = candidatePromptChars(candidate)
    if (current.length > 0 && currentChars + size > CONSOLIDATION_BATCH_MAX_CHARS) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(candidate)
    currentChars += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function buildConsolidationPrompt(
  globalEntries: MemoryEntry[],
  candidates: MemoryEntry[],
  language?: string,
): string {
  const languageInstruction = language
    ? ` Write all promoted memory content and tags in ${language}.`
    : ''
  return `Decide which session memories are durable reusable user facts, preferences, rules, or workflows worthy of global memory. Do not promote task-specific or temporary context. Identify a conflict ONLY when a new item explicitly supersedes the same subject. If uncertain or contexts differ, keep both.${languageInstruction} Return JSON only: {"promotions":[{"id":"candidate id","content":"...","type":"fact|preference|workflow|reminder|context","tags":[]}],"conflicts":[{"oldId":"existing global id","newId":"candidate id","reason":"..."}]}. Candidates: ${JSON.stringify(candidates)}. Existing global memories: ${JSON.stringify(globalEntries)}`
}

/** Result of consolidating a single session (may span multiple batches). */
export interface MemoryConsolidationSessionResult {
  promoted: number
  trashed: number
}

/** Options for {@link consolidateSessionMemories}. */
export interface ConsolidationOptions {
  /** Preferred output language for promoted memories (native name, e.g. "简体中文"). */
  language?: string
  /**
   * Called AFTER a session's candidates were fully processed (across all of
   * its batches) and its consolidated marker advanced — i.e. only once the
   * session truly succeeded. Callers persist the stores inside this callback,
   * so an interrupted run never marks a session as organized without its work
   * having completed.
   */
  onSessionConsolidated?: (session: SessionMemoryStore, result: MemoryConsolidationSessionResult) => void
}

export async function consolidateSessionMemories(
  globalStore: MemoryStore,
  sessionStores: SessionMemoryStore[],
  evaluate: (prompt: string) => Promise<string>,
  options: ConsolidationOptions = {},
): Promise<{ promoted: number; trashed: number }> {
  let promoted = 0
  let trashed = 0
  for (const session of sessionStores) {
    const known = new Set(session.consolidatedEntryIds ?? [])
    const candidates = session.entries.filter(entry => !known.has(entry.id))
    if (!candidates.length) continue
    const batches = splitConsolidationBatches(candidates)
    let sessionPromoted = 0
    let sessionTrashed = 0
    for (const batch of batches) {
      const prompt = buildConsolidationPrompt(globalStore.entries, batch, options.language)
      const response = parseResponse(await evaluate(prompt))
      const candidateIds = new Set(batch.map(entry => entry.id))
      for (const item of response.promotions) {
        if (!candidateIds.has(item.id)) throw new Error(`Unknown memory candidate: ${item.id}`)
      }
      const conflictOldIds = new Set<string>()
      for (const conflict of response.conflicts) {
        if (!candidateIds.has(conflict.newId) || !response.promotions.some(item => item.id === conflict.newId) || !globalStore.entries.some(item => item.id === conflict.oldId) || conflictOldIds.has(conflict.oldId)) throw new Error('Conflict does not match an existing entry and a promoted candidate')
        conflictOldIds.add(conflict.oldId)
      }
      const nextEntries = [...globalStore.entries]
      const nextTrash = [...(globalStore.trash ?? [])]
      for (const conflict of response.conflicts) {
        const index = nextEntries.findIndex(entry => entry.id === conflict.oldId)
        const [old] = nextEntries.splice(index, 1)
        if (old) nextTrash.push({ entry: old, deletedAt: new Date().toISOString(), reason: conflict.reason, replacedById: conflict.newId })
        sessionTrashed++
      }
      const conflictNewIds = new Set(response.conflicts.map(conflict => conflict.newId))
      const promotedEntries: MemoryEntry[] = response.promotions.flatMap(item => {
        const source = batch.find(entry => entry.id === item.id)!
        const candidate = { ...source, type: item.type, content: item.content.trim(), tags: item.tags }
        if (!conflictNewIds.has(item.id) && isSemanticDuplicate(candidate, nextEntries)) return []
        return [{ ...candidate, id: source.id, createdAt: new Date().toISOString(), updatedAt: undefined, sourceSessionId: source.sourceSessionId }]
      })
      globalStore.entries = [...nextEntries, ...promotedEntries]
      globalStore.trash = nextTrash
      sessionPromoted += promotedEntries.length
    }
    // Mark the session as consolidated ONLY after every batch succeeded.
    // The caller persists inside onSessionConsolidated, so a restart or model
    // failure never leaves a session marked without its work having completed.
    session.consolidatedEntryIds = [...known, ...candidates.map(entry => entry.id)]
    session.lastConsolidatedAt = new Date().toISOString()
    promoted += sessionPromoted
    trashed += sessionTrashed
    options.onSessionConsolidated?.(session, { promoted: sessionPromoted, trashed: sessionTrashed })
  }
  return { promoted, trashed }
}
