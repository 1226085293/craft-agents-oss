/**
 * Execution Journal — Persistent record of tool dispatches and outcomes.
 *
 * Records every tool call (start, dispatch, outcome) in a session-scoped
 * JSONL file, enabling crash recovery, audit trails, and context pressure
 * management (pruning old results from active context).
 *
 * Format inspired by DeepChat's Execution Journal:
 *   execution/run_started → execution/dispatch_committed → execution/tool_outcome → execution/run_terminal
 */

// ============================================================================
// Journal Entry Types
// ============================================================================

/** Type of journal event */
export type JournalEventType =
  | 'tool_start'      // Tool call initiated
  | 'tool_dispatch'   // Tool call dispatched to executor
  | 'tool_result'     // Tool call completed with result
  | 'tool_error'      // Tool call failed
  | 'compaction'      // Context compaction occurred
  | 'context_prune'   // Old results pruned for context pressure
  | 'session_end';    // Session cleanup

/** Status of a tool execution */
export type ToolExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

/** A single journal entry */
export interface JournalEntry {
  /** Unique event ID */
  id: string;
  /** Event type */
  type: JournalEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Session ID this entry belongs to */
  sessionId: string;
  /** Turn ID (from SDK) if applicable */
  turnId?: string;
  /** Tool use ID (from SDK) if applicable */
  toolUseId?: string;
  /** Tool name if applicable */
  toolName?: string;
  /** Tool input if applicable */
  toolInput?: Record<string, unknown>;
  /** Tool result (truncated if large) */
  toolResult?: string;
  /** Whether the result was summarized/stubbed */
  resultStubbed?: boolean;
  /** Original result size in tokens (if stubbed) */
  originalResultTokens?: number;
  /** Error message if failed */
  errorMessage?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Parent tool use ID (for nested/subagent calls) */
  parentToolUseId?: string;
  /** Extra metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Journal Store
// ============================================================================

/** In-memory journal state for a session */
export interface JournalState {
  /** All journal entries for this session */
  entries: JournalEntry[];
  /** Map of in-flight tool calls (toolUseId → entry) */
  pendingCalls: Map<string, JournalEntry>;
  /** Total tokens recorded across all entries */
  totalTokens: number;
  /** Number of stubs applied */
  stubCount: number;
}

// ============================================================================
// Context Pressure Management
// ============================================================================

/** Configuration for context pressure pruning */
export interface ContextPressureConfig {
  /** Maximum number of tool result entries to keep in context */
  maxContextEntries: number;
  /** Token threshold above which a result should be stubbed */
  stubThresholdTokens: number;
  /** Minimum age (in turns) before a result can be pruned */
  minAgeTurns: number;
}

/** Default configuration */
export const DEFAULT_CONTEXT_PRESSURE_CONFIG: ContextPressureConfig = {
  maxContextEntries: 8,
  stubThresholdTokens: 3000,
  minAgeTurns: 3,
};

// ============================================================================
// Result Stubbing
// ============================================================================

/** Generate a stub representation of a large tool result */
export function stubToolResult(
  originalResult: string,
  toolName: string,
  estimatedTokens: number,
  filePath?: string,
): { stub: string; originalTokens: number } {
  const stub = `[Result stub: ${toolName} returned ~${estimatedTokens} tokens. Full result ${filePath ? `saved to ${filePath}` : 'not saved'}. Use Read/Grep or transform_data to access.]`;
  return { stub, originalTokens: estimatedTokens };
}

/** Estimate tokens in text (rough approximation) */
export function estimateResultTokens(text: string): number {
  // Account for base64 density
  const base64RunRegex = /[A-Za-z0-9+/=]{60,}/g;
  const matches = text.match(base64RunRegex) || [];
  const denseChars = matches.reduce((sum, m) => sum + m.length, 0);
  const normalChars = text.length - denseChars;

  // Base64 is ~1.5 chars/token, normal text is ~4 chars/token
  return Math.ceil(normalChars / 4 + denseChars / 1.5);
}
