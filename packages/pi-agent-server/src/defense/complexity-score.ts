/**
 * Complexity scoring helpers (S1 removed 2026-10-05).
 *
 * After the write-without-readback signal was removed as a verification
 * trigger, the side-effect scoring / read-back detection pipeline no longer
 * feeds the evaluator. What survives is the `ToolCallLike` shape, still used
 * by:
 * - evaluator.ts (recordToolCall)
 * - tool-loop-detector.ts (busy-loop fingerprints)
 */

export interface ToolCallLike {
  type: string;
  /** Raw command string for bash calls; used to classify read vs write. */
  command?: string;
  /** File path argument (write/edit/read); used to attribute fs-mtime evidence to this session's own tools. */
  path?: string;
  /** Optional read-back output (hasVerify relies on output length). */
  output?: unknown;
}
