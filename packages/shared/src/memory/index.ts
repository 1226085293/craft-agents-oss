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

// Embedding engine (semantic single-track retrieval)
export {
  encodeText,
  cosine,
  semanticTopK,
  backfillStoreEmbeddings,
} from './embedding.ts';

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

// Memory domains (v6/v7 slice C minimal: the table + auto-registered project domains)
export {
  loadMemoryDomains,
  saveMemoryDomains,
  addPersonalMemoryDomain,
  agentDomainSlug,
  ensureAgentMemoryDomain,
  resolveAgentMemoryDomain,
  memoryDomainsPath,
  resolveWriteDomain,
  resolveReadDomains,
  readDomainMemoryFile,
  GLOBAL_MEMORY_DOMAIN,
  DOMAIN_MEMORY_INJECTION_MAX_CHARS,
  DOMAIN_MEMORY_INJECTION_MAX_LINES,
  type MemoryDomainDef,
  type MemoryDomainsFile,
} from './domains.ts';

// Curation (M7b 策展步：L1 自动区 + L2 百科页 + 剪枝建议)
export {
  curateDomainMemory,
  buildCurationPrompt,
  parseCurationReply,
  readL1AutoSection,
  readWikiPages,
  writeL1AutoSection,
  domainWikiDir,
  L1_CURATION_START,
  L1_CURATION_END,
  WIKI_PAGE_MAX_CHARS,
  L1_AUTO_SECTION_MAX_CHARS,
  CURATION_ENTRY_LIMIT,
  CURATION_ENTRY_MAX_CHARS,
  type CurationProposal,
  type CurationWikiPage,
  type CurateDomainResult,
} from './curation.ts';
