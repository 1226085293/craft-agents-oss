/**
 * Tool Layering Estimator
 *
 * Spec §3: mode = forced (flat|layered) if present, else
 *   est = sum(len(serialize_for_request(t)) / ESTIMATOR_DIVISOR for t in foldable)
 *   est >= enterThresholdTokens ? layered : flat
 *
 * The divisor is calibrated once against a real API request
 * (scripts/calibrate-estimator.ts → 3.636) and then fixed.
 *
 * serialize_for_request mirrors the wire format: OpenAI chat/completions tool
 * objects ({type:'function', function:{name, description, parameters}}), which
 * is what the Pi backend sends (piAuthProvider=openai).
 */

import { ESTIMATOR_DIVISOR, type ToolLayerMode } from './types.ts';

export interface EstimatableTool {
  name: string;
  description: string;
  /** JSON-schema parameters (inputSchema). */
  inputSchema: Record<string, unknown>;
}

/** Serialize one tool exactly as it hits the wire (OpenAI format, compact JSON). */
export function serializeToolForRequest(t: EstimatableTool): string {
  return JSON.stringify({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  });
}

/**
 * Token estimate for a foldable tool set (chars / calibrated divisor).
 * Does NOT include SDK built-in tools — threshold only counts foldable (§3).
 */
export function estimateFoldableTokens(tools: EstimatableTool[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += serializeToolForRequest(t).length;
  }
  return chars / ESTIMATOR_DIVISOR;
}

/**
 * Decide layering mode at session start (spec §3).
 *
 * @param forced - config value ('flat'|'layered') — wins when present
 * @param foldable - session + MCP tools (no SDK built-ins)
 * @param enterThresholdTokens - threshold; defaults to 8000
 */
export function decideToolMode(
  forced: ToolLayerMode | undefined,
  foldableTools: EstimatableTool[],
  enterThresholdTokens = 8000,
): { mode: 'flat' | 'layered'; est: number; count: number; forced: boolean } {
  const est = estimateFoldableTokens(foldableTools);
  const forcedMode = forced === 'flat' || forced === 'layered';
  const mode: 'flat' | 'layered' = forcedMode ? forced! : est >= enterThresholdTokens ? 'layered' : 'flat';
  return { mode, est, count: foldableTools.length, forced: forcedMode };
}