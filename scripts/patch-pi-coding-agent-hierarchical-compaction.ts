// scripts/patch-pi-coding-agent-hierarchical-compaction.ts
//
// Hierarchical emergency compaction for pi-coding-agent (applied post-install).
//
// When a summarization call fails because it does not fit the model — either
// the PROMPT overflows the context window, or the generation hit the output
// token cap (`stopReason: "length"`, surfaced as "… generation hit the token
// cap and the summary is incomplete") — split the conversation at a turn
// boundary into halves, summarize each recursively, and merge. Max depth 4
// (up to 16 chunks).
//
// The output-cap case matters on long sessions: pi-ai clamps the request's
// max_tokens to `contextWindow - estimatedInputTokens - 4096`, so a summary
// prompt that nearly fills the window leaves almost no output budget and the
// summary always comes back truncated. Halving the input both shrinks the
// prompt and frees output budget.
//
// Transient-retry for summarization calls used to be a second patch here. It
// was removed: pi-coding-agent now wraps every summarization call in
// `retryAssistantCall` (see `completeSummarization` in compaction.js), which
// honors the configured retry policy, so the local retry loop would
// double-retry.
//
// Tolerant of upstream changes: if a target pattern is not found, the patch
// is skipped with a warning (never breaks bun install).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REL = "node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
const file = path.join(import.meta.dir, "..", REL);

if (!existsSync(file)) {
  console.log(`[patch-compaction] skipped: ${REL} not found`);
  process.exit(0);
}

let src = readFileSync(file, "utf8");
let changed = false;

// Marker of this patch, and of the pre-0.85 variant that wrapped the
// text-only `generateSummary` instead of `generateSummaryWithUsage`.
const MARKER = "generateSummaryWithUsageResilient";
const LEGACY_MARKER = "export async function generateSummaryResilient";

if (src.includes(MARKER)) {
  console.log("[patch-compaction] patch (hierarchical): already applied");
  process.exit(0);
} else if (src.includes(LEGACY_MARKER)) {
  console.log("[patch-compaction] patch (hierarchical): legacy variant already applied");
  process.exit(0);
}

