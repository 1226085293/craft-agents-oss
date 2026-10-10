/**
 * Memory Module — Persistent cross-session knowledge storage.
 *
 * Extracts facts, preferences, and workflows from session transcripts,
 * stores them in a workspace-scoped JSON file, and injects relevant
 * memories into future sessions via system prompt augmentation.
 */

// ============================================================================
// Memory Entry
// ============================================================================

/** Type of memory fact — three-class schema (【决策】). */
export type MemoryType = 'factual' | 'behavioral' | 'reminder';

/** Legacy five-class extraction types (kept as prompt-side scaffold only). */
export const LEGACY_MEMORY_TYPES = ['fact', 'context', 'preference', 'workflow', 'reminder'] as const;
export type LegacyMemoryType = (typeof LEGACY_MEMORY_TYPES)[number];

/**
 * Fold a legacy five-class type into the three-class schema.
 * fact|context → factual; preference|workflow → behavioral; reminder → reminder.
 * Already-folded three-class values pass through unchanged (idempotent —
 * required for the once-only migration to be repeat-safe). Unknown values
 * fall back to 'factual' (tolerant migration).
 */
export function foldLegacyMemoryType(type: string): MemoryType {
  if (type === 'factual' || type === 'behavioral' || type === 'reminder') return type;
  switch (type) {
    case 'fact':
    case 'context':
      return 'factual';
    case 'preference':
    case 'workflow':
      return 'behavioral';
    case 'reminder':
      return 'reminder';
    default:
      return 'factual';
  }
}

/**
 * Normalize a tag for storage/comparison: trim, lowercase, collapse runs of
 * whitespace to '-', fold common English plurals. Idempotent.
 */
export function normalizeTag(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (t.length <= 3) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es')) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) {
    return t.slice(0, -1);
  }
  return t;
}

/** Equality across normalized tags (replaces exact-match in L1/Injection/L3 routing). */
export function equalTag(a: string, b: string): boolean {
  return normalizeTag(a) === normalizeTag(b);
}

/** A single persistent memory entry */
export interface MemoryEntry {
  /** Unique ID (UUID v4) */
  id: string;
  /** Memory type */
  type: MemoryType;
  /** The actual memory content */
  content: string;
  /** Source session ID where this was extracted */
  sourceSessionId: string;
  /** Tags for retrieval (lowercase, no spaces) */
  tags: string[];
  /**
   * Precomputed retrieval keywords (written with the entry): phrases a user
   * might use to ASK about this memory (同义问法、称呼、怎么问你…). Read path
   * matches query terms against content ∪ retrievalKeywords — pure string
   * ops, zero LLM, so semantically bridged queries hit deterministically.
   */
  retrievalKeywords?: string[];
  /** Extraction confidence: 0.0–1.0 */
  confidence: number;
  /** When the memory was created (ISO 8601) */
  createdAt: string;
  /** When the memory was last updated (ISO 8601), if manually edited */
  updatedAt?: string;
  /** When the memory expires (ISO 8601), if applicable */
  expiresAt?: string;
  /** Whether this memory has been injected into a session */
  injectedCount: number;
  /** Last ISO timestamp this entry was selected for injection (). */
  lastInjectedAt?: string | null;
  /** Prompt version that produced this entry; legacy entries backfilled "legacy". */
  promptVersion?: string | null;
  /** Due timestamp (ISO) — only for reminder entries; produced by extraction. */
  dueAt?: string | null;
  /** Source transcript message id (poisoning audit & blocked attribution). */
  sourceMessageId?: string | null;
  /** True after this session entry was promoted into the global store (dual-pool dedup). */
  promoted?: boolean;
  /** Global entry ids adjudicated as conflict (extraction marks, promotion consumes). */
  conflictWith?: string[];
  /** Global entry ids adjudicated as update/merge (extraction marks, promotion consumes). */
  mergeWith?: string[];
}

// ============================================================================
// Memory Store
// ============================================================================

