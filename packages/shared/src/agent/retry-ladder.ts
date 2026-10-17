/**
 * Unified retry ladder (user-confirmed design, 2026-10-05).
 *
 * Replaces the Pi SDK's own agent/provider retries (disabled via
 * CRAFT_PI_RETRY_ENABLED=0 in pi-agent-server) with a single Craft-owned
 * schedule: 1s → 5s → 10s → 30s → 60s → 5min → 10min, then a 10min loop
 * capped at 24h (all env-tunable).
 *
 * Error classification:
 * - transient  → full ladder + 10min loop (network, 5xx, 429, timeouts,
 *                stalls, prompt_error, unknown).
 * - deterministic → UNBOUNDED by default (2026-10-14 copper-spruce user
 *                decision: "重试改为不设限，可无限重试") — walks the full
 *                rung ladder then loops at `loopMs` (capped only by the
 *                24h `loopCapMs`). Set CRAFT_PI_RETRY_DETERMINISTIC_MAX to
 *                1..N to bound it again (1s/5s/10s… then hard stop); 0 =
 *                unlimited (4xx family, invalid model, image limits…).
 *
 * UX contract (per user decision):
 * - After the 3rd retry (the "10s" rung) fails, the error is surfaced as
 *   NON-terminal (retryPending) while retries continue in the background.
 * - Success clears the error and finishes normally; user stop / cap hit →
 *   terminal error. Deterministic errors no longer hard-stop on their own
 *   (see mode vs maxConsecutiveFailures below).
 *
 * Tunables (env now, settings panel later — every knob is read here and
 * nowhere else, so the panel only has to feed this function):
 * - CRAFT_PI_RETRY_RUNGS_MS              default 1000,5000,10000,30000,60000,300000,600000
 * - CRAFT_PI_RETRY_LOOP_MS               default 600000      (10 min loop rung)
 * - CRAFT_PI_RETRY_LOOP_CAP_MS           default 86400000    (24 h ceiling for the loop)
 * - CRAFT_PI_RETRY_SHOW_ERROR_AFTER_ATTEMPT default 3        (surface after the 10 s rung)
 * - CRAFT_PI_RETRY_DETERMINISTIC_MAX     default 0           (0 = unlimited; N = bound after N)
 */

import type { AgentError } from './errors.ts';

export type RetryErrorClass = 'transient' | 'deterministic';

export interface RetryLadderOptions {
  /** Retry delays (ms) used before the loop phase. */
  rungsMs: number[];
  /** Repeating delay (ms) after `rungsMs` is exhausted (transient; deterministic when unbounded). */
  loopMs: number;
  /** Hard ceiling from ladder start (ms); `0` = unlimited. */
  loopCapMs: number;
  /** Surface the non-terminal error once `attempts >= showErrorAfterAttempt`. */
  showErrorAfterAttempt: number;
  /** Max retries for deterministic errors. `0` = unlimited (full rung ladder, then the 10-min loop). */
  deterministicMaxAttempts: number;
  /**
   * Max CONSECUTIVE failed retries (transient class). When the ladder fires
   * `maxConsecutiveFailures` retries that ALL fail back-to-back (no success,
   * no soft-settled recovery between them), the ladder hard-stops and the
   * terminal error is surfaced instead of looping into the 10-min loop.
   * `0` = disabled (unbounded transient loop, historic behavior).
   */
  maxConsecutiveFailures: number;
  now?: () => number;
}

export function computeRetryLadderConfig(): RetryLadderOptions {
  return {
    rungsMs: parseNumList(process.env.CRAFT_PI_RETRY_RUNGS_MS, [1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000]),
    loopMs: parseNum(process.env.CRAFT_PI_RETRY_LOOP_MS, 600_000),
    loopCapMs: parseNum(process.env.CRAFT_PI_RETRY_LOOP_CAP_MS, 86_400_000),
    showErrorAfterAttempt: parseNum(process.env.CRAFT_PI_RETRY_SHOW_ERROR_AFTER_ATTEMPT, 3),
    deterministicMaxAttempts: parseNum(process.env.CRAFT_PI_RETRY_DETERMINISTIC_MAX, 0),
    maxConsecutiveFailures: parseNum(process.env.CRAFT_PI_RETRY_MAX_CONSECUTIVE, 3),
  };
}

function parseNum(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseNumList(raw: string | undefined, fallback: number[]): number[] {
  if (raw == null || raw.trim() === '') return fallback;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p) || p < 0)) return fallback;
  return parts.map((p) => Math.floor(p));
}

export interface RetryErrorSnapshot {
  message: string;
  /**
   * 2026-10-18: an INTERNAL recovery fault (turn stall / hung tool). The
   * ladder retries it exactly like a transient error, but never surfaces the
   * non-terminal error card — the turn continues in the background and the
   * user only sees the retry-status row. A terminal card still appears if the
   * ladder exhausts.
   */
  internal?: boolean;
  /**
   * Structured error when available (typed_error / parseError path). The WHOLE
   * object is carried through the ladder so the terminal card keeps its title,
   * recovery actions and diagnostics — a ladder-routed error must read exactly
   * like the same error surfaced without the ladder.
   */
  parsedError?: Partial<AgentError> | null;
}

