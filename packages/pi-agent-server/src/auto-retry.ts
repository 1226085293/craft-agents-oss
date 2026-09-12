/**
 * Auto-retry for transient LLM errors (subprocess side).
 *
 * When the SDK's own fast retries are exhausted (`agent_end` with
 * `willRetry:false` after an error assistant message), the subprocess re-runs
 * the interrupted turn itself: strip the trailing error assistant (mirrors the
 * SDK's `_prepareRetry`), then `agent.continue()`. First retry after ~2s, then
 * every 5 minutes, giving up after 2 hours or 30 rounds.
 *
 * Classification is deliberately CONSERVATIVE about giving up: anything not
 * recognisably permanent (auth / billing / quota / context overflow) is treated
 * as transient and retried — bounded by the 2h deadline and round cap, so a
 * misclassified permanent error costs at most 30 harmless retries, never data
 * loss or an infinite loop.
 *
 * Exception: upstream gateway response-budget 503s (e.g. agnes-apihub's
 * "upstream_response_budget_exhausted") are classified 'transient_limited' —
 * retried like transient errors, but the cycle gives up after
 * AUTO_RETRY_BUDGET_MAX_ROUNDS consecutive budget failures. Whether the error
 * is deterministic (per-request buffer cap) or transient (global memory
 * pressure / channel failover) is unknowable client-side; the tight cap
 * bounds the cost in both worlds (2026-09-11 fit-pulsar incident #2: the
 * earlier 'permanent' classification let a recoverable memory-pressure blip
 * kill the session outright with zero retries).
 *
 * Status-code layer (2026-09-13): the string-pattern approach above cannot
 * enumerate every way a provider phrases a definitive rejection, and it
 * defaults unknown text to transient. Since the retry loop re-sends the SAME
 * history, any error that is a property of the request can never heal — it
 * only burns the whole 2h/30-round budget while the UI reports "retrying".
 * Per RFC 9110, 4xx means "the client must change the request" and 5xx means
 * "the server may recover", so once a status code can be recovered from the
 * error text it decides the class, with a small explicit allowlist of 4xx
 * codes that are legitimately transient. Errors with no recoverable status
 * code keep the conservative string-based default (2026-09-13 lively-forest:
 * a deterministic `400 ... property 'reasoning_content' is unsupported` and a
 * `413 Request too large ... Limit 8000, Requested 61426` were both classified
 * transient and would have spun for two hours).
 */

// First retry: short — the provider hiccup is often over in seconds.
export const AUTO_RETRY_FIRST_DELAY_MS = 2_000;
// Steady-state cadence: providers recover from outages on the order of minutes.
export const AUTO_RETRY_INTERVAL_MS = 5 * 60_000;
// Give up entirely after this much wall-clock time in a single retry cycle.
export const AUTO_RETRY_DEADLINE_MS = 2 * 60 * 60_000;
// Hard cap on retry rounds regardless of the deadline.
export const AUTO_RETRY_MAX_ROUNDS = 30;

