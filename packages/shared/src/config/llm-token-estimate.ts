/**
 * Coarse request-token estimate for gateway admission (TPM/TPD/TPR).
 *
 * Rate limiting has to decide *before* dispatch, so it cannot use the upstream's
 * reported usage. This walks the request body, sums the visible text (skipping
 * base64 image payloads, whose encoded length is unrelated to their token cost)
 * at 4 chars/token, and adds the requested output ceiling. The reservation is
 * reconciled with the real `usage` once the response lands, so this only has to
 * be in the right ballpark for the first request of a window.
 */

/** Strings longer than this that are pure base64 are treated as binary payloads. */
const BASE64_LIKE_MIN = 4096;
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]+$/;

const OUTPUT_KEYS = new Set(['max_tokens', 'max_completion_tokens', 'max_output_tokens']);

function requestedOutputTokens(payload: Record<string, unknown>): number {
  for (const key of OUTPUT_KEYS) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function textLength(value: unknown): number {
  if (typeof value === 'string') {
    // Base64 images: counting 1M characters as 250k tokens would block every
    // image request. Their real cost is pixel-bound, not length-bound, so skip.
    if (value.length >= BASE64_LIKE_MIN && BASE64_LIKE.test(value)) return 0;
    return value.length;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += textLength(item);
    return total;
  }
  if (value && typeof value === 'object') {
    let total = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (OUTPUT_KEYS.has(key)) continue;
      total += textLength(child);
    }
    return total;
  }
  return 0;
}

/**
 * Estimated `input + output` tokens for one request body.
 *
 * Output is the caller's `max_tokens`; the real completion can be smaller, which
 * is why the gateway reconciles the reservation afterwards.
 */
export function estimateRequestTokens(payload: Record<string, unknown>): number {
  const input = Math.ceil(textLength(payload) / 4);
  return input + requestedOutputTokens(payload);
}