export class RetryLadder {
  private readonly opts: Required<RetryLadderOptions>;
  private readonly now: () => number;

  private active = false;
  private mode: RetryErrorClass = 'transient';
  private attempts = 0; // retries that have been fired (and failed)
  /** Consecutive failed retries since the last success/soft-settle. */
  private consecutiveFailures = 0;
  private startedAt = 0;
  private lastError: RetryErrorSnapshot | null = null;
  private nextDelayOverride: number | null = null;
  /** 2026-10-11 (fine-cloud): set by restartCycle() — the FIRST failure of
   *  the new cycle must not increment `attempts` (a fresh ladder's first
   *  failure goes through begin(), which keeps attempts=0), so its backoff
   *  reads "等待第 1 次重试" instead of the carried-over 2. Consumed by the
   *  first onFailure(). */
  private cycleResetPending = false;

  constructor(opts: RetryLadderOptions) {
    this.opts = { ...opts, now: opts.now ?? (() => Date.now()) };
    this.now = this.opts.now;
  }

  get isActive(): boolean {
    return this.active;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  get errorClass(): RetryErrorClass {
    return this.mode;
  }

  get startedAtMs(): number {
    return this.startedAt;
  }

  get lastErrorSnapshot(): RetryErrorSnapshot | null {
    return this.lastError;
  }

  /** True when the CURRENT staged failure is an internal recovery fault. */
  get internalFailure(): boolean {
    return this.active && this.lastError?.internal === true;
  }

  /** Arm the ladder for a first failure. Deterministic errors get the short ladder. */
  begin(mode: RetryErrorClass, error: RetryErrorSnapshot): void {
    this.active = true;
    this.mode = mode;
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.startedAt = this.now();
    this.lastError = error;
    this.nextDelayOverride = null;
    this.cycleResetPending = false;
  }

  /**
   * Restore a ladder persisted before an application restart.
   * Keeps the attempt count / mode / start time so the next failure
   * continues at the rung it left off instead of restarting at 1s.
   * The caller is responsible for the 24h-cap check and for NOT scheduling
   * a timer — the restored ladder is armed-but-idle: the next error event
   * re-arms it via `onFailure()` and schedules from the restored rung.
   */
  restoreState(state: {
    mode: RetryErrorClass;
    attempts: number;
    startedAt: number;
    lastError: RetryErrorSnapshot | null;
  }): void {
    this.active = true;
    this.mode = state.mode;
    this.attempts = state.attempts;
    this.startedAt = state.startedAt;
    this.lastError = state.lastError;
    this.nextDelayOverride = null;
    this.cycleResetPending = false;
  }

  /** A retry was fired and failed — advance the ladder. */
  onFailure(error: RetryErrorSnapshot): void {
    // 2026-10-11 (fine-cloud): the first failure after restartCycle() keeps
    // attempts=0 — equivalent to a fresh begin(), so the upcoming backoff
    // reads "等待第 1 次重试" instead of the carried-over 2.
    if (this.cycleResetPending) {
      this.cycleResetPending = false;
    } else {
      this.attempts += 1;
    }
    this.consecutiveFailures += 1;
    this.lastError = error;
    this.nextDelayOverride = null;
  }

  /** A retry succeeded (retried run completed without error). */
  onSuccess(): void {
    this.active = false;
    this.attempts = 0;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.nextDelayOverride = null;
    this.cycleResetPending = false;
  }

  /**
   * 2026-10-11 (fine-cloud, user spec): a SOFT-settled recovery closes the
   * VISIBLE retry cycle — the row reads "重试 N 次后恢复" and the next failure
   * must start a NEW row whose attempt count begins at 1 ("等待第 1 次重试"),
   * with the rung schedule restarting at 1s. The ladder itself stays active
   * (the retried run is still in flight); only the failure/attempt counter
   * resets. The next onFailure() is the new cycle's first failure and must
   * not increment the counter (see cycleResetPending). Start time, error
   * class and staged error are untouched.
   */
  restartCycle(): void {
    this.attempts = 0;
    // A soft-settled recovery is a real progress signal — the consecutive
    // failure chain is broken (2026-10-14: consecutive-max guard).
    this.consecutiveFailures = 0;
    this.cycleResetPending = true;
  }

  /** Hard reset (user stop, subprocess exit, new user turn). */
  reset(): void {
    this.onSuccess();
  }

  /** Honor a `Retry-After`/`retry_after` hint from a 429-type response. */
  overrideNextDelay(retryAfterMs: number | null | undefined): void {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.nextDelayOverride = Math.floor(retryAfterMs);
    }
  }