/**
 * Errors that will NEVER heal on their own — retrying only burns time and
 * masks the real problem. Checked FIRST; anything matching is permanent.
 * Mirrors the SDK's NON_RETRYABLE list plus our own gateway/auth phrases.
 */
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  // HTTP auth
  /\b401\b/,
  /unauthorized/i,
  // API keys
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /api key (?:is )?not valid/i,
  /invalid[_ ]token\b/i,
  // Chinese auth/billing phrasings (providers are not case-normalized)
  /认证失败/,
  /鉴权失败/,
  /密钥无效/,
  /无效的密钥/,
  /余额不足/,
  /欠费/,
  // Billing / quota (SDK NON_RETRYABLE parity + OpenAI/Anthropic shapes)
  /insufficient[_ ](?:quota|balance|funds|credits?)/i,
  /quota exceeded/i,
  /out of budget/i,
  /\bbilling\b/i,
  /check your plan/i,
  /check your payment/i,
  /available balance/i,
  // Provider usage-limit gates (SDK NON_RETRYABLE parity)
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /monthly usage limit reached/i,
  // Context overflow — belt-and-braces only (isContextOverflow is the primary
  // guard); overflow has its own recovery lane (SDK auto-compaction).
  /exceeds the context window/i,
  /prompt is too long/i,
  /maximum context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  // Request-shape rejections (2026-09-13 lively-forest). The provider refuses
  // a field or format that the retry loop will send byte-identical next time,
  // so retrying can only reproduce it. Notably the SDK surfaces these via
  // `errorMessage` ONLY — the HTTP status lives in a sibling field and never
  // reaches this classifier, so the status-code layer below cannot see them.
  // Deliberately NOT matching "is not supported": that phrasing appears in
  // transient upstream notices ("User location is not supported").
  /is unsupported\b/i,
  /unsupported (?:parameter|field|property|value|argument)/i,
  /must be satisfied/i,
  // Request-size / throughput ceilings. When the request itself exceeds a
  // fixed ceiling (Requested > Limit) it can never fit — unlike a 429, whose
  // budget refills. Groq free tier: "Request too large ... Limit 8000,
  // Requested 61426, please reduce your message size".
  /request too large/i,
  /payload too large/i,
  /please reduce (?:your |the )?(?:message|prompt|input|request|context)/i,
];

/**
 * Recognisable transient shapes. Informational only — classification defaults
 * to transient, so an unknown error string is retried (bounded by the
 * deadline + round cap). Listed for documentation and future tightening.
 */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\b50[0-4]\b/,
  /\b524\b/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /过载/,
  /限流/,
  /访问量过大/,
  /稍后再试/,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /econnrefused/i,
  /epipe/i,
  /ehostunreach/i,
  /enotfound/i,
  /fetch failed/i,
  /network/i,
  /socket hang up/i,
  /terminated/i,
  /no available providers/i,
  /无可用/,
  /location is not supported/i,
  /\b1305\b/,
  /\b1300\b/,
  /temporarily/i,
  /try again/i,
];

// Upstream gateway response-budget caps (see header comment): ambiguous
// permanent-vs-transient, so retried with a tight per-cycle round cap.
export const AUTO_RETRY_BUDGET_MAX_ROUNDS = 3;

const BUDGET_EXHAUSTED_ERROR_PATTERN =
  /upstream_response_budget_exhausted|response.*budget.*exhaust/i;

export function isBudgetExhaustedError(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return BUDGET_EXHAUSTED_ERROR_PATTERN.test(errorText);
}

export type AutoRetryErrorClass = 'transient' | 'transient_limited' | 'permanent';

/**
 * 4xx codes that CAN legitimately heal while the request stays identical.
 *
 * Everything else in the 4xx range means the request itself is wrong (or the
 * account/model cannot serve it at all), so re-sending it verbatim can only
 * reproduce the same rejection:
 *  - 400 malformed/unsupported field, 401/403 auth, 404 unknown model
 *  - 413 payload or rate limit that the client must reduce  (Groq free tier:
 *    "Request too large ... Limit 8000, Requested 61426")
 *  - 415/422 semantic validation, 431 headers too large
 */
export const TRANSIENT_4XX = new Set([
  408, // Request Timeout — the server gave up waiting, not judging the request
  409, // Conflict — resolving depends on server state that may change
  425, // Too Early — replay protection, safe to replay
  429, // Too Many Requests — the canonical transient 4xx
]);

/**
 * Ordered most-specific first so contextual forms win over a bare number.
 * Every capture is anchored to a 3-digit HTTP code with word boundaries, so
 * unrelated numbers in the text (token counts, request ids) never match —
 * see the 'generated 4013 tokens' regression test.
 */
