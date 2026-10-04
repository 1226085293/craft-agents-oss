import type { MemoryEntry, MemoryStore, MemoryType, SessionMemoryStore } from './types.ts'
import { isSemanticDuplicate } from './extractor.ts'

interface ConsolidationResponse {
  promotions: Array<{ id: string; content: string; type: MemoryType; tags: string[] }>
  conflicts: Array<{ oldId: string; newId: string; reason: string }>
}

function parseResponse(response: string): ConsolidationResponse {
  // Fast path: clean JSON output parses directly (no extraction overhead).
  let parsed: Partial<ConsolidationResponse>
  try {
    parsed = JSON.parse(response) as Partial<ConsolidationResponse>
  } catch {
    // Mini models occasionally narrate before answering (e.g. "我们根据规则来评估候选…")
    // or wrap the answer in markdown code fences. Fall back to extracting the
    // outermost JSON object — mirrors parseExtractionResponse in extractor.ts.
    // A response with no JSON object at all stays a deterministic failure.
    const objectMatch = response.match(/\{[\s\S]*\}/)
    if (!objectMatch) throw new Error('Invalid consolidation response')
    parsed = JSON.parse(objectMatch[0]) as Partial<ConsolidationResponse>
  }
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
    ? `\n[Write all promoted content and tags in ${language}.]`
    : ''
  return `Decide which session memories deserve promotion to global memory. Global memory is a small, high-value store: only 8 entries are injected per turn, so the bar is high and the default answer is NO.${languageInstruction}
A candidate qualifies ONLY if it meets ALL three tests:
1. Durability — still true and useful months from now; not tied to one task, session, date, or version.
2. Behavioral value — would change how the assistant behaves in a future session.
3. Non-derivability — could NOT be trivially re-derived by reading the project's code, docs, or git history. Code is the source of truth: never memorize implementation snapshots (function logic, regexes, file contents, module structure). Memorize decisions, design rationale, user preferences, and traps — not what the code already says.
Automatic rejections:
- One-off task details: a specific bug, fix, file path, config value, error message
- Session-specific state: what happened in a named session, unfinished tool calls, transient bugs, retry/error states
- Stale-prone info: versions, dates, "currently failing/pending", sprint-scoped plans
- Restatement of the codebase, or of an existing global memory — skip it
- Fragments that need the original session to be understood
Expected outcome: 0-3 promotions per batch is normal. An empty promotions array is a GOOD result. When in doubt, reject.
Conflict rule: report a conflict ONLY when the candidate DIRECTLY contradicts or explicitly replaces an existing global memory of the SAME subject (changed preference, corrected fact). If uncertain or the contexts differ, promote normally and keep both — additions are cheap, deletions are not.
Return JSON only:
{"promotions":[{"id":"candidate id","content":"...","type":"fact|preference|workflow|reminder|context","tags":[]}],"conflicts":[{"oldId":"existing global id","newId":"candidate id","reason":"..."}]}
Rules: every promotions[].id must be one of the candidate ids below; every conflicts[].newId must be a candidate you ALSO include in promotions; every conflicts[].oldId must be one of the existing global memory ids below; never invent or guess ids. If nothing qualifies, return empty arrays.
Candidates: ${JSON.stringify(candidates)}
Existing global memories: ${JSON.stringify(globalEntries)}
Current global memory count: ${globalEntries.length}`
}

/**
 * Transient LLM failures (deadline/timeout, 429 rate limits, network errors,
 * 5xx) are retried with backoff. Deterministic failures (invalid prompt,
 * auth errors, invalid JSON responses, validation errors) are NOT.
 */
export const TRANSIENT_LLM_ERROR_PATTERN = /timed?\s*out|timeout|429|rate.?limit|too many requests|ECONN|ENET|EAI_|socket|network|fetch failed|5\d\d(\s|$|\.)|internal server error|bad gateway|service unavailable|overloaded/i

/** Thrown when a transient LLM failure has exhausted its retries. */
export class TransientLlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientLlmError'
  }
}

function isTransientLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return TRANSIENT_LLM_ERROR_PATTERN.test(message)
}

function isTimeoutLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timed?\s*out|timeout/i.test(message)
}

/** Default backoff delays between transient-error retries. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

async function cancelAwareSleep(ms: number, isCancelled?: () => boolean): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (isCancelled?.()) throw new Error('Memory consolidation cancelled')
    const remaining = ms - (Date.now() - started)
    if (remaining <= 0) return
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 500)))
  }
}

/** Result of executing one consolidation batch and applying its response. */
interface BatchResult {
  promoted: number
  trashed: number
}

interface BatchDeps {
  globalStore: MemoryStore
  evaluate: (prompt: string) => Promise<string>
  options: ConsolidationOptions
}

/**
 * Run one batch with transient-error resilience:
 * - transient failures (timeout/429/network) retry with backoff
 * - a timed-out batch is SPLIT IN HALF and each half is processed (smaller
 *   prompts complete within the LLM deadline far more reliably than
 *   retrying the same oversized prompt)
 * - deterministic failures propagate immediately
 */
