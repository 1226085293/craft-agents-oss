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
 * - memory-tool.ts: memory_query and memory_manage tools
 */

// Types
export type {
  MemoryEntry,
  MemoryStore,
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
} from './types.ts';

// Store
export {
  getMemoryStorePath,
  loadMemoryStore,
  saveMemoryStore,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  queryMemories,
  markMemoryInjected,
  recordExtraction,
  applyMemoryAction,
  getMemoryStats,
} from './store.ts';

// Extractor
export {
  buildExtractionPrompt,
  parseExtractionResponse,
  extractMemories,
  estimateMemoryExtractionTokens,
  type MemoryExtractorOptions,
} from './extractor.ts';

// Injector
export {
  selectRelevantMemories,
  buildMemoryContext,
  extractContextKeywords,
  formatMemoriesForPrompt,
  hasMemories,
  previewMemoryInjection,
} from './injector.ts';

// Tools
export {
  createMemoryQueryTool,
  createMemoryManageTool,
  handleMemoryQuery,
  handleMemoryManage,
  registerMemoryTools,
  MemoryQuerySchema,
  MemoryManageSchema,
} from './memory-tool.ts';
