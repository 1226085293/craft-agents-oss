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

export async function consolidateSessionMemories(
  globalStore: MemoryStore,
  sessionStores: SessionMemoryStore[],
  evaluate: (prompt: string) => Promise<string>,
): Promise<{ promoted: number; trashed: number }> {
  let promoted = 0
  let trashed = 0
  for (const session of sessionStores) {
    const known = new Set(session.consolidatedEntryIds ?? [])
    const candidates = session.entries.filter(entry => !known.has(entry.id))
    if (!candidates.length) continue
    const prompt = `Decide which session memories are durable reusable user facts, preferences, rules, or workflows worthy of global memory. Do not promote task-specific or temporary context. Identify a conflict ONLY when a new item explicitly supersedes the same subject. If uncertain or contexts differ, keep both. Return JSON only: {"promotions":[{"id":"candidate id","content":"...","type":"fact|preference|workflow|reminder|context","tags":[]}],"conflicts":[{"oldId":"existing global id","newId":"candidate id","reason":"..."}]}. Candidates: ${JSON.stringify(candidates)}. Existing global memories: ${JSON.stringify(globalStore.entries)}`
    const response = parseResponse(await evaluate(prompt))
    const candidateIds = new Set(candidates.map(entry => entry.id))
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
      trashed++
    }
    const conflictNewIds = new Set(response.conflicts.map(conflict => conflict.newId))
    const promotedEntries: MemoryEntry[] = response.promotions.flatMap(item => {
      const source = candidates.find(entry => entry.id === item.id)!
      const candidate = { ...source, type: item.type, content: item.content.trim(), tags: item.tags }
      if (!conflictNewIds.has(item.id) && isSemanticDuplicate(candidate, nextEntries)) return []
      return [{ ...candidate, id: source.id, createdAt: new Date().toISOString(), updatedAt: undefined, sourceSessionId: source.sourceSessionId }]
    })
    globalStore.entries = [...nextEntries, ...promotedEntries]
    globalStore.trash = nextTrash
    promoted += promotedEntries.length
    session.consolidatedEntryIds = [...known, ...candidates.map(entry => entry.id)]
    session.lastConsolidatedAt = new Date().toISOString()
  }
  return { promoted, trashed }
}