async function evaluateBatch(batch: MemoryEntry[], deps: BatchDeps): Promise<BatchResult> {
  const { globalStore, evaluate, options } = deps
  let attempt = 0
  for (;;) {
    const prompt = buildConsolidationPrompt(globalStore.entries, batch, options.language)
    try {
      const response = await evaluate(prompt)
      if (options.isCancelled?.()) throw new Error('Memory consolidation cancelled')
      return applyBatchResponse(batch, parseResponse(response), globalStore)
    } catch (error) {
      if (options.isCancelled?.()) throw new Error('Memory consolidation cancelled')
      if (error instanceof TransientLlmError) throw error // retries exhausted → surface
      if (!isTransientLlmError(error)) throw error // deterministic → surface
      if (isTimeoutLlmError(error) && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2)
        const first = await evaluateBatch(batch.slice(0, mid), deps)
        const second = await evaluateBatch(batch.slice(mid), deps)
        return { promoted: first.promoted + second.promoted, trashed: first.trashed + second.trashed }
      }
      attempt += 1
      const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
      const delay = attempt <= delays.length ? delays[attempt - 1]! : delays[delays.length - 1]!
      options.onRetry?.({ attempt, message: error instanceof Error ? error.message : String(error) })
      if (delay > 0) await cancelAwareSleep(delay, options.isCancelled)
      if (attempt > (options.transientRetries ?? delays.length)) {
        throw new TransientLlmError(`Memory consolidation LLM call failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

function applyBatchResponse(batch: MemoryEntry[], response: ConsolidationResponse, globalStore: MemoryStore): BatchResult {
  let trashed = 0
  const candidateIds = new Set(batch.map(entry => entry.id))
  // SANITIZE: the model occasionally hallucinates ids (candidates from other
  // batches, global entries that no longer exist, …). Drop the invalid items
  // with a warning instead of aborting the whole consolidation run.
  const promotions = response.promotions.filter(item => candidateIds.has(item.id))
  for (const item of response.promotions) {
    if (!candidateIds.has(item.id)) console.warn(`[memory] dropping unknown promotion candidate: ${item.id}`)
  }
  const promotedIds = new Set(promotions.map(item => item.id))
  const conflicts: ConsolidationResponse['conflicts'] = []
  const conflictOldIds = new Set<string>()
  for (const conflict of response.conflicts) {
    const valid = promotedIds.has(conflict.newId)
      && globalStore.entries.some(item => item.id === conflict.oldId)
      && !conflictOldIds.has(conflict.oldId)
      && conflict.reason.trim().length > 0
    if (!valid) {
      console.warn(`[memory] dropping invalid conflict: ${conflict.oldId} <- ${conflict.newId}`)
      continue
    }
    conflictOldIds.add(conflict.oldId)
    conflicts.push(conflict)
  }
  const nextEntries = [...globalStore.entries]
  const nextTrash = [...(globalStore.trash ?? [])]
  for (const conflict of conflicts) {
    const index = nextEntries.findIndex(entry => entry.id === conflict.oldId)
    const [old] = nextEntries.splice(index, 1)
    if (old) nextTrash.push({ entry: old, deletedAt: new Date().toISOString(), reason: conflict.reason, replacedById: conflict.newId })
    trashed++
  }
  const conflictNewIds = new Set(conflicts.map(conflict => conflict.newId))
  const promotedEntries: MemoryEntry[] = []
  for (const item of promotions) {
    const source = batch.find(entry => entry.id === item.id)!
    const candidate = { ...source, type: item.type, content: item.content.trim(), tags: item.tags }
    // P0-3: batch-internal dedup — also compare against entries promoted
    // EARLIER IN THIS BATCH. Previously only the pre-existing global store
    // was checked, so two near-identical promotions from one batch both
    // slipped in. promotedEntries is live as the loop runs, so this catches
    // later siblings against earlier ones.
    const dedupPool = [...nextEntries, ...promotedEntries]
    if (!conflictNewIds.has(item.id) && isSemanticDuplicate(candidate, dedupPool)) continue
    promotedEntries.push({ ...candidate, id: source.id, createdAt: new Date().toISOString(), updatedAt: undefined, sourceSessionId: source.sourceSessionId })
  }
  globalStore.entries = [...nextEntries, ...promotedEntries]
  globalStore.trash = nextTrash
  return { promoted: promotedEntries.length, trashed }
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
  /** Checked between LLM calls and backoff sleeps; returning true aborts the run. */
  isCancelled?: () => boolean
  /** Number of transient-error retries per LLM call before giving up (defaults to the retryDelaysMs length). */
  transientRetries?: number
  /** Backoff delays in ms between transient-error retries (default [5s, 15s, 30s]). */
  retryDelaysMs?: number[]
  /**
   * Optional progress hook, called before each transient-error retry (attempt
   * counts start at 2). Callers can surface "retrying…" state to the UI.
   */
  onRetry?: (info: { attempt: number; message: string }) => void
}

export async function consolidateSessionMemories(
  globalStore: MemoryStore,
  sessionStores: SessionMemoryStore[],
  evaluate: (prompt: string) => Promise<string>,
  options: ConsolidationOptions = {},
): Promise<{ promoted: number; trashed: number }> {
  let promoted = 0
  let trashed = 0
  const deps: BatchDeps = { globalStore, evaluate, options }
  for (const session of sessionStores) {
    const known = new Set(session.consolidatedEntryIds ?? [])
    const candidates = session.entries.filter(entry => !known.has(entry.id))
    if (!candidates.length) continue
    const batches = splitConsolidationBatches(candidates)
    let sessionPromoted = 0
    let sessionTrashed = 0
    for (const batch of batches) {
      const batchResult = await evaluateBatch(batch, deps)
      sessionPromoted += batchResult.promoted
      sessionTrashed += batchResult.trashed
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
