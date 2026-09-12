/**
 * Execution Journal Store — Persistent tool dispatch/outcome recording.
 *
 * Writes to {sessionId}/execution_journal.jsonl alongside the main session.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  JournalEntry,
  JournalState,
  ContextPressureConfig,
} from './types.ts';
import { DEFAULT_CONTEXT_PRESSURE_CONFIG, stubToolResult, estimateResultTokens } from './types.ts';

// ============================================================================
// Path Helpers
// ============================================================================

/** Get path to the execution journal for a session */
export function getJournalPath(workspaceRootPath: string, sessionId: string): string {
  return join(workspaceRootPath, 'sessions', sessionId, 'execution_journal.jsonl');
}

// ============================================================================
// Journal State Management
// ============================================================================

/**
 * Create a new empty journal state for a session.
 */
export function createJournalState(sessionId: string): JournalState {
  return {
    entries: [],
    pendingCalls: new Map(),
    totalTokens: 0,
    stubCount: 0,
  };
}

/**
 * Load existing journal entries from disk (if any).
 */
export function loadJournalEntries(workspaceRootPath: string, sessionId: string): JournalEntry[] {
  const filePath = getJournalPath(workspaceRootPath, sessionId);
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is JournalEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Save journal state to disk (append mode for streaming).
 */
export function persistJournalEntry(
  workspaceRootPath: string,
  sessionId: string,
  entry: JournalEntry,
): void {
  const filePath = getJournalPath(workspaceRootPath, sessionId);
  try {
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true });
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (error) {
    console.warn('[ExecutionJournal] Failed to persist entry:', error);
  }
}

// ============================================================================
// Journal Operations
// ============================================================================

/**
 * Record a tool_start event.
 */
export function recordToolStart(
  state: JournalState,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  turnId?: string,
  parentToolUseId?: string,
): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'tool_start',
    timestamp: new Date().toISOString(),
    sessionId,
    toolName,
    toolInput,
    turnId,
    parentToolUseId,
  };

  state.entries.push(entry);
  state.pendingCalls.set(entry.id, entry);
  return entry;
}

/**
 * Record a tool_dispatch event.
 */
export function recordToolDispatch(
  state: JournalState,
  toolStartId: string,
  toolUseId: string,
): JournalEntry | null {
  const startEntry = state.pendingCalls.get(toolStartId);
  if (!startEntry) return null;

  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'tool_dispatch',
    timestamp: new Date().toISOString(),
    sessionId: startEntry.sessionId,
    toolUseId,
    toolName: startEntry.toolName,
    parentToolUseId: startEntry.parentToolUseId,
    metadata: { parentJournalId: toolStartId },
  };

  state.entries.push(entry);
  return entry;
}

/**
 * Record a tool_result event (successful completion).
 */
export function recordToolResult(
  state: JournalState,
  dispatchId: string,
  result: string,
  config: ContextPressureConfig = DEFAULT_CONTEXT_PRESSURE_CONFIG,
): { entry: JournalEntry; stubApplied: boolean; stub?: string } {
  const dispatchEntry = state.entries.find(e => e.id === dispatchId && e.type === 'tool_dispatch');
  const toolName = dispatchEntry?.toolName || 'unknown';
  const sessionId = dispatchEntry?.sessionId || '';
  const parentToolUseId = dispatchEntry?.parentToolUseId;

  const estimatedTokens = estimateResultTokens(result);
  let stubApplied = false;
  let stubContent: string | undefined;

  // Check if we should stub this result
  if (estimatedTokens > config.stubThresholdTokens) {
    const { stub } = stubToolResult(result, toolName, estimatedTokens);
    stubContent = stub;
    stubApplied = true;
    state.stubCount++;
  }

  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    sessionId,
    toolUseId: dispatchEntry?.toolUseId,
    toolName,
    toolResult: stubApplied ? stubContent! : result,
    resultStubbed: stubApplied,
    originalResultTokens: stubApplied ? estimatedTokens : undefined,
    durationMs: dispatchEntry ? Date.now() - new Date(dispatchEntry.timestamp).getTime() : undefined,
    parentToolUseId,
  };

  // Remove from pending
  for (const [id, pending] of state.pendingCalls) {
    if (pending.metadata?.parentJournalId === dispatchId) {
      state.pendingCalls.delete(id);
    }
  }

  state.entries.push(entry);
  state.totalTokens += stubApplied ? Math.ceil(stubContent!.length / 4) : estimatedTokens;

  // Persist to disk
  persistJournalEntry('', sessionId, entry);

  return { entry, stubApplied, stub: stubContent };
}

/**
 * Record a tool_error event.
 */
