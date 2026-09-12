/**
 * Tape-lite Manifest — Immutable session summary for crash recovery.
 *
 * Written at session end (or on crash) as a JSON file alongside the journal.
 * Enables fast replay estimation and crash-state analysis without parsing
 * the full journal.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalState, JournalEntry } from './types.ts';

// ============================================================================
// Types
// ============================================================================

/** Status of a completed or crashed session */
export type TapeStatus = 'completed' | 'crashed' | 'compacted';

/** Immutable summary of a session's execution tape */
export interface TapeManifest {
  /** Session ID this manifest belongs to */
  sessionId: string;
  /** Workspace root path where the session lives */
  workspaceRootPath: string;
  /** ISO timestamp when the session started */
  createdAt: string;
  /** ISO timestamp when the session ended (null if still running) */
  endedAt: string | null;
  /** Final status */
  status: TapeStatus;
  /** Total journal entries recorded */
  totalEntries: number;
  /** Estimated tokens consumed across all entries */
  totalTokens: number;
  /** Number of large results stubbed */
  stubCount: number;
  /** Number of context compactions */
  compactionCount: number;
  /** Number of tool errors */
  errorCount: number;
  /** Per-tool summary: toolName -> { count, totalDurationMs } */
  toolSummary: Record<string, { count: number; totalDurationMs: number }>;
  /** Approximate turn count (tool_dispatch events / 2) */
  turnCount: number;
  /** Ordered sequence of tool calls for replay estimation */
  toolSequence: Array<{
    name: string;
    toolUseId: string;
    timestamp: string;
    durationMs?: number;
  }>;
}

/** Analyzed state for crash recovery decisions */
export interface CrashRecoveryState {
  /** Last completed turn number (0 = none) */
  lastCompletedTurn: number;
  /** Tools that were in-flight at crash time */
  pendingTools: Array<{
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    startedAt: string;
  }>;
  /** Whether replay is feasible (token estimate under context limit) */
  canReplay: boolean;
  /** Estimated tokens to replay */
  replayTokenEstimate: number;
  /** Total duration of the session in ms */
  totalDurationMs?: number;
}

// ============================================================================
// Path Helpers
// ============================================================================

/** Path to the tape manifest for a session */
export function getManifestPath(workspaceRootPath: string, sessionId: string): string {
  return join(workspaceRootPath, 'sessions', sessionId, 'tape_manifest.json');
}

// ============================================================================
// Build & Write
// ============================================================================

/**
 * Build a TapeManifest from journal state.
 * Called at session end or crash time.
 */
export function buildManifest(
  sessionId: string,
  workspaceRootPath: string,
  state: JournalState,
  status: TapeStatus = 'completed',
): TapeManifest {
  const dispatchEntries = state.entries.filter(e => e.type === 'tool_dispatch');
  const resultEntries = state.entries.filter(e => e.type === 'tool_result');
  const errorEntries = state.entries.filter(e => e.type === 'tool_error');
  const compactionEntries = state.entries.filter(e => e.type === 'compaction');

  // Build tool summary
  const toolSummary: Record<string, { count: number; totalDurationMs: number }> = {};
  for (const entry of resultEntries) {
    if (!entry.toolName) continue;
    if (!toolSummary[entry.toolName]) {
      toolSummary[entry.toolName] = { count: 0, totalDurationMs: 0 };
    }
    const summary = toolSummary[entry.toolName]!;
    summary.count++;
    if (entry.durationMs) summary.totalDurationMs += entry.durationMs;
  }
  for (const entry of errorEntries) {
    if (!entry.toolName) continue;
    if (!toolSummary[entry.toolName]) {
      toolSummary[entry.toolName] = { count: 0, totalDurationMs: 0 };
    }
    const summary = toolSummary[entry.toolName]!;
    summary.count++;
  }

  // Build tool sequence (matched dispatch -> result pairs)
  const toolSequence: TapeManifest['toolSequence'] = [];
  const resultByDispatchId = new Map<string, JournalEntry>();
  for (const entry of state.entries) {
    if (entry.type === 'tool_result' && entry.metadata?.parentJournalId) {
      resultByDispatchId.set(entry.metadata.parentJournalId as string, entry);
    }
  }
  for (const entry of dispatchEntries) {
    const result = resultByDispatchId.get(entry.id);
    toolSequence.push({
      name: entry.toolName || 'unknown',
      toolUseId: entry.toolUseId || entry.id,
      timestamp: entry.timestamp,
      durationMs: result ? Date.parse(result.timestamp) - Date.parse(entry.timestamp) : undefined,
    });
  }

  return {
    sessionId,
    workspaceRootPath,
    createdAt: state.entries[0]?.timestamp || new Date().toISOString(),
    endedAt: status === 'completed' ? new Date().toISOString() : null,
    status,
    totalEntries: state.entries.length,
    totalTokens: state.totalTokens,
    stubCount: state.stubCount,
    compactionCount: compactionEntries.length,
    errorCount: errorEntries.length,
    toolSummary,
    turnCount: Math.ceil(dispatchEntries.length / 2),
    toolSequence,
  };
}

