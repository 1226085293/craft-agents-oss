/**
 * Rate limiting + cooldown state.
 *
 * Port of uni-api `rate_limit/state.py` + `rate_limit/policy.py`, keeping the
 * exact semantics that the gateway's correctness depends on:
 *
 * - **Windows are sliding or fixed, chosen per rule.** A sliding `10/min`
 *   counts requests in the last 60 seconds, so a burst at the window edge
 *   cannot get 2x the quota by straddling a bucket boundary. A fixed
 *   `rule.fixed` window resets at the UTC-aligned boundary of its period
 *   (midnight for 24 hours), matching how upstreams reset daily quotas.
 * - **Requests and tokens are separate metrics.** A request rule counts window
 *   entries; a token rule sums `tokens` on those same entries.
 * - **Cooldown is separate from rate limiting.** A key can be perfectly under
 *   quota and still be cooling down after a quota-exhausted response; conflating
 *   the two caused the 600s ping-pong that kept re-serving dead keys.
 * - **TPR (tokens per request) is a single ceiling, not a window.**
 * - **`commit` is explicit.** Selection checks without recording; only a real
 *   dispatch records, and the entry is reconciled with measured usage later.
 */

import type { LlmPreset } from './llm-config.ts';

// ============================================================================
// Policy
// ============================================================================

/** Window periods, in seconds. */
export const TPR_PERIOD = -1;

/** What a rule counts: individual requests, or input+output tokens. */
export type RateMetric = 'requests' | 'tokens';

export interface RateLimitRule {
  count: number;
  periodSeconds: number;
  /**
   * Defaults to `'requests'`. Token rules (`tpm`/`tpd`/legacy `/tpr`) sum the
   * `tokens` carried by each window entry instead of counting entries.
   */
  metric?: RateMetric;
  /**
   * When `true` the window is fixed: it resets at the UTC boundary of its
   * period (24-hour period → UTC midnight; 60-second period → each minute).
   * Absent or `false` = sliding window (the last N seconds).
   */
  fixed?: boolean;
}

/**
 * Parse uni-api's `api_key_rate_limit` string (`"50/min, 2000000/tpr"`).
 * Recognised units: /min /s /hour /day /tpr. TPR is encoded as period `-1`.
 *
 * Everything except `/tpr` is a request count in uni-api; `/tpr` is a token
 * ceiling for one request, so it is tagged as a token rule.
 */
export function parseRateLimit(value: string | undefined): RateLimitRule[] {
  if (!value) return [];
  const rules: RateLimitRule[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawCount, rawUnit] = trimmed.split('/');
    const count = Number.parseInt(rawCount?.trim() ?? '', 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    const unit = rawUnit?.trim().toLowerCase() ?? '';
    let periodSeconds: number;
    let metric: RateMetric = 'requests';
    if (unit === 'tpr') {
      periodSeconds = TPR_PERIOD;
      metric = 'tokens';
    } else if (unit === 'min') periodSeconds = 60;
    else if (unit === 's') periodSeconds = 1;
    else if (unit === 'hour') periodSeconds = 3600;
    else if (unit === 'day') periodSeconds = 86400;
    else periodSeconds = 60;
    rules.push({ count, periodSeconds, metric });
  }
  return rules;
}

/**
 * Rules for one model, falling back to the `default` bucket.
 *
 * The preset's windows are the authority. The legacy `parseRateLimit` string is
 * only consulted when the preset defines none, which keeps a config migrated
 * from uni-api working without a rewrite.
 */
export function rulesForModel(
  preset: LlmPreset | undefined,
  legacyString: string | undefined,
): RateLimitRule[] {
  if (preset) {
    const rules: RateLimitRule[] = [];
    if (typeof preset.tpr === 'number' && preset.tpr > 0) rules.push({ count: preset.tpr, periodSeconds: TPR_PERIOD, metric: 'tokens' });
    // Every configured window is enforced: they are additive ceilings, never
    // alternatives.
    for (const limit of preset.customLimits ?? []) {
      const periodSeconds = limit.per * (limit.perUnit === 'hours' ? 3600 : limit.perUnit === 'minutes' ? 60 : 1);
      if (!(limit.amount > 0) || !(periodSeconds > 0)) continue;
      rules.push({
        count: limit.amount,
        periodSeconds,
        metric: limit.unit === 'requests' ? 'requests' : 'tokens',
        // `sliding: false` is the only case that turns the window into a
        // fixed (UTC-boundary-reset) window; the field default is sliding.
        fixed: limit.sliding === false ? true : undefined,
      });
    }
    if (rules.length > 0) return rules;
  }
  return parseRateLimit(legacyString);
}

// ============================================================================
// Time helpers
// ============================================================================

/** Seconds until the next wall-clock minute (1..60). */
export function secondsUntilNextMinute(now: number): number {
  const rem = now % 60;
  return rem === 0 ? 60 : 60 - rem;
}

/** Seconds until the next UTC midnight (1..86400). */
export function secondsUntilNextUtcDay(now: number): number {
  const rem = now % 86400;
  return rem === 0 ? 86400 : 86400 - rem;
}

