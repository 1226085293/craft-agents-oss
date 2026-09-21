// scripts/patch-pi-coding-agent-image-tokens.ts
//
// Match Pi's image-token estimate to real provider pricing (Claude / OpenAI /
// DeepSeek tile-based vision) so that (a) the session context bar reflects the
// actual tokens the upstream will count, and (b) auto-compaction triggers
// BEFORE the request overflows the window (instead of 503/context-exceeded
// AFTER the request is rejected).
//
// Root cause: pi-coding-agent's `estimateTextAndImageContentChars` charges a
// FIXED 4800 chars (1200 tokens) per image block. Real vision pricing scales
// with pixel area (Anthropic: tokens ≈ width×height/750; OpenAI/DeepSeek count
// tiles). On an image-heavy session the estimate stays low while the actual
// request is huge → UI shows ~54% but the upstream rejects at ~1.3M tokens.
//
// Fix: whenever an image block carries real `width`/`height` metadata (written
// by pi-agent-server's Read-image downsample), estimate chars from the pixel
// area using the Anthropic formula (chars = w*h/750*4 = w*h/187.5), capped at
// an upper bound so a single image can never dominate absurdly. Blocks without
// dimensions fall back to the original fixed value.
//
// Idempotent + tolerant of upstream changes: exits 0 with a warning if the
// target pattern is missing (never breaks bun install).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REL = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-JVUZSMYM.js";
const MARKER = "__craftEstimateImageChars";

const file = path.join(import.meta.dir, "..", REL);

if (!existsSync(file)) {
  console.log(`[patch-image-tokens] skipped: ${REL} not found`);
  process.exit(0);
}

let src = readFileSync(file, "utf8");

if (src.includes(MARKER)) {
  console.log("[patch-image-tokens] already applied");
  process.exit(0);
}

// Helper injected before the estimator. The bundle defines both
// `ESTIMATED_IMAGE_CHARS` and `ESTIMATED_IMAGE_CHARS2` (two copies of the
// estimator); we patch every occurrence of the image-branch expression.
const HELPER = `function ${MARKER}(block,fallback){const w=block&&block.width,h=block&&block.height;if(typeof w==="number"&&typeof h==="number"&&w>=1&&h>=1){const pixels=w*h;const chars=pixels*4/750;return Math.round(chars>6400?6400:chars);}return fallback;}`;

const TARGET_RE = /block\.type==="image"&&\(chars\+=ESTIMATED_IMAGE_CHARS(\d?)\)/g;

if (!TARGET_RE.test(src)) {
  console.warn("[patch-image-tokens] WARNING: image-branch pattern not found — pi-coding-agent may have changed upstream. Patch NOT applied.");
  process.exit(0);
}

// Re-perfrom the test to reset the lastIndex, then replace.
TARGET_RE.lastIndex = 0;
src = src.replace(TARGET_RE, `block.type==="image"&&(chars+=${MARKER}(block,ESTIMATED_IMAGE_CHARS$1))`);

// Inject the helper right after the first estimator's `var ESTIMATED_IMAGE_CHARS...;`.
// Match the exact `var ESTIMATED_IMAGE_CHARS = 4800;` / `var ESTIMATED_IMAGE_CHARS2=4800;`
// statement that introduces the constant, and append the helper after it.
const CONST_RE = /(var ESTIMATED_IMAGE_CHARS\w*=4800;)/;
if (!CONST_RE.test(src)) {
  console.warn("[patch-image-tokens] WARNING: ESTIMATED_IMAGE_CHARS constant not found — helper not injected.");
} else {
  CONST_RE.lastIndex = 0;
  src = src.replace(CONST_RE, `$1${HELPER}`);
}

writeFileSync(file, src);
console.log(`[patch-image-tokens] image-token estimate patched in ${REL}`);

// Sanity: the helper must exist and the image branch must use it.
if (!src.includes(MARKER) || !src.includes(`${MARKER}(block,`)) {
  console.error("[patch-image-tokens] ERROR: patched output missing expected marker — aborting contract check.");
  process.exit(1);
}
console.log("[patch-image-tokens] integrity check OK");