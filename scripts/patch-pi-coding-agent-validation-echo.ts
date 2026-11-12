// scripts/patch-pi-coding-agent-validation-echo.ts
//
// Drop the echoed arguments from tool-validation errors (applied post-install).
//
// What the model currently sees when an argument fails schema validation:
//
//     Validation failed for tool "ask_user":
//       - entries: must be array
//
//     Received arguments:
//     { "entries": "{\"kind\":\"decision\", ...整个问题全文...}", ... }
//
// The second half is the model's OWN tool call, verbatim, and it is still in the model's
// context — the assistant message it just produced sits immediately above the error. Nothing
// new is learned from reading it back, and it is not small: one failed `ask_user` echoed
// ~1.5k characters of question text that had already been paid for once.
//
// Fix: remove the `\n\nReceived arguments:\n${JSON.stringify(...)}` segment from the throw
// template in `validateToolArguments`. Only the message text changes — the failure path,
// the error type and the errors list are untouched, so no call that validates today starts
// failing, and none that fails today starts passing.
//
// Tolerant of upstream changes: the target file is found by scanning the SDK's dist tree for
// the marker (chunk filenames carry a content hash and move between releases), and a missing
// anchor skips the patch with a warning rather than breaking `bun install`.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Present only in the unpatched template; used both to locate the file and to detect state. */
export const VALIDATION_ECHO_MARKER = "Received arguments:";

/** The adjacent call-site text that survives the patch — the "already applied" signal. */
const PATCHED_SITE_MARKER = 'Validation failed for tool "${toolCall.name}"';

const SDK_DIST = "node_modules/@earendil-works/pi-coding-agent/dist";

/**
 * The exact template as it appears in the bundled chunk. The newlines inside the SDK's template
 * literal are REAL newlines (minification keeps them; they are part of the message), so the
 * strings below are built with `\n` escapes rather than a literal `\\n` text.
 */
const FROM =
  '`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments,null,2)}`';

const TO = '`Validation failed for tool "${toolCall.name}":\n${errors}`';

export interface ValidationEchoPatchResult {
  changed: boolean;
  source: string;
  warning?: string;
}

export function patchValidationEcho(src: string): ValidationEchoPatchResult {
  if (src.includes(FROM)) {
    return { changed: true, source: src.replace(FROM, TO) };
  }
  if (src.includes(VALIDATION_ECHO_MARKER)) {
    return {
      changed: false,
      source: src,
      warning:
        "the echo marker is present but the template did not match — pi-coding-agent changed upstream; " +
        "re-check validateToolArguments and update FROM in scripts/patch-pi-coding-agent-validation-echo.ts",
    };
  }
  return { changed: false, source: src };
}

function collectJsFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const sdkRoot = path.join(import.meta.dir, "..", SDK_DIST);
if (!existsSync(sdkRoot)) {
  console.log(`[patch-validation-echo] skipped: ${SDK_DIST} not found`);
  process.exit(0);
}

let patchedFiles = 0;
let alreadyPatched = 0;
let warnings = 0;

for (const file of collectJsFiles(sdkRoot, [])) {
  const src = readFileSync(file, "utf8");
  /**
   * Only files that contain the call site are ours. Without this guard every file in the SDK
   * would report "already applied" and the one real file could be lost in the noise.
   */
  if (!src.includes(VALIDATION_ECHO_MARKER) && !src.includes(PATCHED_SITE_MARKER)) continue;

  const result = patchValidationEcho(src);
  const rel = path.relative(path.join(import.meta.dir, ".."), file);
  if (result.warning) {
    warnings++;
    console.warn(`[patch-validation-echo] WARNING: ${result.warning} (${rel})`);
    continue;
  }
  if (result.changed) {
    writeFileSync(file, result.source);
    patchedFiles++;
    console.log(`[patch-validation-echo] removed the arguments echo in ${rel}`);
  } else if (src.includes(PATCHED_SITE_MARKER)) {
    alreadyPatched++;
  }
}

if (patchedFiles === 0 && alreadyPatched === 0 && warnings === 0) {
  console.warn(
    `[patch-validation-echo] WARNING: no tool-validation template found under ${SDK_DIST} — nothing to patch`,
  );
} else if (patchedFiles === 0 && warnings === 0) {
  console.log("[patch-validation-echo] already applied");
}
