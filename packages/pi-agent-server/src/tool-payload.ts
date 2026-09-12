/**
 * Tool payload measurement + snippet shaping.
 *
 * Every tool definition is serialised into EVERY request: names, descriptions
 * and JSON-Schema parameters. With a handful of tools this is noise; with the
 * ~38 tools of a typical MCP-heavy session (7 builtin + 2 web + 29 proxy) it is
 * a fixed per-turn cost that is paid whether or not any tool is used.
 *
 * Two independent facts make this worth measuring rather than guessing:
 *
 *  1. The cost is invisible. Nothing logged it, so "my context is huge" could
 *     never be attributed between conversation history and tool schemas.
 *  2. It is charged against the channel's request ceiling, not the model's
 *     context window. On a channel that rejects requests over 8000 tokens
 *     (Groq free tier), a 5K-token tool preamble alone can consume most of the
 *     budget before a single message is counted.
 *
 * This module provides:
 *  - {@link measureToolPayload} — size of the per-turn tool preamble.
 *  - {@link buildPromptSnippet} — a short listing blurb, so the system prompt's
 *    "Available tools" index does not duplicate each tool's full description.
 */

/**
 * Max length of the `promptSnippet` listing blurb.
 *
 * The Pi SDK puts `promptSnippet` in the system prompt's "Available tools"
 * index AND `description` in each function schema. Left unbounded, every tool's
 * description is therefore sent twice — once in full in the index, once in full
 * in the schema. A short blurb keeps tools discoverable (the SDK hides tools
 * with no snippet at all) without paying for the text twice.
 */
export const PROMPT_SNIPPET_MAX_CHARS = 120;

/**
 * Rough token estimate above which the tool preamble is logged as a warning.
 * Deliberately equal to a small channel's whole request budget: at that point
 * tools, not conversation, are the binding constraint.
 */
export const TOOL_PAYLOAD_WARN_TOKENS = 8_000;

/** Mean characters per token across the JSON-heavy schema text we serialise. */
const APPROX_CHARS_PER_TOKEN = 4;

/** Minimal shape of a tool we need for measurement. */
export interface MeasurableTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  promptSnippet?: string;
}

export interface ToolPayloadMeasurement {
  toolCount: number;
  /** Characters of the serialised preamble (name + description + schema). */
  chars: number;
  /** Rough token cost, at {@link APPROX_CHARS_PER_TOKEN}. */
  approxTokens: number;
}

/**
 * Size of the tool preamble that is added to every request.
 *
 * Counts name + description + parameters — the three fields a provider actually
 * receives. `promptSnippet` is counted separately by
 * {@link measurePromptSnippetChars} because it lands in the system prompt
 * instead of the tool array.
 */
export function measureToolPayload(tools: readonly MeasurableTool[]): ToolPayloadMeasurement {
  let chars = 0;
  for (const tool of tools) {
    // JSON.stringify(undefined) is undefined, so coerce defensively.
    chars += (tool.name ?? '').length;
    chars += (tool.description ?? '').length;
    chars += tool.parameters === undefined ? 0 : JSON.stringify(tool.parameters).length;
  }
  return {
    toolCount: tools.length,
    chars,
    approxTokens: Math.ceil(chars / APPROX_CHARS_PER_TOKEN),
  };
}

/** Characters contributed by the system-prompt "Available tools" index. */
export function measurePromptSnippetChars(tools: readonly MeasurableTool[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars += (tool.promptSnippet ?? '').length;
  }
  return chars;
}

/**
 * Build the short listing blurb for a tool.
 *
 * Prefers the first sentence (it usually carries the whole gist); falls back to
 * a word-boundary cut. Never returns an empty string for a non-empty
 * description — the SDK hides tools whose snippet is missing.
 */
export function buildPromptSnippet(
  description: string | null | undefined,
  maxChars: number = PROMPT_SNIPPET_MAX_CHARS,
): string {
  const text = (description ?? '').trim();
  if (text.length === 0) return '';
  if (text.length <= maxChars) return text;

  // First sentence, when it fits — reads better than a mid-word cut.
  const sentenceEnd = text.search(/[.!?。！？](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < maxChars) {
    return text.slice(0, sentenceEnd + 1).trim();
  }

  const cut = text.lastIndexOf(' ', maxChars - 1);
  return `${text.slice(0, cut > 0 ? cut : maxChars).trimEnd()}…`;
}