/** Workspace-scoped memory store file structure */
export interface MemoryStore {
  /** Legacy schema marker — kept for backward compatibility ( uses schemaVersion). */
  version: 1;
  /**  schema version. Missing/<3 triggers the once-only idempotent migration (§1.3). */
  schemaVersion?: number;
  /** All active global memory entries */
  entries: MemoryEntry[];
  /** Recoverable deleted or superseded entries */
  trash?: MemoryTrashEntry[];
  /** Optional user-enabled workspace consolidation schedule. */
  consolidationSchedule?: { enabled: boolean; cron: string; timezone?: string };
  /** Timestamp of last automatic extraction pass */
  lastExtractedAt?: string;
  /** Per-extraction pass statistics */
  extractionHistory: MemoryExtractionRecord[];
  /** Total tokens used for memory injection across all sessions */
  totalInjectionTokens: number;
  /**
   * Candidates blocked by cross-store semantic dedup during extraction
   * (anti-bloat P0 observable). Persistent so the duplicate-extraction rate
   * survives restarts — console debug output is not persisted.
   */
  dedupBlockedCount?: number;
  /** : controlled tag vocabulary (frequency-sorted; extraction prompt top-N). */
  tagVocabulary?: string[];
  /** : priority tags subset — +5 injection bonus only applies to these. */
  priorityTags?: string[];
  /** : adjudication/redaction audit trail (LRU-capped). */
  blocked?: BlockedRecord[];
  /** : failed-extraction retry queue (window snapshot based). */
  extractionRetryQueue?: ExtractionRetryItem[];
  /** : cumulative tag frequency across promotions (vocabulary growth gate). */
  tagFrequency?: Record<string, number>;
}

/** A recoverable global-memory deletion record. */
export interface MemoryTrashEntry {
  entry: MemoryEntry;
  deletedAt: string;
  reason?: string;
  replacedById?: string;
}

// ============================================================================
// Adjudication audit & retry records (§1)
// ============================================================================

/** Verdict produced by the adjudication pipeline (L1 fallback included). */
export type BlockedVerdict =
  | 'duplicate'
  | 'conflict'
  | 'update'
  | 'unrelated-shadow'
  | 'l1-fallback'
  | 'sensitive';

/** Blocked/audit record appended to store.blocked (content is redacted). */
export interface BlockedRecord {
  /** Candidate content, redacted (secret → [REDACTED]) before storage. */
  candidateContent: string;
  candidateType: MemoryType;
  sourceSessionId: string;
  sourceMessageId?: string;
  matchedGlobalId?: string;
  matchedContent?: string;
  verdict: BlockedVerdict;
  reason: string;
  /** True when recorded in shadow mode (no disposition applied). */
  shadow: boolean;
  blockedAt: string;
}

/** Failed-extraction retry item (window snapshot so retry replays same messages). */
export interface ExtractionRetryItem {
  sessionId: string;
  strategy: 'compaction' | 'session_end';
  /** Message-id snapshot of the failed window; retry must use the SAME window. */
  throughMessageId: string;
  reason: string;
  attempts: number;
  failedAt: string;
}

/** Session-local memory store; it is scoped by its containing session directory. */
export interface SessionMemoryStore {
  version: 1;
  sessionId: string;
  entries: MemoryEntry[];
  /** Last successfully consolidated entry creation timestamp. */
  lastConsolidatedAt?: string;
  /** Entry IDs already considered during consolidation (handles equal timestamps). */
  consolidatedEntryIds?: string[];
  /** Last transcript message ID successfully included in extraction. */
  extractedThroughMessageId?: string;
  /** Number of transcript messages successfully included in the last extraction pass (legacy cursor fallback). */
  extractedMessageCount?: number;
  /** Extraction records prevent repeated automatic extraction passes. */
  extractionHistory: MemoryExtractionRecord[];
}

