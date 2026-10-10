/**
 * Memory Module — Cross-session persistent knowledge.
 *
 * Extracts facts from completed sessions, stores them in a workspace-scoped
 * JSON file, and injects relevant memories into future sessions.
 *
 * Modules:
 * - types.ts: Data models and interfaces
 * - store.ts: Read/write operations for memory.json
 * - extractor.ts: LLM-based knowledge extraction from transcripts
 * - injector.ts: Relevance scoring and context building for injection
 */

// Types
export type {
  MemoryEntry,
  MemoryStore,
  MemoryTrashEntry,
  SessionMemoryStore,
  MemoryExtractionRecord,
  MemoryExtractionInput,
  MemoryInjectionConfig,
  MemoryQueryArgs,
  MemoryQueryResult,
  MemoryAction,
  MemoryType,
  MemoryAddAction,
  MemoryUpdateAction,
  MemoryDeleteAction,
  MemoryInjectAction,
} from './types.ts';

export {
  DEFAULT_MEMORY_INJECTION_CONFIG,
  normalizeTag,
  foldLegacyMemoryType,
  memoryConfig,
  type BlockedRecord,
  type ExtractionRetryItem,
} from './types.ts';

// Store
export {
  getMemoryStorePath,
  loadMemoryStore,
  softDeleteMemoryEntry,
  restoreMemoryEntry,
  clearMemoryTrash,
  permanentlyDeleteTrashEntries,
  saveMemoryStore,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  queryMemories,
  recordExtraction,
  getMemoryStats,
} from './store.ts';

export {
  getSessionMemoryStorePath,
  loadSessionMemoryStore,
  saveSessionMemoryStore,
  addSessionMemory,
  updateSessionMemory,
  deleteSessionMemory,
} from './session-store.ts';

export { withMemoryWriteLock } from './write-lock.ts';

// Extractor
export {
  buildExtractionPrompt,
  parseExtractionResponse,
  extractMemories,
  type MemoryExtractorOptions,
} from './extractor.ts';

// Injector
export {
  selectRelevantMemories,
  selectRelevantMemoriesFromScopes,
  buildMemoryContext,
  extractContextKeywords,
  extractWeightedKeywords,
  scheduleKeywordExpansion,
  recencyMultiplier,
  isColdMemory,
  type WeightedKeyword,
} from './injector.ts';

export {
  consolidateSessionMemories,
  splitConsolidationBatches,
  CONSOLIDATION_BATCH_MAX_CHARS,
  type ConsolidationOptions,
  type MemoryConsolidationSessionResult,
} from './consolidation.ts';
export { MemoryConsolidationScheduler, type MemorySchedule } from './scheduler.ts';