  /**
   * Delay before the NEXT retry, or null when the ladder is exhausted
   * (deterministic capped at `deterministicMaxAttempts` > 0, consecutive-
   * failure guard for transient, or the loop cap exceeded).
   */
  nextDelayMs(now?: number): number | null {
    if (!this.active) return null;
    const at = now ?? this.now();

    // 2026-10-14 (consecutive-failure guard, transient ONLY): N consecutive
    // retries that ALL failed back-to-back (no success, no soft-settled
    // recovery) means the same request keeps failing for a reason retrying
    // will not fix (e.g. a gateway first-byte timeout on a max-thinking
    // request). Hard-stop and surface the terminal error instead of looping
    // into the 10-min loop. NOT applied to deterministic errors — the user
    // chose an UNBOUNDED ladder for those (2026-10-14 copper-spruce
    // "重试改为不设限"): a dead key must keep retrying until the upstream
    // recovers or the user stops the turn, not hard-stop at maxResumes.
    if (this.mode === 'transient' && this.opts.maxConsecutiveFailures > 0 && this.consecutiveFailures > this.opts.maxConsecutiveFailures) {
      return null;
    }

    // Deterministic: bounded only when deterministicMaxAttempts > 0 (0 =
    // unlimited). Past the cap the ladder hard-stops; otherwise the same
    // rung + loop schedule as transient applies.
    if (this.mode === 'deterministic' && this.opts.deterministicMaxAttempts > 0 && this.attempts >= this.opts.deterministicMaxAttempts) {
      return null;
    }

    // Rung phase (both classes, and bounded deterministic's 1s/5s/10s…).
    if (this.attempts < this.opts.rungsMs.length) {
      const base = this.rungAt(this.attempts)!; // attempts < length ⇒ non-null
      return this.nextDelayOverride != null ? Math.max(base, Math.min(this.nextDelayOverride, this.opts.loopMs)) : base;
    }
    if (this.opts.loopCapMs > 0 && at - this.startedAt >= this.opts.loopCapMs) return null;
    if (this.nextDelayOverride != null) return Math.min(this.nextDelayOverride, this.opts.loopMs);
    return this.opts.loopMs;
  }

  /** Whether the non-terminal error should be surfaced now (after the 10s rung). */
  get shouldSurfaceError(): boolean {
    // Internal recovery faults (stall / hung tool) stay silent: they are
    // handled in the background and must not produce an error card. The
    // terminal error on exhaustion is still surfaced by finishRetryLadder.
    return this.active && !this.internalFailure && this.attempts >= this.opts.showErrorAfterAttempt;
  }

  /** True while the ladder is in its (potentially indefinite) loop phase. */
  get isLooping(): boolean {
    return this.active && this.attempts >= this.opts.rungsMs.length;
  }

  private rungAt(index: number): number | null {
    const rung = this.opts.rungsMs[index];
    return rung == null ? null : rung;
  }
}

/**
 * Classify a parsed AgentError into ladder classes.
 * Deterministic = retrying cannot plausibly change the outcome (4xx-family /
 * model/config errors). Everything else is transient.
 */
export function classifyRetryError(code: string | undefined, message: string): RetryErrorClass {
  const deterministicCodes = new Set([
    'invalid_model',
    'model_no_tool_support',
    'data_policy_error',
    'image_too_large',
    'invalid_api_key',
    'expired_oauth_token',
    'billing_error',
    'mcp_auth_required',
    'bad_request',
    'not_found_error',
    'context_length_error',
    'permission_error',
    'content_policy_error',
    'unsupported_error',
  ]);
  if (code && deterministicCodes.has(code)) return 'deterministic';

  const low = message.toLowerCase();
  // Status-code based fallback for untyped errors.
  if (/\b(400|401|403|404)\b/.test(low) && !/\b(429|5\d\d)\b/.test(low)) {
    // 401/403/404 are deterministic; a bare 400 could be transient but is
    // almost always a payload issue — treat as deterministic (bounded retries).
    return 'deterministic';
  }
  return 'transient';
}

/**
 * 2026-10-18: a turn-stall watchdog error. It is recoverable in the background
 * (the subprocess rejects the hung tool and the retry re-runs the model step),
 * so the main process routes it to the ladder as an INTERNAL fault instead of
 * surfacing a terminal error card.
 */
export function isStallErrorMessage(message: string): boolean {
  return /(Turn stalled: no activity for \d+s|Pi agent stream stalled for \d+s)/i.test(message.trim());
}

/**
 * 2026-10-18: the subprocess refused to re-run because the transcript tail is
 * not a re-runnable model step. Retrying cannot fix this — the transcript is
 * the INPUT of every retry — so the ladder must settle terminally instead of
 * looping "Cannot retry" forever.
 */
export function isNoRerunnableStepRefusal(message: string): boolean {
  return /Cannot retry: the current turn has no re-runnable model step/i.test(message.trim());
}