/**
 * Window store key for one period, encoding whether it is fixed or sliding.
 *
 * A 60-second fixed window (resets every wall-clock minute) and a 60-second
 * sliding window (the last 60 seconds) count the same entries but reset on
 * different schedules, so they must be stored separately.
 */
function windowKey(periodSeconds: number, fixed: boolean): string {
  return fixed ? `f:${periodSeconds}` : String(periodSeconds);
}

/**
 * Fixed window: the last UTC-aligned period boundary, e.g. the start of the
 * current minute for a 60-second period, or UTC midnight for 86400.
 */
function fixedWindowStart(now: number, periodSeconds: number): number {
  return now - (now % periodSeconds);
}

// ============================================================================
// State
// ============================================================================

type Clock = () => number;

/**
 * One committed request: when it happened and how many tokens it cost.
 *
 * The same object is pushed into every active window for the request, so a
 * post-response reconciliation (`entry.tokens = actual`) updates all of them at
 * once without having to find each copy.
 */
export interface WindowEntry {
  ts: number;
  tokens: number;
}

/**
 * Windowed entries keyed by [item][model][windowKey].
 *
 * `windowKey` is a string: `"f:86400"` (fixed 24-hour) vs `"86400"` (sliding 24-hour),
 * so a fixed and a sliding window of the same period never share an entry list.
 * `Map`/`Map`/`Map` rather than a flat key so pruning one period stays O(k).
 */
export type WindowIndex = Map<string, Map<string, Map<string, WindowEntry[]>>>;

export class RateLimitState {
  private readonly now: Clock;
  /** item -> epoch-seconds until which the key is cooling down. */
  private coolingUntil = new Map<string, number>();

  constructor(now: Clock = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
  }

  /** Mark a key as cooling down for `seconds` from now. */
  setCooling(item: string, seconds: number): void {
    // `''` is the synthetic slot of a keyless provider — a real unit that must
    // be coolable, so an empty id is not rejected here.
    this.coolingUntil.set(item, this.now() + Math.max(0, Math.floor(seconds)));
  }

  /** Remaining cooldown in seconds; 0 when not cooling. */
  remainingCooldown(item: string): number {
    const until = this.coolingUntil.get(item);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    return remaining > 0 ? remaining : 0;
  }

  clearCooling(item: string): void {
    this.coolingUntil.delete(item);
  }