const HELPERS = [
  "// --- BEGIN PATCH: hierarchical emergency compaction (patch-pi-coding-agent-hierarchical-compaction) ---",
  "// When a summarization call does not fit the model — the prompt overflows the",
  "// context window, or generation hit the output token cap and came back",
  "// truncated — split the conversation at a turn boundary into halves,",
  "// summarize each recursively, and merge.",
  "const HIERARCHICAL_MAX_DEPTH = 4;",
  "const HIERARCHICAL_OVERFLOW_PATTERNS = [",
  "    /prompt is too long/i,",
  "    /request_too_large/i,",
  "    /input is too long for requested model/i,",
  "    /exceeds the context window/i,",
  "    /exceeds (?:the )?(?:model'?s )?maximum context length/i,",
  "    /input token count.*exceeds the maximum/i,",
  "    /maximum prompt length is \\d+/i,",
  "    /reduce the length of the messages/i,",
  "    /maximum context length is \\d+ tokens/i,",
  "    /exceeds (?:the )?maximum allowed input length/i,",
  "    /is longer than the model'?s context length/i,",
  "    /exceeds the limit of \\d+/i,",
  "    /exceeds the available context size/i,",
  "    /greater than the context length/i,",
  "    /context window exceeds limit/i,",
  "    /exceeded model token limit/i,",
  "    /too large for model with \\d+ maximum context length/i,",
  "    /model_context_window_exceeded/i,",
  "    /prompt too long; exceeded/i,",
  "    /context[_ ]length[_ ]exceeded/i,",
  "    /too many tokens/i,",
  "    /token limit exceeded/i,",
  "    /stream ended without finish_reason/i,",
  "    // Output-side failure: the summary generation hit the max_tokens cap and",
  "    // was truncated (pi-ai clamps max_tokens against the remaining context).",
  "    /hit the token cap/i,",
  "    /summary is incomplete/i,",
  "];",
  "const HIERARCHICAL_NON_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i, /throttling/i];",
  "function isOverflowLikeError(error) {",
  "    const message = error instanceof Error ? error.message : String(error);",
  "    if (HIERARCHICAL_NON_OVERFLOW_PATTERNS.some((p) => p.test(message))) {",
  "        return false;",
  "    }",
  "    return HIERARCHICAL_OVERFLOW_PATTERNS.some((p) => p.test(message));",
  "}",
  "function splitMessagesInHalf(messages) {",
  "    // Two is enough: a single oversized tool result can blow a smaller-than-",
  "    // configured window on its own, and refusing to split there would fail",
  "    // the compaction. The boundary search below guarantees a non-empty split",
  "    // (a lone message that is too big on its own is unsplittable either way).",
  "    if (!Array.isArray(messages) || messages.length < 2)",
  "        return null;",
  "    const sizes = messages.map((message) => estimateTokens(message));",
  "    const total = sizes.reduce((sum, size) => sum + size, 0);",
  "    if (total <= 0)",
  "        return null;",
  "    let acc = 0;",
  "    let mid = -1;",
  "    for (let i = 0; i < messages.length; i++) {",
  "        acc += sizes[i];",
  "        if (acc >= total / 2) {",
  "            mid = i + 1;",
  "            break;",
  "        }",
  "    }",
  "    if (mid <= 0 || mid >= messages.length)",
  "        return null;",
  "    // Preferred: the right half begins at a turn start, so tool calls stay",
  "    // with their results.",
  "    for (let i = mid; i < messages.length; i++) {",
  "        if (isTurnStartMessage(messages[i])) {",
  "            return [messages.slice(0, i), messages.slice(i)];",
  "        }",
  "    }",
  "    // Fallback: no turn boundary AT or AFTER the midpoint happens constantly",
  "    // in agent sessions — a single long turn is assistant -> toolResult ->",
  "    // assistant -> ... with no user message in sight. Giving up there would",
  "    // fail the whole compaction, so fall back to the closest turn boundary",
  "    // BEFORE the midpoint.",
  "    for (let i = mid - 1; i > 0; i--) {",
  "        if (isTurnStartMessage(messages[i])) {",
  "            return [messages.slice(0, i), messages.slice(i)];",
  "        }",
  "    }",
  "    // Last resort: no turn boundary anywhere (e.g. a pure tool transcript).",
  "    // Split at the midpoint, but never orphan a toolResult from the assistant",
  "    // call it answers.",
  "    let cut = mid;",
  "    while (cut < messages.length && messages[cut].role === \"toolResult\")",
  "        cut++;",
  "    if (cut <= 0 || cut >= messages.length)",
  "        return null;",
  "    return [messages.slice(0, cut), messages.slice(cut)];",
  "}",
  "async function generateSummaryWithUsageResilient(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId, depth = 0) {",
  "    try {",
  "        return await generateSummaryWithUsage(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);",
  "    }",
  "    catch (error) {",
  "        if (depth >= HIERARCHICAL_MAX_DEPTH || !isOverflowLikeError(error))",
  "            throw error;",
  "        const halves = splitMessagesInHalf(currentMessages);",
  "        if (!halves)",
  "            throw error;",
  "        const left = await generateSummaryWithUsageResilient(halves[0], model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId, depth + 1);",
  "        // Right half is chained via previousSummary so the update prompt merges both halves.",
  "        const right = await generateSummaryWithUsageResilient(halves[1], model, reserveTokens, apiKey, headers, signal, customInstructions, left.text, thinkingLevel, streamFn, env, retry, callbacks, sessionId, depth + 1);",
  "        return { text: right.text, usage: combineUsage(left.usage, right.usage) };",
  "    }",
  "}",
  "async function generateTurnPrefixSummaryResilient(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth = 0) {",
  "    try {",
  "        return await generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);",
  "    }",
  "    catch (error) {",
  "        if (depth >= HIERARCHICAL_MAX_DEPTH || !isOverflowLikeError(error))",
  "            throw error;",
  "        const halves = splitMessagesInHalf(messages);",
  "        if (!halves)",
  "            throw error;",
  "        const left = await generateTurnPrefixSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);",
  "        const right = await generateTurnPrefixSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId, depth + 1);",
  "        return { text: `${left.text}\\n\\n---\\n\\n${right.text}`, usage: combineUsage(left.usage, right.usage) };",
  "    }",
  "}",
  "// --- END PATCH ---",
].join("\n");

const TARGETS = [
  {
    name: "helpers block",
    from:
      "export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, retry, callbacks, sessionId) {",
    to: `${HELPERS}\nexport async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, retry, callbacks, sessionId) {`,
  },
  {
    name: "history call (split-turn branch)",
    from:
      "const historyResult = await generateSummaryWithUsage(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);",
    to: "const historyResult = await generateSummaryWithUsageResilient(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);",
  },
  {
    name: "history call (plain branch)",
    from:
      "const result = await generateSummaryWithUsage(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);",
    to: "const result = await generateSummaryWithUsageResilient(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);",
  },
  {
    name: "turn-prefix call",
    from:
      "const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);",
    to: "const turnPrefixResult = await generateTurnPrefixSummaryResilient(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);",
  },
];

let ok = true;
for (const { name, from } of TARGETS) {
  if (!src.includes(from)) {
    console.warn(
      `[patch-compaction] WARNING: pattern not found for "${name}" - patch skipped entirely. ` +
        `pi-coding-agent may have changed upstream; re-check ${REL}.`,
    );
    ok = false;
    break;
  }
}

if (ok) {
  for (const { from, to } of TARGETS) src = src.replace(from, to);
  changed = true;
  console.log("[patch-compaction] patch (hierarchical) applied");
}

if (changed) {
  writeFileSync(file, src);
  console.log(`[patch-compaction] written to ${REL}`);
}