/** Record of a single extraction pass */
export interface MemoryExtractionRecord {
  /** Session ID that was extracted */
  sessionId: string;
  /** ISO timestamp of extraction */
  timestamp: string;
  /** Number of new facts extracted */
  factsExtracted: number;
  /** Number of facts discarded (low confidence or duplicate) */
  factsDiscarded: number;
  /** IDs of newly created entries */
  newEntryIds: string[];
  /**
   * Which strategy triggered this pass ('compaction' | 'session_end').
   * Optional — legacy records have no strategy field and keep matching
   * "any strategy" in the one-shot guard.
   */
  strategy?: 'compaction' | 'session_end';
}

// ============================================================================
// Extraction Input
// ============================================================================

/** Messages to extract memories from */
export interface MemoryExtractionInput {
  /** Session ID of the source session */
  sessionId: string;
  /** All messages from the session JSONL (excluding header) */
  messages: Array<{
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    toolName?: string;
    /** Approximate token count of this message */
    estimatedTokens?: number;
  }>;
  /** Session title (optional, helps with context) */
  sessionTitle?: string;
  /** Available tags from the session (for filtering) */
  existingTags?: string[];
}

// ============================================================================
// Injection
// ============================================================================

/**
 * Memory types that get behavioral treatment (常规 behavioral + due reminders).
 * Reminder-due entries additionally use the forced-injection channel (Phase 3).
 */
export const BEHAVIORAL_MEMORY_TYPES: readonly MemoryType[] = ['behavioral', 'reminder'];

/** True when a memory type represents user-intent behavior (vs background knowledge). */
export function isBehavioralMemoryType(type: MemoryType): boolean {
  return (BEHAVIORAL_MEMORY_TYPES as readonly string[]).includes(type);
}

// ============================================================================
// Feature configuration (every knob switchable; each independently revertible)
// ============================================================================

/**
 *  memory feature configuration. All features default to safe states:
 * adjudication starts in SHADOW mode (records only, no disposition),
 * expansion is enabled but zero-sync-wait on the read path.
 */
export const memoryConfig = {
  schemaVersion: 3,
  types: { schema: ['factual', 'behavioral', 'reminder'] as const },
  adjudication: {
    enabled: true,
    /** Shadow mode: verdicts recorded, dispositions NOT applied (【决策】 initial). */
    shadow: true,
    l1: { grayLow: 0.5, grayHigh: 0.75, dupTag: 0.75, dupContent: 0.85 },
    /** 'auto': use host embedding if available, otherwise skip (known degradation). */
    l2: { mode: 'auto' as const, routeCosine: 0.82 },
    l3: { maxTargets: 3, candidatesPerCall: 6, timeoutMs: 30_000 },
  },
  expansion: { enabled: true, timeoutMs: 500, topicSwitchJaccard: 0.5, variantWeight: 0.6 },
  decay: { coldDays: 180 },
  reminder: { lookaheadDays: 7, maxSlots: 2 },
  tags: { vocabPromptLimit: 80, vocabMaxSize: 200, maxNewPerExtraction: 1, promoteFrequency: 3 },
  safety: {
    /** Frame text around injected memory blocks neutralizing directive language. */
    injectionFrame: true,
    /** Redact secrets at extraction (blocked verdict 'sensitive'). */
    redact: true,
  },
  retention: { snapshots: 5, trash: 200, extractionHistory: 100, blocked: 300, retryQueue: 20 },
} as const;

/** Configuration for memory injection into a session */
export interface MemoryInjectionConfig {
  /** Maximum number of memories to inject */
  maxMemories: number;
  /** Maximum tokens budget for injected memories */
  maxTokens: number;
  /** Tags to prioritize (empty = no filter) */
  priorityTags: string[];
  /** Exclude memories with these tags */
  excludedTags: string[];
  /**
   * Minimum TOPICAL relevance score for a memory to be eligible for injection.
   * This gates on the keyword/tag signal only (NOT on confidence/recency), so an
   * entry with zero topical match to the current conversation is never injected,
   * even if it is fresh or high-confidence. Set to 0 to disable the gate and
   * always inject up to `maxMemories` (previous behavior).
   *
   * Background knowledge memories (factual) use this gate; behavioral
   * memories use {@link minBehavioralRelevanceScore} (lower, easier).
   */
  minRelevanceScore: number;
  /**
   * Minimum TOPICAL score for behavior-type memories (behavioral/reminder). Kept lower than `minRelevanceScore` so instruction-like
   * memories are easier to recall even with fuzzy wording.
   */
  minBehavioralRelevanceScore: number;
  /**
   * Reserved seats for behavior-type memories inside the injection list.
   * Guarantees at least this many behavioral/reminder memories when
   * enough qualify, so high-scoring knowledge noise cannot occupy every slot.
   */
  behavioralQuota: number;
}

