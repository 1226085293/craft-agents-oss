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

/** Type of memory fact */
export type MemoryType = 'fact' | 'preference' | 'workflow' | 'reminder' | 'context';

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
}

// ============================================================================
// Memory Store
// ============================================================================

/** Workspace-scoped memory store file structure */
export interface MemoryStore {
  /** Schema version — increment when format changes */
  version: 1;
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
}

/** A recoverable global-memory deletion record. */
export interface MemoryTrashEntry {
  entry: MemoryEntry;
  deletedAt: string;
  reason?: string;
  replacedById?: string;
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
 * Memory types that carry user intent (things to do / follow-up actions).
 * These get a reserved quota in injection so instruction-like memories are
 * not crowded out by high-scoring background knowledge noise.
 */
export const BEHAVIORAL_MEMORY_TYPES: readonly MemoryType[] = ['preference', 'workflow', 'reminder'];

/** True when a memory type represents user-intent behavior (vs background knowledge). */
export function isBehavioralMemoryType(type: MemoryType): boolean {
  return (BEHAVIORAL_MEMORY_TYPES as readonly string[]).includes(type);
}

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
   * Background knowledge memories (fact/context) use this gate; behavioral
   * memories use {@link minBehavioralRelevanceScore} (lower, easier).
   */
  minRelevanceScore: number;
  /**
   * Minimum TOPICAL score for behavior-type memories (preference/workflow/
   * reminder). Kept lower than `minRelevanceScore` so instruction-like
   * memories are easier to recall even with fuzzy wording.
   */
  minBehavioralRelevanceScore: number;
  /**
   * Reserved seats for behavior-type memories inside the injection list.
   * Guarantees at least this many workflow/preference/reminder memories when
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