/**
 * Write the manifest to disk.
 */
export function writeManifest(
  workspaceRootPath: string,
  sessionId: string,
  manifest: TapeManifest,
): void {
  const filePath = getManifestPath(workspaceRootPath, sessionId);
  try {
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true });
    writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[TapeManifest] Failed to write manifest:', error);
  }
}

// ============================================================================
// Load & Analyze
// ============================================================================

/**
 * Load a manifest from disk.
 */
export function loadManifest(
  workspaceRootPath: string,
  sessionId: string,
): TapeManifest | null {
  const filePath = getManifestPath(workspaceRootPath, sessionId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as TapeManifest;
  } catch {
    return null;
  }
}

/**
 * Estimate tokens needed to replay a session from the manifest.
 */
export function estimateReplayTokens(manifest: TapeManifest): number {
  const avgResultTokens = manifest.totalTokens / Math.max(1, manifest.totalEntries);
  const inputPerTurn = 500;
  const turns = manifest.turnCount || 1;
  return turns * (inputPerTurn + avgResultTokens);
}

/**
 * Analyze a crashed session to determine recovery options.
 */
export function analyzeCrashState(
  manifest: TapeManifest,
  fullState: JournalState,
): CrashRecoveryState {
  const dispatchEntries = fullState.entries.filter(e => e.type === 'tool_dispatch');
  const resultEntries = fullState.entries.filter(e => e.type === 'tool_result');

  // Find last completed turn
  const completedTurnIds = new Set<string>();
  for (const result of resultEntries) {
    if (result.turnId) completedTurnIds.add(result.turnId);
  }
  let lastCompletedTurn = 0;
  for (const id of completedTurnIds) {
    const num = parseInt(id);
    if (!isNaN(num) && num > lastCompletedTurn) lastCompletedTurn = num;
  }

  // Find pending tools
  const completedToolUseIds = new Set(resultEntries.map(e => e.toolUseId).filter(Boolean));
  const pendingTools = dispatchEntries
    .filter(e => e.toolUseId && !completedToolUseIds.has(e.toolUseId))
    .map(e => ({
      toolUseId: e.toolUseId!,
      name: e.toolName || 'unknown',
      input: e.toolInput || {},
      startedAt: e.timestamp,
    }));

  // Estimate replay cost
  const replayEstimate = estimateReplayTokens(manifest);
  const canReplay = replayEstimate < 150_000;

  // Calculate total duration
  const createdAt = new Date(manifest.createdAt).getTime();
  const endedAt = manifest.endedAt ? new Date(manifest.endedAt).getTime() : Date.now();
  const totalDurationMs = endedAt - createdAt;

  return {
    lastCompletedTurn,
    pendingTools,
    canReplay,
    replayTokenEstimate: replayEstimate,
    totalDurationMs,
  };
}
