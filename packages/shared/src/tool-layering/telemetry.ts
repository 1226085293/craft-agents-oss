/**
 * Tool-layering telemetry — per-session JSONL record of mode decisions and
 * expansion events (spec v2 §8). Enables offline verification of:
 *  - the mode chosen (flat vs layered) and the estimate that drove it,
 *  - the top-level / registry sizes at session start,
 *  - which categories the model expanded and when.
 *
 * Writes one JSONL line per event to {sessionId}/tool-layering-telemetry.jsonl
 * (same append-only design as execution_journal.jsonl).
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type ToolLayeringTelemetryEvent =
  | {
      type: 'init';
      mode: 'flat' | 'layered';
      /** estimate-driven? forced? (auto decision reason) */
      reason: string;
      estimatedTokenOverhead: number;
      thresholdTokens: number;
      topLevelCount: number;
      metaToolCount: number;
      registryCount: number;
      foldableCount: number;
      fixedLayer: string[];
      categories: string[];
    }
  | {
      type: 'expand';
      category: string;
      toolCount: number;
      toolNames: string[];
    }
  | {
      type: 'call';
      targetTool: string;
      ok: boolean;
    };

export function getToolLayeringTelemetryPath(workspaceRootPath: string, sessionId: string): string {
  return join(workspaceRootPath, 'sessions', sessionId, 'tool-layering-telemetry.jsonl');
}

/**
 * Append one telemetry line (never throws — telemetry must not break the agent).
 * Path is derived once per session start; the app creates the session dir itself,
 * we tolerate a missing dir by a single create attempt.
 */
export function recordToolLayeringTelemetry(
  workspaceRootPath: string,
  sessionId: string,
  event: ToolLayeringTelemetryEvent,
): void {
  try {
    const path = getToolLayeringTelemetryPath(workspaceRootPath, sessionId);
    // Session dir should already exist; create defensively anyway.
    const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: Date.now(), ...event }) + '\n', 'utf8');
  } catch {
    // telemetry is best-effort; never throw into session startup
  }
}