const HTTP_STATUS_PATTERNS: RegExp[] = [
  /\bHTTP\/?[\d.]*\s+([1-9]\d{2})\b/i,                 // "HTTP/1.1 400", "HTTP 400"
  /\bstatus[_ ]?code\s*[:=]\s*([1-9]\d{2})\b/i,        // "status_code: 400"
  /["']?status["']?\s*[:=]\s*([1-9]\d{2})\b/i,         // `"status": 400`
  /\bstatus\s*[:=]?\s*([45]\d{2})\b/i,                 // "status 400"
  /\berror\s+([45]\d{2})\b/i,                          // "Error 400 with provider ..."
  /\bhttp[_ ]?status\s*[:=]?\s*([45]\d{2})\b/i,        // "http_status=413"
  /\b([45]\d{2})\s+(?:bad request|unauthorized|payment required|forbidden|not found|request entity too large|payload too large|unsupported media type|too many requests|request header fields too large|unprocessable)/i,
  /\b([45]\d{2})\b/,                                   // bare code — last resort
];

/**
 * Best-effort recovery of an HTTP status code from a provider error string.
 * Returns null when no code can be identified, in which case the caller falls
 * back to string-pattern classification.
 */
export function extractHttpStatus(errorText: string | null | undefined): number | null {
  if (!errorText) return null;
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const m = errorText.match(pattern);
    if (m?.[1]) {
      const code = Number(m[1]);
      if (Number.isInteger(code) && code >= 100 && code <= 599) return code;
    }
  }
  return null;
}

/**
 * Classify an assistant error message for the auto-retry loop.
 *
 * Order of precedence:
 *  1. Explicit permanent phrases (auth / billing / quota / context overflow) —
 *     a 429 that also mentions billing is billing.
 *  2. Upstream response-budget errors — 'transient_limited'.
 *  3. HTTP status code, when one can be recovered: 5xx → transient,
 *     4xx → permanent unless it is in {@link TRANSIENT_4XX}.
 *  4. Unknown text with no status code → transient (the conservative default,
 *     which covers transport errors whose text carries no status at all).
 */
export function classifyAutoRetryError(errorText: string | null | undefined): AutoRetryErrorClass {
  if (!errorText) return 'transient';
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(errorText)) return 'permanent';
  }
  if (BUDGET_EXHAUSTED_ERROR_PATTERN.test(errorText)) return 'transient_limited';

  const status = extractHttpStatus(errorText);
  if (status !== null) {
    if (status >= 500) return 'transient';
    if (status >= 400) return TRANSIENT_4XX.has(status) ? 'transient' : 'permanent';
  }
  return 'transient';
}

/** Minimal shape of a Pi assistant message the loop needs to inspect. */
export interface AutoRetryAssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Extract the LAST message of a run when it is an assistant message.
 * Returns null for empty lists or a non-assistant tail (e.g. toolResult,
 * which happens when a run was aborted mid-tool).
 */
export function extractLastAssistant(messages: unknown): AutoRetryAssistantLike | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as AutoRetryAssistantLike | undefined;
  if (!last || last.role !== 'assistant') return null;
  return last;
}

/**
 * Remove the trailing failed assistant message IN PLACE — the exact mirror of
 * the SDK's `_prepareRetry` (`state.messages = messages.slice(0, -1)`), so
 * `agent.continue()` re-runs the turn from the last user/toolResult message
 * with a clean history (no failed assistant left for the model to see).
 *
 * Accepts BOTH failure tails:
 *  - stopReason 'error'   — the provider returned a transient API error;
 *  - stopReason 'aborted' — the in-round stall watchdog killed a hung round
 *    mid-stream, which appends an aborted assistant message.
 * A user-aborted tail never reaches here (handleAbort tears the cycle down
 * before runRetryTurn can run), so 'aborted' here is always watchdog-kill.
 *
 * Returns false when the tail is not a failed assistant — the caller must
 * NOT continue blindly in that case.
 */
export function stripTrailingErrorAssistant(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as AutoRetryAssistantLike | undefined;
  if (!last || last.role !== 'assistant') return false;
  if (last.stopReason !== 'error' && last.stopReason !== 'aborted') return false;
  messages.length = messages.length - 1;
  return true;
}
