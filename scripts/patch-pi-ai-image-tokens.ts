// scripts/patch-pi-ai-image-tokens.ts
//
// Match Pi's image-token estimate to real vision-provider pricing so that
// (a) the session context bar reflects the tokens the upstream will actually
// count, and (b) auto-compaction fires BEFORE the request overflows the
// window (instead of surfacing a context-exceeded error after the fact).
//
// Root cause: pi-ai's `estimateTextAndImageContentChars` (dist/utils/estimate.js)
// charges a FIXED 4800 chars (1200 tokens) per image block. Real vision models
// price by pixel area (Anthropic documents tokens ≈ w×h/750; OpenAI/DeepSeek
// count tiles). On image-heavy sessions the estimate stays low while the real
// request is huge → the UI shows ~54% but the upstream rejects at ~1.3M tokens.
//
// This module is the single shared estimator: it is inline-bundled into both
// the Electron main process (context-badge display) and pi-agent-server
// (SDK context accounting / auto-compaction), so patching it here fixes every
// consumer at once.
//
// Fix: when an image block carries real `width`/`height` metadata (written by
// pi-agent-server's Read-image downsample), estimate chars from the pixel area
// using the Anthropic formula (chars = w×h/750×4), capped so a single image
// never exceeds ~1600 tokens (Claude's per-image ceiling). Blocks without
// dimensions fall back to the original fixed value.
//
// Idempotent + tolerant of upstream changes: exits 0 with a warning if the
// target pattern is missing (never breaks bun install).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REL = "node_modules/@earendil-works/pi-ai/dist/utils/estimate.js";
const MARKER = "__craftEstimateImageChars";

const file = path.join(import.meta.dir, "..", REL);

if (!existsSync(file)) {
  console.log(`[patch-pi-ai-image-tokens] skipped: ${REL} not found`);
  process.exit(0);
}

let src = readFileSync(file, "utf8");

if (src.includes(MARKER)) {
  console.log("[patch-pi-ai-image-tokens] already applied");
  process.exit(0);
}

const HELPER = `function ${MARKER}(block, fallback) {
    const w = block && block.width;
    const h = block && block.height;
    if (typeof w === "number" && typeof h === "number" && w >= 1 && h >= 1) {
      const chars = (w * h) * 4 / 750;
      return Math.round(chars > 6400 ? 6400 : chars);
    }
    return fallback;
  }`;

// 1. Inject the helper right after the constants at the top of the file.
const HEAD_RE = /(const ESTIMATED_IMAGE_CHARS = 4800;\n)/;
if (!HEAD_RE.test(src)) {
  console.warn("[patch-pi-ai-image-tokens] WARNING: ESTIMATED_IMAGE_CHARS constant not found — pi-ai may have changed upstream. Patch NOT applied.");
  process.exit(0);
}
HEAD_RE.lastIndex = 0;
src = src.replace(HEAD_RE, `$1${HELPER}`);

// 2. Route the image branch through the helper. The estimator reads
//    `block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS`.
const BRANCH_RE = /chars \+= block\.type === "text" \? block\.text\.length : ESTIMATED_IMAGE_CHARS;/;
if (!BRANCH_RE.test(src)) {
  console.warn("[patch-pi-ai-image-tokens] WARNING: image-branch pattern not found — pi-ai may have changed upstream. Patch NOT applied.");
  process.exit(0);
}
BRANCH_RE.lastIndex = 0;
src = src.replace(BRANCH_RE, `chars += block.type === "text" ? block.text.length : ${MARKER}(block, ESTIMATED_IMAGE_CHARS);`);

writeFileSync(file, src);
console.log(`[patch-pi-ai-image-tokens] pixel-aware image-token estimate applied to ${REL}`);

// Sanity: helper present and branch wired.
if (!src.includes(MARKER) || !src.includes(`${MARKER}(block, ESTIMATED_IMAGE_CHARS)`)) {
  console.error("[patch-pi-ai-image-tokens] ERROR: patched output missing expected wiring — aborting.");
  process.exit(1);
}
console.log("[patch-pi-ai-image-tokens] integrity check OK");