/**
 * Execution Journal — Persistent record of tool dispatches and outcomes.
 *
 * Provides crash recovery, audit trails, and context pressure management
 * by recording every tool call lifecycle in a session-scoped JSONL file.
 *
 * Modules:
 * - types.ts: Data models and interfaces
 * - store.ts: Read/write operations for journal files
 * - manifest.ts: Immutable session summary for crash recovery
 */

export type {
  JournalEntry,
  JournalState,
  JournalEventType,
  ToolExecutionStatus,
  ContextPressureConfig,
} from './types.ts';

export {
  DEFAULT_CONTEXT_PRESSURE_CONFIG,
  stubToolResult,
  estimateResultTokens,
} from './types.ts';

export {
  getJournalPath,
  createJournalState,
  loadJournalEntries,
  persistJournalEntry,
  recordToolStart,
  recordToolDispatch,
  recordToolResult,
  recordToolError,
  recordCompaction,
  recordContextPrune,
  recordSessionEnd,
  findPrunableResults,
  getJournalStats,
  preflightContextPressure,
  type PreflightResult,
} from './store.ts';

// Manifest types
export type {
  TapeManifest,
  TapeStatus,
  CrashRecoveryState,
} from './manifest.ts';

// Manifest functions
export {
  getManifestPath,
  buildManifest,
  writeManifest,
  loadManifest,
  estimateReplayTokens,
  analyzeCrashState,
} from './manifest.ts';
