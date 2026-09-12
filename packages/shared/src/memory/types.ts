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
  /** All memory entries */
  entries: MemoryEntry[];
  /** Timestamp of last automatic extraction pass */
  lastExtractedAt?: string;
  /** Per-extraction pass statistics */
  extractionHistory: MemoryExtractionRecord[];
  /** Total tokens used for memory injection across all sessions */
  totalInjectionTokens: number;
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
}

/** Default injection configuration */
export const DEFAULT_MEMORY_INJECTION_CONFIG: MemoryInjectionConfig = {
  maxMemories: 5,
  maxTokens: 1500,
  priorityTags: [],
  excludedTags: ['experimental', 'discarded'],
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