/** Default injection configuration */
export const DEFAULT_MEMORY_INJECTION_CONFIG: MemoryInjectionConfig = {
  maxMemories: 8,
  maxTokens: 1500,
  priorityTags: [],
  excludedTags: ['experimental', 'discarded'],
  // A topical score of >= 2 means at least one keyword hit in content (or one
  // keyword↔tag overlap, each +2); a priority tag alone contributes +5. Keeps
  // off-topic knowledge from riding the confidence/recency floor into the top-N.
  minRelevanceScore: 2,
  // A single keyword/tag hit is enough for user-intent memories (they should be
  // easier to recall, especially with Chinese wording).
  minBehavioralRelevanceScore: 1,
  // Reserve 2 heads-up slots for behavior memories out of 8.
  behavioralQuota: 2,
};

// ============================================================================
// Memory Query
// ============================================================================

/** Arguments for the memory_query tool */
export interface MemoryQueryArgs {
  /** Search query (keyword or phrase) */
  query: string;
  /** Filter by memory type */
  type?: MemoryType;
  /** Filter by tags (exact match, comma-separated) */
  tags?: string;
  /** Maximum number of results */
  limit?: number;
  /** Minimum confidence threshold (0.0–1.0) */
  minConfidence?: number;
}

/** Result from a memory query */
export interface MemoryQueryResult {
  /** Matching entries */
  entries: MemoryEntry[];
  /** Total count of matching entries (may be more than entries if limited) */
  totalCount: number;
  /** The query that was executed */
  query: string;
}

// ============================================================================
// Memory Management Actions
// ============================================================================

/** Action to add a new memory */
export interface MemoryAddAction {
  type: 'add';
  content: string;
  typeLabel: MemoryType;
  tags?: string[];
  confidence?: number;
}

/** Action to update an existing memory */
export interface MemoryUpdateAction {
  type: 'update';
  id: string;
  content?: string;
  tags?: string[];
  confidence?: number;
}

/** Action to delete a memory */
export interface MemoryDeleteAction {
  type: 'delete';
  id: string;
}

/** Action to mark a memory as injected */
export interface MemoryInjectAction {
  type: 'inject';
  id: string;
}

/** Union of all memory actions */
export type MemoryAction = MemoryAddAction | MemoryUpdateAction | MemoryDeleteAction | MemoryInjectAction;

// ============================================================================
// Extraction Strategy
// ============================================================================

/** When to automatically extract memories from a session */
export type MemoryExtractionStrategy = 'compaction' | 'session_end' | 'both'

/** Configuration for memory extraction */
export interface MemoryConfig {
  /** When to trigger automatic extraction */
  extractionStrategy?: MemoryExtractionStrategy
  /** Maximum number of memories to extract per session */
  maxMemoriesPerSession?: number
  /** Minimum confidence threshold for auto-extracted memories */
  minAutoConfidence?: number
  /**
   * Minimum number of messages a session must accumulate before the
   * session-end (turn-end) extraction fires. Compaction and manual extraction
   * are unaffected. Guards against extracting from a nearly-empty transcript.
   */
  minMessagesForExtraction?: number
  /**
   * When true, near-duplicate candidates are dropped against the whole store
   * (tag overlap + content similarity), not just same-session exact matches.
   */
  semanticDedup?: boolean
}

/** Default configuration */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  extractionStrategy: 'both',
  maxMemoriesPerSession: 20,
  minAutoConfidence: 0.5,
  minMessagesForExtraction: 20,
  semanticDedup: true,
}
