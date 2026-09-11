// scripts/patch-pi-ai-maxtokens.ts
//
// Permanent guard for the "max_tokens must be greater than 2" incident (2026-09-11).
//
// Root cause: pi-ai's clampMaxTokensToContext() clamps the request's max_tokens
// to `contextWindow - estimatedInputTokens - 4096`, with a floor of 1. When a
// long session's input approaches the declared context window (e.g. mid-turn,
// between auto-compactions), the clamp bottoms out at 1-2 tokens and the request
// goes out with max_tokens <= 2 — which strict OpenAI-compatible backends
// (B.AI / Tencent gateway, etc.) hard-reject with 400
// "max_tokens must be greater than 2".
//
// Fix: when the clamped value is <= 2, OMIT the max_tokens field entirely.
// OpenAI-compatible upstreams then apply their own context-aware default,
// which succeeds as long as the input itself fits the real window.
//
// This script is idempotent and tolerant of upstream changes: if the target
// pattern is not found it exits 0 with a warning (never breaks bun install).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REL = "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
const MARKER = "maxTokens <= 2";

const file = path.join(import.meta.dir, "..", REL);

if (!existsSync(file)) {
  console.log(`[patch-pi-ai-maxtokens] skipped: ${REL} not found`);
  process.exit(0);
}

let src = readFileSync(file, "utf8");

if (src.includes(MARKER)) {
  console.log("[patch-pi-ai-maxtokens] already applied");
  process.exit(0);
}

const ORIGINAL = `    if (options?.maxTokens) {
        if (compat.maxTokensField === "max_tokens") {
            params.max_tokens = options.maxTokens;
        }
        else {
            params.max_completion_tokens = options.maxTokens;
        }
    }`;

const PATCHED = `    if (options?.maxTokens) {
        if (options.maxTokens <= 2) {
            // patch-pi-ai-maxtokens-guard: the context-window clamp bottomed out
            // (input nearly fills the declared window). Strict OpenAI-compatible
            // backends hard-reject max_tokens <= 2. Omitting the field lets the
            // upstream apply its own context-aware default instead.
        }
        else if (compat.maxTokensField === "max_tokens") {
            params.max_tokens = options.maxTokens;
        }
        else {
            params.max_completion_tokens = options.maxTokens;
        }
    }`;

if (!src.includes(ORIGINAL)) {
  console.warn(
    "[patch-pi-ai-maxtokens] WARNING: target pattern not found — pi-ai may have changed upstream. Patch NOT applied; max_tokens<=2 guard is inactive.",
  );
  process.exit(0);
}

src = src.replace(ORIGINAL, PATCHED);
writeFileSync(file, src);
console.log(`[patch-pi-ai-maxtokens] guard applied to ${REL}`);
