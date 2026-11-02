/**
 * Attachment Name Registry
 *
 * When a request carries more images than the upstream accepts, the extra image
 * parts are replaced by a text placeholder so the turn still succeeds. That
 * placeholder is only useful if it names the file: a bare marker leaves the
 * model unable to read the image, and `#N` cannot be resolved because the same
 * original name (`pasted-image-1.png`) is reused by every message in a session.
 *
 * The image payload cannot carry the name itself: the Anthropic SDK rebuilds
 * image parts from `{ mimeType, data }` only, so any extra field is dropped
 * before the request leaves the process. This registry is the side channel —
 * the sender (SessionManager, which has both the base64 and the stored file
 * name) records `sha256(base64) -> stored file name`, and the transcoder looks
 * that name up when it has to drop an image.
 *
 * Design notes:
 * - Keyed by a digest, not by the whole payload: storing base64 strings for
 *   every attachment would hold megabytes per session for no benefit.
 * - Bounded: entries are evicted oldest-first so a long-lived app process does
 *   not grow without limit. That is acceptable because the registry only needs
 *   to cover images that will be re-sent in the same process lifetime — an
 *   evicted entry simply degrades to the short fallback marker.
 * - A miss is not an error: the transcoder falls back to a numbered marker.
 */

import { createHash } from 'node:crypto';

/** How many `digest -> name` pairs to keep. Each entry is a 64-char key + a filename. */
const MAX_ENTRIES = 512;

const names = new Map<string, string>();

/** `Map` iteration order is insertion order, so the first key is the oldest. */
function evictIfNeeded(): void {
  while (names.size > MAX_ENTRIES) {
    const oldest = names.keys().next();
    if (oldest.done) return;
    names.delete(oldest.value);
  }
}

function digest(base64: string): string {
  return createHash('sha256').update(base64).digest('hex');
}

/**
 * Remember the stored file name for an attachment payload.
 *
 * @param base64 - The attachment's base64 payload, exactly as it is sent upstream.
 * @param storedName - File name on disk (e.g. `a1b2c3d4_pasted-image-1.png`).
 */
export function registerAttachmentName(base64: string, storedName: string): void {
  if (!base64 || !storedName) return;
  const key = digest(base64);
  // Re-insert so a re-sent attachment counts as "recently used".
  names.delete(key);
  names.set(key, storedName);
  evictIfNeeded();
}

/** Look up the stored file name for an attachment payload. */
export function lookupAttachmentName(base64: string): string | undefined {
  if (!base64) return undefined;
  return names.get(digest(base64));
}

/** Test/maintenance hook: drop every entry. */
export function clearAttachmentNames(): void {
  names.clear();
}
