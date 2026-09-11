// scripts/patch-pi-coding-agent-hierarchical-compaction.ts
//
// Compaction resilience patches for pi-coding-agent (applied post-install).
// Two independent, individually idempotent patches:
//
// PATCH 1 - hierarchical emergency compaction (2026-09-11):
//   When the summarization call itself overflows the model's context window,
//   split the conversation at a turn boundary into halves, summarize each
//   recursively, and merge. Max depth 4 (up to 16 chunks).
//
// PATCH 2 - transient-retry for summarization calls (2026-09-11):
//   A single transient blip (429 concurrency limit / 5xx / connection error)
//   used to fail the whole compaction attempt. Retry with short backoff.
//   The 429 arrives as a response with stopReason "error" (not an exception),
//   so responses are inspected too.
//
// Tolerant of upstream changes: if a target pattern is not found, that patch
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

// ---------------------------------------------------------------------------
// PATCH 1: hierarchical emergency compaction
// ---------------------------------------------------------------------------
if (src.includes("generateSummaryResilient")) {
  console.log("[patch-compaction] patch 1 (hierarchical): already applied");
} else {
  const HELPERS = [
    "// --- BEGIN PATCH: hierarchical emergency compaction (patch-pi-coding-agent-hierarchical-compaction) ---",
    "// When the summarization call itself overflows the model's context window, split the",
    "// conversation at a turn boundary into halves, summarize each recursively, and merge.",
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
    "    if (!Array.isArray(messages) || messages.length < 4)",
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
    "    // The right half must begin at a turn start so tool calls stay with their results.",
    "    for (let i = mid; i < messages.length; i++) {",
    "        if (isTurnStartMessage(messages[i])) {",
    "            return [messages.slice(0, i), messages.slice(i)];",
    "        }",
    "    }",
    "    return null;",
    "}",
    "export async function generateSummaryResilient(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, depth = 0) {",
    "    try {",
    "        return await generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);",
    "    }",
    "    catch (error) {",
    "        if (depth >= HIERARCHICAL_MAX_DEPTH || !isOverflowLikeError(error))",
    "            throw error;",
    "        const halves = splitMessagesInHalf(currentMessages);",
    "        if (!halves)",
    "            throw error;",
    "        const leftSummary = await generateSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, depth + 1);",
    "        // Right half is chained via previousSummary so the update prompt merges both halves.",
    "        return await generateSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, signal, customInstructions, leftSummary, thinkingLevel, streamFn, env, depth + 1);",
    "    }",
    "}",
    "async function generateTurnPrefixSummaryResilient(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, depth = 0) {",
    "    try {",
    "        return await generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);",
    "    }",
    "    catch (error) {",
    "        if (depth >= HIERARCHICAL_MAX_DEPTH || !isOverflowLikeError(error))",
    "            throw error;",
    "        const halves = splitMessagesInHalf(messages);",
    "        if (!halves)",
    "            throw error;",
    "        const leftSummary = await generateTurnPrefixSummaryResilient(halves[0], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, depth + 1);",
    "        const rightSummary = await generateTurnPrefixSummaryResilient(halves[1], model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, depth + 1);",
    "        return `${leftSummary}\\n\\n---\\n\\n${rightSummary}`;",
    "    }",
    "}",
    "// --- END PATCH ---",
  ].join("\n");

  const P1 = [
    {
      name: "helpers block",
      from:
        "export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env) {",
      to: `${HELPERS}\nexport async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env) {`,
    },
    {
      name: "history call (split-turn branch)",
      from:
        "? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env)",
      to: "? await generateSummaryResilient(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env)",
    },
    {
      name: "history call (plain branch)",
      from:
        "summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);",
      to: "summary = await generateSummaryResilient(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);",
    },
    {
      name: "turn-prefix call",
      from:
        "const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);",
      to: "const turnPrefixResult = await generateTurnPrefixSummaryResilient(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);",
    },
  ];

  let ok = true;
  for (const { name, from } of P1) {
    if (!src.includes(from)) {
      console.warn(
        `[patch-compaction] WARNING (patch 1): pattern not found for "${name}" - skipped entirely.`,
      );
      ok = false;
      break;
    }
  }
  if (ok) {
    for (const { from, to } of P1) src = src.replace(from, to);
    changed = true;
    console.log("[patch-compaction] patch 1 (hierarchical) applied");
  }
}

// ---------------------------------------------------------------------------
// PATCH 2: transient-retry for summarization calls
// ---------------------------------------------------------------------------
if (src.includes("SUMMARIZATION_TRANSIENT_MAX_ATTEMPTS")) {
  console.log("[patch-compaction] patch 2 (transient-retry): already applied");
} else {
  const P2_FROM = [
    "async function completeSummarization(model, context, options, streamFn) {",
    "    if (!streamFn) {",
    "        return completeSimple(model, context, options);",
    "    }",
    "    const stream = await streamFn(model, context, options);",
    "    return stream.result();",
    "}",
  ].join("\n");

  const P2_TO = [
    "// --- BEGIN PATCH: transient-retry for summarization calls (patch-pi-coding-agent-hierarchical-compaction) ---",
    "// Compaction summarization used to fail on a single transient blip (e.g. a 429",
    "// concurrency-limit from the upstream gateway) even though a short backoff +",
    "// retry (or a different channel via gateway failover) succeeds. Note the 429",
    '// arrives as a response with stopReason "error", not as a thrown exception,',
    "// so the response shape must be inspected too. Non-fatal by design: after the",
    "// attempt budget is spent the LAST response is returned and the caller throws",
    "// its own specific error message.",
    "const SUMMARIZATION_TRANSIENT_MAX_ATTEMPTS = 3;",
    "const SUMMARIZATION_TRANSIENT_ERROR_PATTERN = /\\b429\\b|rate.?limit|too many requests|overloaded|\\b50[0-4]\\b|service.?unavailable|internal.?error|bad gateway|gateway time-?out|connection error|socket|timed? out|stream ended without finish_reason/i;",
    "async function completeSummarization(model, context, options, streamFn) {",
    "    let lastResponse;",
    "    for (let attempt = 1; attempt <= SUMMARIZATION_TRANSIENT_MAX_ATTEMPTS; attempt++) {",
    "        let response;",
    "        if (!streamFn) {",
    "            response = await completeSimple(model, context, options);",
    "        }",
    "        else {",
    "            const stream = await streamFn(model, context, options);",
    "            response = await stream.result();",
    "        }",
    '        const transient = response?.stopReason === "error" &&',
    '            SUMMARIZATION_TRANSIENT_ERROR_PATTERN.test(response.errorMessage || "");',
    "        if (!transient || attempt >= SUMMARIZATION_TRANSIENT_MAX_ATTEMPTS) {",
    "            return response;",
    "        }",
    "        lastResponse = response;",
    "        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));",
    "    }",
    "    return lastResponse;",
    "}",
    "// --- END PATCH ---",
  ].join("\n");

  if (!src.includes(P2_FROM)) {
    console.warn(
      "[patch-compaction] WARNING (patch 2): completeSummarization pattern not found - skipped.",
    );
  } else {
    src = src.replace(P2_FROM, P2_TO);
    changed = true;
    console.log("[patch-compaction] patch 2 (transient-retry) applied");
  }
}

if (changed) {
  writeFileSync(file, src);
  console.log(`[patch-compaction] written to ${REL}`);
}
