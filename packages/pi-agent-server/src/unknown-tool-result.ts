/**
 * Unknown-tool result enrichment (phantom metadata-field calls).
 *
 * The Pi SDK answers a call to a nonexistent tool with the bare string
 * `Tool <name> not found` (see `agent-loop.js`: `createErrorToolResult`).
 * When the name is one of Craft's *metadata fields*, that message is actively
 * misleading: the model never tried to call a tool — it put a display-name /
 * intent field into the function-name slot. The bare text gives it nothing to
 * correct against, so it frequently re-emits the same call (observed
 * 2026-11-04: four `_displayName` calls inside 11 seconds).
 *
 * Timing matters more than wording. The rewrite happens in
 * `tool_execution_end`, i.e. BEFORE `createToolResultMessage(finalized)` runs.
 * The interceptor hands subscribers the same `result` object it is about to
 * persist (`emitToolExecutionEnd` copies the reference, not the value), so an
 * in-place mutation here becomes the stored message. Doing it later — at
 * request-build time — would mean rewriting already-cached history on every
 * turn.
 */

/**
 * Names Craft injects as *metadata fields* rather than tools.
 *
 * Current wire keys are `appDisplayName` / `appIntent`; the underscore keys are
 * their pre-2026-11-10 names, still replayed by older sessions' history.
 */
export const CRAFT_METADATA_FIELD_NAMES: ReadonlySet<string> = new Set([
  'appDisplayName',
  'appIntent',
  '_displayName',
  '_intent',
]);

const UNKNOWN_TOOL_RESULT_RE = /^Tool (.+) not found$/;

export function buildUnknownToolExplanation(missingName: string): string {
  return [
    `Tool "${missingName}" not found.`,
    `"${missingName}" is a Craft UI metadata field (a display label or intent description), not a tool name.`,
    'Re-issue the call with a real tool name from the available tools list and its required arguments.',
    'Do not prefix tool names with an underscore.',
  ].join(' ');
}

/** Flatten a Pi tool result into its concatenated text (mirrors extractResultText). */
function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null && 'text' in c)
      .map((c) => c.text ?? '')
      .join('');
  }
  const obj = result as Record<string, unknown>;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) {
    return (obj.content as unknown[])
      .filter((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null && 'text' in c)
      .map((c) => c.text ?? '')
      .join('');
  }
  return '';
}

/**
 * Rewrite an unknown-tool error into a self-correcting message, in place.
 *
 * Deliberately narrow: fires only when the errored call's name is exactly a
 * known Craft metadata field AND the result text is the SDK's
 * `Tool X not found`. A genuinely misspelled tool name keeps the original
 * wording — telling the model that `bsh` is "a metadata field" would be a lie.
 *
 * @returns true when the result was modified.
 */
export function enrichUnknownToolResult(result: unknown, toolName: string | undefined): boolean {
  if (!toolName || !CRAFT_METADATA_FIELD_NAMES.has(toolName)) return false;
  if (typeof result !== 'object' || result === null) return false;

  const match = UNKNOWN_TOOL_RESULT_RE.exec(resultText(result).trim());
  if (!match || match[1] !== toolName) return false;

  const explanation = buildUnknownToolExplanation(toolName);
  const obj = result as Record<string, unknown>;

  if (Array.isArray(obj.content)) {
    const blocks = obj.content as Array<{ type?: string; text?: string }>;
    const target = blocks.find((block) => block && block.type === 'text' && typeof block.text === 'string');
    if (target) {
      target.text = explanation;
      return true;
    }
    blocks.push({ type: 'text', text: explanation });
    return true;
  }
  if (typeof obj.content === 'string') {
    obj.content = explanation;
    return true;
  }
  return false;
}