  /**
   * Snapshot of items still cooling: item -> epoch-seconds until expiry.
   *
   * Exported for persistence across app restarts (see `llm-cooldown-store`).
   * Only live entries are returned; expired ones are dropped by the iterator.
   */
  exportCooling(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [item, until] of this.coolingUntil) {
      if (until > this.now()) out.set(item, until);
    }
    return out;
  }

  /**
   * Restore cooling state (e.g. after an app restart). Entries whose expiry
   * has already passed are dropped so a stale cooldown never blocks traffic.
   */
  importCooling(entries: Map<string, number> | Record<string, number>): void {
    const now = this.now();
    for (const [item, until] of Object.entries(entries)) {
      const u = Number(until);
      if (Number.isFinite(u) && u > now) this.coolingUntil.set(item, Math.floor(u));
    }
  }

  /** All items still cooling, with remaining seconds. */
  coolingItems(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [item, remaining] of this.coolingItemsWithRemaining()) out.set(item, remaining);
    return out;
  }

  private *coolingItemsWithRemaining(): Generator<[string, number]> {
    const now = this.now();
    for (const [item, until] of this.coolingUntil) {
      const remaining = until - now;
      if (remaining > 0) yield [item, remaining];
      else this.coolingUntil.delete(item);
    }
  }

  isCooling(item: string): boolean {
    return this.remainingCooldown(item) > 0;
  }

  /**
   * Whether one more request is allowed.
   *
   * `commit` records the request in every window, carrying `tokens` for the
   * token rules. Callers that are merely probing must pass `commit: false`, or a
   * dry run would burn quota.
   */
  isRateLimited(
    item: string,
    model: string | null,
    rules: RateLimitRule[],
    windows: WindowIndex,
    { commit, tokens = 0 }: { commit: boolean; tokens?: number },
  ): boolean {
    const now = this.now();
    if (this.isCooling(item)) return true;

    const modelKey = model || 'default';
    const byModel = windows.get(item) ?? new Map<string, Map<string, WindowEntry[]>>();
    if (!windows.has(item)) windows.set(item, byModel);
    const requestWindows = byModel.get(modelKey) ?? new Map<string, WindowEntry[]>();
    if (!byModel.has(modelKey)) byModel.set(modelKey, requestWindows);

    // Prune only the windows this rule set actually uses. Fixed windows drop
    // everything before the last UTC-aligned boundary; sliding ones slide by
    // their period.
    const positivePeriods = new Set(
      rules.filter(r => r.periodSeconds > 0).map(r => windowKey(r.periodSeconds, !!r.fixed)),
    );
    for (const key of positivePeriods) {
      const [f, p] = key.startsWith('f:') ? [true, Number(key.slice(2))] : [false, Number(key)];
      const period = p;
      const cutoff = f ? fixedWindowStart(now, period) : now - period;
      const window = requestWindows.get(key) ?? [];
      while (window.length > 0 && window[0]!.ts <= cutoff) window.shift();
      requestWindows.set(key, window);
    }

    for (const rule of rules) {
      if (rule.periodSeconds <= 0) continue;
      const key = windowKey(rule.periodSeconds, !!rule.fixed);
      const window = requestWindows.get(key) ?? [];
      const used = rule.metric === 'tokens'
        ? window.reduce((sum, entry) => sum + entry.tokens, 0)
        : window.length;
      if (used >= rule.count) return true;
    }

    if (commit) this.commitRequest(item, model, rules, windows, tokens);
    return false;
  }

  /**
   * Seconds until `item` could admit one more request.
   *
   * Returns 0 when a request would be admitted right now, and the remaining
   * cooldown when the item is cooling. For a saturated window it is the time
   * until enough of the oldest entries age out — the number a 429 needs in
   * `Retry-After`, instead of making the client guess or wait for a full minute
   * when the window frees in three seconds.
   *
   * Concurrency is not considered: it depends on in-flight requests, not time.
   */
  secondsUntilRateLimitClears(
    item: string,
    model: string | null,
    rules: RateLimitRule[],
    windows: WindowIndex,
  ): number {
    const cooling = this.remainingCooldown(item);
    if (cooling > 0) return cooling;

    const now = this.now();
    const modelKey = model || 'default';
    const requestWindows = windows.get(item)?.get(modelKey);
    if (!requestWindows) return 0;

    let wait = 0;
    for (const rule of rules) {
      if (rule.periodSeconds <= 0) continue;
      const key = windowKey(rule.periodSeconds, !!rule.fixed);
      const window = requestWindows.get(key) ?? [];
      const cost = (entry: WindowEntry): number => (rule.metric === 'tokens' ? entry.tokens : 1);
      let used = window.reduce((sum, entry) => sum + cost(entry), 0);
      if (used < rule.count) continue;
      // Entries are chronological, so expire them oldest-first until the window
      // has room; the expiry of the last dropped entry is when room appears.
      for (const entry of window) {
        used -= cost(entry);
        const expiresAt = rule.fixed
          ? fixedWindowStart(now, rule.periodSeconds) + rule.periodSeconds
          : entry.ts + rule.periodSeconds;
        if (used < rule.count) {
          wait = Math.max(wait, expiresAt - now);
          break;
        }
      }
    }
    return Math.max(0, Math.ceil(wait));
  }

  /**
   * Record one request in every active window and return its entry.
   *
   * The entry is shared across windows so {@link reconcile} can correct the
   * token estimate once the upstream reports actual usage. Assumes the caller
   * has already checked that the request is allowed.
   */
  commitRequest(
    item: string,
    model: string | null,
    rules: RateLimitRule[],
    windows: WindowIndex,
    tokens: number,
  ): WindowEntry {
    const now = this.now();
    const modelKey = model || 'default';
    const byModel = windows.get(item) ?? new Map<string, Map<string, WindowEntry[]>>();
    if (!windows.has(item)) windows.set(item, byModel);
    const requestWindows = byModel.get(modelKey) ?? new Map<string, WindowEntry[]>();
    if (!byModel.has(modelKey)) byModel.set(modelKey, requestWindows);

    const entry: WindowEntry = { ts: now, tokens: Math.max(0, Math.round(tokens)) };
    // A 60-second fixed window and a 60-second sliding window share the same
    // entry but reset on different schedules, so dedupe by window key, not by
    // period.
    const keys = new Set<string>();
    for (const rule of rules) {
      if (rule.periodSeconds > 0) keys.add(windowKey(rule.periodSeconds, !!rule.fixed));
    }
    for (const key of keys) {
      const window = requestWindows.get(key) ?? [];
      window.push(entry);
      requestWindows.set(key, window);
    }
    return entry;
  }

  /**
   * Replace a committed request's token estimate with the measured usage.
   *
   * Mutating the shared entry corrects every window in one write.
   */
  reconcile(entry: WindowEntry, tokens: number): void {
    entry.tokens = Math.max(0, Math.round(tokens));
  }

  /**
   * Whether `tokens` exceeds the single-request ceiling.
   *
   * Deliberately does NOT consult the windows: a TPR breach is about one
   * request's size, so it is checked before dispatch and never recorded.
   */
  isTprExceeded(model: string | null, tokens: number, rules: RateLimitRule[]): boolean {
    if (!tokens) return false;
    for (const rule of rules) {
      // TPR is inherently a token ceiling, so the metric tag is irrelevant here.
      if (rule.periodSeconds === TPR_PERIOD && tokens > rule.count) return true;
    }
    return false;
  }

}

/** Fresh window store. Exported so owners can reset between requests. */
export function createWindowIndex(): WindowIndex {
  return new Map();
}
