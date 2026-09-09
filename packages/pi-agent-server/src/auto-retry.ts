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

export type AutoRetryErrorClass = 'transient' | 'permanent';

/**
 * Classify an assistant error message for the auto-retry loop.
 * Permanent patterns win over transient ones (a 429 response that also
 * mentions billing is billing). Unknown errors default to transient.
 */
export function classifyAutoRetryError(errorText: string | null | undefined): AutoRetryErrorClass {
  if (!errorText) return 'transient';
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(errorText)) return 'permanent';
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