export function recordToolError(
  state: JournalState,
  dispatchId: string,
  errorMessage: string,
): JournalEntry | null {
  const dispatchEntry = state.entries.find(e => e.id === dispatchId && e.type === 'tool_dispatch');
  if (!dispatchEntry) return null;

  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'tool_error',
    timestamp: new Date().toISOString(),
    sessionId: dispatchEntry.sessionId,
    toolName: dispatchEntry.toolName,
    toolUseId: dispatchEntry.toolUseId,
    errorMessage,
    durationMs: Date.now() - new Date(dispatchEntry.timestamp).getTime(),
    parentToolUseId: dispatchEntry.parentToolUseId,
  };

  state.entries.push(entry);
  persistJournalEntry('', entry.sessionId, entry);
  return entry;
}

/**
 * Record a compaction event.
 */
export function recordCompaction(
  state: JournalState,
  sessionId: string,
  reason?: string,
): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'compaction',
    timestamp: new Date().toISOString(),
    sessionId,
    metadata: { reason },
  };

  state.entries.push(entry);
  return entry;
}

/**
 * Record a context_prune event.
 */
export function recordContextPrune(
  state: JournalState,
  sessionId: string,
  prunedCount: number,
  prunedTokens: number,
): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'context_prune',
    timestamp: new Date().toISOString(),
    sessionId,
    metadata: { prunedCount, prunedTokens },
  };

  state.entries.push(entry);
  return entry;
}

/**
 * Record a session_end event.
 */
export function recordSessionEnd(
  state: JournalState,
  sessionId: string,
): JournalEntry {
  const entry: JournalEntry = {
    id: randomUUID(),
    type: 'session_end',
    timestamp: new Date().toISOString(),
    sessionId,
    metadata: {
      totalEntries: state.entries.length,
      totalTokens: state.totalTokens,
      stubCount: state.stubCount,
      pendingCalls: state.pendingCalls.size,
    },
  };

  state.entries.push(entry);
  return entry;
}

// ============================================================================
// Context Pressure Helpers
// ============================================================================

/**
 * Find old tool results that can be stubbed to relieve context pressure.
 */
export function findPrunableResults(
  state: JournalState,
  currentTurn: number,
  config: ContextPressureConfig = DEFAULT_CONTEXT_PRESSURE_CONFIG,
): JournalEntry[] {
  return state.entries.filter(e =>
    e.type === 'tool_result' &&
    e.turnId &&
    currentTurn - parseInt(e.turnId) > config.minAgeTurns &&
    (e.originalResultTokens || 0) > config.stubThresholdTokens,
  );
}

/**
 * Get journal statistics for a session.
 */
export function getJournalStats(state: JournalState): {
  totalEntries: number;
  totalTokens: number;
  stubCount: number;
  pendingCalls: number;
  errors: number;
  compactions: number;
} {
  return {
    totalEntries: state.entries.length,
    totalTokens: state.totalTokens,
    stubCount: state.stubCount,
    pendingCalls: state.pendingCalls.size,
    errors: state.entries.filter(e => e.type === 'tool_error').length,
    compactions: state.entries.filter(e => e.type === 'compaction').length,
  };
}

/**
 * Preflight: Stub old large results before compaction to relieve context pressure.
 *
 * This is called BEFORE the SDK triggers compaction, replacing old large tool
 * results with stubs so the context window has more room for recent turns.
 */
export interface PreflightResult {
  stubsApplied: number;
  tokensSaved: number;
  prunedEntries: JournalEntry[];
}

export function preflightContextPressure(
  state: JournalState,
  currentTurn: number,
  config: ContextPressureConfig = DEFAULT_CONTEXT_PRESSURE_CONFIG,
): PreflightResult {
  const prunable = findPrunableResults(state, currentTurn, config);
  let stubsApplied = 0;
  let tokensSaved = 0;

  for (const entry of prunable) {
    if (entry.type === 'tool_result' && entry.resultStubbed === false && entry.originalResultTokens && entry.toolResult) {
      const stub = stubToolResult(entry.toolResult, entry.toolName || 'unknown', entry.originalResultTokens);
      // Update the entry in place with stub content
      entry.toolResult = stub.stub;
      entry.resultStubbed = true;
      stubsApplied++;
      tokensSaved += entry.originalResultTokens - Math.ceil(stub.stub.length / 4);
    }
  }

  // Persist a context_prune event if we applied any stubs
  if (stubsApplied > 0) {
    state.entries.push({
      id: randomUUID(),
      type: 'context_prune',
      timestamp: new Date().toISOString(),
      sessionId: state.entries[0]?.sessionId || '',
      metadata: { prunedCount: stubsApplied, tokensSaved },
    });
    state.totalTokens = Math.max(0, state.totalTokens - tokensSaved);
  }

  return { stubsApplied, tokensSaved, prunedEntries: prunable };
}
