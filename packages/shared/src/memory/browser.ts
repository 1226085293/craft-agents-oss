/**
 * Browser-safe memory subpath for the Electron renderer (vite bundling).
 *
 * Only pure helpers (no node:fs / node:path / interprocess IO) are exported
 * here. The renderer must import from '@craft-agent/shared/memory/browser' —
 * NOT '@craft-agent/shared/memory' — because the full index re-exports
 * store.ts / session-store.ts which import node:fs and blow up in client
 * code ("Module node:fs has been externalized for browser compatibility").
 */
export { isColdMemory, recencyMultiplier } from './pure.ts';
export {
  DEFAULT_MEMORY_INJECTION_CONFIG,
  BEHAVIORAL_MEMORY_TYPES,
  isBehavioralMemoryType,
  normalizeTag,
  equalTag,
  foldLegacyMemoryType,
  memoryConfig,
  type MemoryEntry,
  type MemoryStore,
  type SessionMemoryStore,
  type MemoryType,
  type BlockedRecord,
  type ExtractionRetryItem,
} from './types.ts';