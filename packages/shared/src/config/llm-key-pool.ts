/**
 * Key pool — round_robin / sequential / weighted / least_busy / failover_only
 * with session affinity and cooldown-returns-to-position.
 *
 * Port of uni-api `rate_limit/key_pool.py`. The two behaviours that matter for
 * correctness and are easy to get subtly wrong:
 *
 * 1. **Cooldown returns the key to its original position, not the tail.**
 *    A key that 429s must rejoin where it was; otherwise a gateway with one
 *    flaky key starves every other key by cycling through them. `roundRobinIndex`
 *    is a cursor into `items`, so a cooling key simply stays unselectable and
 *    the cursor advances past it — no reordering, and its slot is intact.
 *
 * 2. **Sticky bindings self-invalidate** when the key leaves the pool, the TTL
 *    elapses, or the key becomes rate-limited / cooled. On invalidation the
 *    session migrates to a fresh key, which is logged as `sticky-migrated`.
 *    Steady-state hits stay silent so the log does not flood — only
 *    transitions are observable.
 *
 * All mutations take the pool lock, so concurrent sessions cannot interleave a
 * selection and a cooldown write.
 */

import {
  RateLimitState,
  createWindowIndex,
  secondsUntilNextMinute,
  secondsUntilNextUtcDay,
  type WindowEntry,
  type WindowIndex,
  type RateLimitRule,
} from './llm-rate-limiter.ts';
import type { LlmStrategyType } from './llm-config.ts';

export interface KeyPoolEntry {
  /** Stable key id, used for stickiness and stats. */
  id: string;
  /** Whether the key is enabled in config. Disabled keys are never selected. */
  enabled: boolean;
  /** Per-key weight for `weighted`. Defaults to 1. */
  weight: number;
}

/** Per-key cooldown durations, resolved from each key's preset. */
export interface CooldownDurations {
  defaultSeconds: number;
  rateLimitSeconds: number;
  quotaSeconds: number;
}

/** Fallback when a key has no explicit cooldown entry (no preset). */
const DEFAULT_COOLDOWNS: CooldownDurations = {
  defaultSeconds: 60,
  rateLimitSeconds: 60,
  quotaSeconds: 2592000,
};

/** A 429 older than this starts a fresh escalation ladder. */
const RATE_LIMIT_STREAK_WINDOW = 3600;

/** Upstream hints attached to a 429, used to pick the cooldown. */
export interface RateLimitSignal {
  /** Seconds from `Retry-After` or a `*-reset-*` header. */
  retryAfterSeconds?: number;
  /** The body/headers say the limit is daily/quota-level. */
  dayLevel?: boolean;
}

export interface KeyPoolOptions {
  keys: KeyPoolEntry[];
  algorithm: LlmStrategyType;
  /** Rate-limit rules per key, keyed by key id. */
  rules: Map<string, RateLimitRule[]>;
  /** Max in-flight requests per key; absent/0 means unlimited. */
  concurrency?: Map<string, number>;
  /** Clock in epoch seconds; injected for tests. */
  now?: () => number;
  stickySession?: {
    ttlSeconds?: number;
    maxEntries?: number;
  };
  /** Per-key cooldown durations (from each key's preset). Absent → DEFAULT_COOLDOWNS. */
  cooldowns?: Map<string, CooldownDurations>;
  /** Return a cooled key to its original position (default true). */
  returnToOriginalPosition?: boolean;
  log?: (message: string) => void;
}

/** Why no key could be selected, so the caller can answer 429 vs. 400 vs. 503. */
export type AllKeysUnavailableReason = 'cooling' | 'concurrency' | 'tpr';

export class AllKeysUnavailableError extends Error {
  constructor(
    public readonly model: string | null,
    public readonly reason: AllKeysUnavailableReason = 'cooling',
  ) {
    super(
      `All API keys are unavailable for model ${model ?? 'default'} (${reason})`,
    );
    this.name = 'AllKeysUnavailableError';
  }
}

/** Why a pool has no usable key right now. */
export type KeyUnavailableReason = 'cooling' | 'rate_limit' | 'concurrency';

/** Pool-level availability, with the soonest recovery the client can act on. */
export interface KeyAvailability {
  available: boolean;
  reason: KeyUnavailableReason;
  /** Seconds until that key could admit a request; 0 when available. */
  retryAfterSeconds: number;
}

/** Keep the entry that recovers soonest. */
function soonest(current: KeyAvailability | null, next: KeyAvailability): KeyAvailability {
  if (!current) return next;
  return next.retryAfterSeconds < current.retryAfterSeconds ? next : current;
}

/** One selected key plus the state the caller needs to record or roll back. */
export interface KeySelection {
  keyId: string;
  /** True when a sticky binding was reused rather than freshly assigned. */
  sticky: boolean;
  /** True when this selection migrated a session off its previous key. */
  migrated: boolean;
  /** Model the selection was made for (rules are per-model). */
  model: string;
  /**
   * Window entry reserved for this request. The caller reconciles it with the
   * response's actual token usage; omitting that leaves the estimate in place.
   */
  reservation?: WindowEntry;
}

export class KeyPool {
  /** Lock: selections and cooldown writes must not interleave. */
  private locked = false;
  private lockQueue: Array<() => void> = [];

  private items: string[];
  private readonly algorithm: LlmStrategyType;
  private cursor = 0;
  private readonly weights: Map<string, number>;

  private readonly state: RateLimitState;
  private readonly windows: WindowIndex = createWindowIndex();
  private readonly rules: Map<string, RateLimitRule[]>;
  private readonly concurrency: Map<string, number>;

  /** sessionKey -> [keyId, lastUsedEpochSeconds] */
  private readonly sticky = new Map<string, [string, number]>();
  private readonly stickyTtlSeconds: number;
  private readonly stickyMaxEntries: number;

  private readonly cooldowns: Map<string, CooldownDurations>;
  private readonly returnToPosition: boolean;
  private readonly clock: () => number;

  /** keyId -> consecutive 429 count, used to escalate the cooldown. */
  private readonly rateLimitStreak = new Map<string, { count: number; at: number }>();

  /** In-flight counters for `least_busy` and for UI display. */
  private inFlight = new Map<string, number>();

  private readonly log: (message: string) => void;

  constructor(options: KeyPoolOptions) {
    this.items = options.keys.filter(k => k.enabled).map(k => k.id);
    this.algorithm = options.algorithm;
    this.weights = new Map(options.keys.map(k => [k.id, k.weight || 1]));
    this.rules = options.rules;
    this.concurrency = options.concurrency ?? new Map();
    this.stickyTtlSeconds = options.stickySession?.ttlSeconds ?? 3600;
    this.stickyMaxEntries = options.stickySession?.maxEntries ?? 128;
    this.cooldowns = options.cooldowns ?? new Map();
    this.returnToPosition = options.returnToOriginalPosition ?? true;
    this.clock = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.state = new RateLimitState(options.now);
    this.log = options.log ?? (() => {});
  }

  // ==========================================================================
  // Locking
  // ==========================================================================

  private async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>(resolve => this.lockQueue.push(resolve));
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
      const next = this.lockQueue.shift();
      next?.();
    };
  }

  // ==========================================================================
  // Selection
  // ==========================================================================

  /**
   * Pick a key for `model`, honouring stickiness.
   *
   * Records the request in the rate-limit windows (commit) — including the
   * token estimate — and returns the reservation so the caller can reconcile it
   * with the response's real usage. The caller does not need to record it.
   */
  async next(model: string | null, sessionKey?: string, tokens = 0): Promise<KeySelection> {
    const release = await this.acquire();
    try {
      if (this.items.length === 0) throw new AllKeysUnavailableError(model);

      // --- Sticky fast path -------------------------------------------------
      let hadBinding = false;
      if (sessionKey && this.stickyTtlSeconds > 0) {
        hadBinding = this.sticky.has(sessionKey);
        const hit = this.stickyHit(sessionKey, model, tokens);
        if (hit) {
          // Selection is the reservation: counting in-flight here (instead of
          // in the caller's dispatch step) closes the race where two requests
          // both pass the capacity check before either records itself.
          this.reserve(hit.keyId);
          return {
            keyId: hit.keyId,
            sticky: true,
            migrated: false,
            model: model ?? 'default',
            reservation: hit.reservation,
          };
        }
        // Fall through to a fresh assignment; note the transition below.
        if (hadBinding) {
          this.log(`Session ${truncate(sessionKey)} sticky-migrated (previous key unusable)`);
        }
      }

      const picked = this.nextLocked(model, tokens);
      const migrated = hadBinding;

      if (sessionKey && this.stickyTtlSeconds > 0) {
        this.rememberSticky(sessionKey, picked.keyId);
        // Only log transitions — steady-state hits stay quiet.
        this.log(
          `Session ${truncate(sessionKey)} ${migrated ? 'sticky-migrated to' : 'sticky-assigned'} key ${picked.keyId}`,
        );
      }

      this.reserve(picked.keyId);
      return {
        keyId: picked.keyId,
        sticky: false,
        migrated,
        model: model ?? 'default',
        reservation: picked.reservation,
      };
    } finally {
      release();
    }
  }

  private nextLocked(model: string | null, tokens: number): { keyId: string; reservation: WindowEntry } {
    if (this.items.length === 0) throw new AllKeysUnavailableError(model);

    const startCursor = this.cursor;
    const tried = new Set<string>();
    let sawCapacity = false;
    let sawLimited = false;
    let sawTpr = false;

    // Bound the scan: each key is visited at most once.
    while (tried.size < this.items.length) {
      const keyId = this.pickCandidate(model, tried);
      // `''` is the synthetic key of a keyless provider — a valid selection, so
      // only a genuine "no candidate" (null) ends the scan.
      if (keyId === null) break;

      // At the key's concurrency ceiling: capacity pressure, not a rate limit.
      if (this.atCapacity(keyId)) {
        sawCapacity = true;
        tried.add(keyId);
        continue;
      }

      const rules = this.rulesFor(keyId);
      // A request larger than the key's single-request ceiling can never be
      // served by this key; skip it rather than sending a known-fatal call.
      if (this.state.isTprExceeded(model, tokens, rules)) {
        sawTpr = true;
        tried.add(keyId);
        continue;
      }
      const limited = this.state.isRateLimited(keyId, model, rules, this.windows, { commit: false });
      if (!limited) {
        const reservation = this.state.commitRequest(keyId, model, rules, this.windows, tokens);
        // Advance the cursor past every key we stepped over, so the next
        // request resumes after this one. Without this the pool is stuck on
        // the first key forever.
        this.cursor = (this.items.indexOf(keyId) + 1) % this.items.length;
        return { keyId, reservation };
      }
      sawLimited = true;
      tried.add(keyId);
    }

    // Restore the cursor so the next request retries from a fresh position
    // rather than wherever the failed scan stopped.
    this.cursor = startCursor;
    // Cooling wins (429 + Retry-After); otherwise capacity is retryable (503),
    // and only a request that is too large for every key is a client error.
    const reason = sawLimited
      ? 'cooling'
      : sawCapacity
        ? 'concurrency'
        : sawTpr
          ? 'tpr'
          : 'cooling';
    throw new AllKeysUnavailableError(model, reason);
  }

  /** Whether the key has as many in-flight requests as its preset allows. */
  private atCapacity(keyId: string): boolean {
    const limit = this.concurrency.get(keyId) ?? 0;
    return limit > 0 && this.inFlightFor(keyId) >= limit;
  }

  /** Candidate order for the current algorithm. */
  private candidateOrder(): string[] {
    switch (this.algorithm) {
      case 'sequential':
      case 'failover_only':
        // Always the config order: these types only advance when the user (or a
        // cooldown) makes the head unusable.
        return this.items;
      case 'weighted': {
        // Expand by weight: weight 3 -> id appears 3x, so a plain scan over
        // the expanded list yields the right distribution without PRNG noise.
        // Rebuilt from the head each call so a skipping selection cannot skew
        // the ratio.
        const out: string[] = [];
        for (const id of this.items) {
          const w = Math.max(1, this.weights.get(id) ?? 1);
          for (let i = 0; i < w; i++) out.push(id);
        }
        return out;
      }
      case 'least_busy': {
        return [...this.items].sort((a, b) => this.inFlightFor(a) - this.inFlightFor(b));
      }
      case 'round_robin':
      default: {
        // Rotate the list so the cursor starts at the current position.
        const head = this.items.slice(this.cursor);
        const tail = this.items.slice(0, this.cursor);
        return [...head, ...tail];
      }
    }
  }

  private pickCandidate(model: string | null, alreadyTried: Set<string>): string | null {
    for (const id of this.candidateOrder()) {
      if (alreadyTried.has(id)) continue;
      if (this.state.isCooling(id)) continue;
      return id;
    }
    return null;
  }

  private inFlightFor(id: string): number {
    return this.inFlight.get(id) ?? 0;
  }

  // ==========================================================================
  // Sticky sessions
  // ==========================================================================

  /**
   * Return the pinned key for a session if still usable, else null.
   *
   * A binding expires when: the key left the pool, the TTL elapsed, or the key
   * is cooling / rate-limited. Expiry pops the binding so the session migrates.
   */
  private stickyHit(
    sessionKey: string,
    model: string | null,
    tokens: number,
  ): { keyId: string; reservation: WindowEntry } | null {
    const bound = this.sticky.get(sessionKey);
    if (!bound) return null;
    const [item, ts] = bound;
    if (!this.items.includes(item)) {
      this.sticky.delete(sessionKey);
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (now - ts > this.stickyTtlSeconds) {
      this.sticky.delete(sessionKey);
      return null;
    }
    const rules = this.rulesFor(item);
    if (this.atCapacity(item) || this.state.isTprExceeded(model, tokens, rules)) {
      this.sticky.delete(sessionKey);
      return null;
    }
    if (this.state.isRateLimited(item, model, rules, this.windows, { commit: false })) {
      this.sticky.delete(sessionKey);
      return null;
    }
    // A sticky hit is a real request: commit it, otherwise every session that
    // stays pinned would bypass RPM/RPD/TPM entirely.
    const reservation = this.state.commitRequest(item, model, rules, this.windows, tokens);
    // Refresh the timestamp so an active session is never evicted mid-conversation.
    this.sticky.set(sessionKey, [item, now]);
    return { keyId: item, reservation };
  }

  private rememberSticky(sessionKey: string, item: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.sticky.set(sessionKey, [item, now]);

    if (this.sticky.size <= this.stickyMaxEntries) return;

    // Evict by age first — a session active within the TTL should never be
    // evicted while a long-idle binding exists.
    for (const [k, [, ts]] of this.sticky) {
      if (now - ts > this.stickyTtlSeconds) this.sticky.delete(k);
    }
    // Still over capacity: drop the oldest bindings.
    if (this.sticky.size > this.stickyMaxEntries) {
      const excess = this.sticky.size - this.stickyMaxEntries;
      const ordered = [...this.sticky.entries()].sort((a, b) => a[1][1] - b[1][1]);
      for (const [k] of ordered.slice(0, excess)) this.sticky.delete(k);
    }
  }

  // ==========================================================================
  // Cooldown
  // ==========================================================================

  /**
   * Cool a key down.
   *
   * `reason` selects the duration. `returnToOriginalPosition` is honoured by
   * NOT touching the item order: the key stays in `items` at its original
   * index and simply becomes unselectable, so when the cooldown expires it
   * appears back in its old rotation slot. Reordering (which is what would
   * push it to the tail) is deliberately not implemented.
   */
  async setCooling(
    keyId: string,
    reason: 'quota' | 'default' = 'default',
    secondsOverride?: number,
  ): Promise<number> {
    const release = await this.acquire();
    try {
      const durations = this.cooldowns.get(keyId) ?? DEFAULT_COOLDOWNS;
      const seconds = secondsOverride ?? (
        reason === 'quota' ? durations.quotaSeconds : durations.defaultSeconds
      );
      this.applyCooling(keyId, seconds);
      return Math.max(1, Math.floor(seconds));
    } finally {
      release();
    }
  }

  /**
   * Compute (and record the 429 streak for) the rate-limit cooldown for `keyId`
   * without applying it.
   *
   * A keyless provider's synthetic `''` key is shared by every model on the
   * relay, so a 429 for one model must not cool that shared key — cooling it
   * would take every other model down with it and defeat the model-level
   * switch. The gateway calls this to learn the escalation duration and then
   * scopes the cooldown to the *route* instead of the key.
   */
  async rateLimitSeconds(keyId: string, signal: RateLimitSignal = {}): Promise<number> {
    const release = await this.acquire();
    try {
      return this.computeRateLimitSeconds(keyId, signal, this.clock());
    } finally {
      release();
    }
  }

  /**
   * Cool a key after a 429, escalating when the same key keeps failing.
   *
   * The unit is the key itself — or the provider when it has no keys (the
   * synthetic `''` slot), because a keyless endpoint is one account. A key
   * shared with another client keeps 429ing on its own and escalates without
   * dragging healthy keys of the same provider down with it.
   *
   * Ladder when the upstream gives no hint:
   *   1st → until the next minute boundary (an RPM window usually resets then)
   *   2nd → the preset's `rateLimitSeconds` (60s default)
   *   3rd → max(5× `rateLimitSeconds`, 300s)
   *   4th+ → until the next UTC midnight (a shared/daily quota is exhausted)
   *
   * A `Retry-After`/`*-reset-*` hint wins over the ladder; a daily body hint
   * skips straight to the day boundary. Any successful response resets the
   * ladder via {@link noteSuccess}.
   */
  async setRateLimited(keyId: string, signal: RateLimitSignal = {}): Promise<number> {
    const release = await this.acquire();
    try {
      const seconds = this.computeRateLimitSeconds(keyId, signal, this.clock());
      this.applyCooling(keyId, seconds);
      return seconds;
    } finally {
      release();
    }
  }

  /**
   * The escalation ladder shared by {@link rateLimitSeconds} and
   * {@link setRateLimited}. Caller must hold the pool lock.
   */
  private computeRateLimitSeconds(
    keyId: string,
    signal: RateLimitSignal,
    now: number,
  ): number {
    const durations = this.cooldowns.get(keyId) ?? DEFAULT_COOLDOWNS;
    const prev = this.rateLimitStreak.get(keyId);
    const count = prev && now - prev.at <= RATE_LIMIT_STREAK_WINDOW ? prev.count + 1 : 1;
    this.rateLimitStreak.set(keyId, { count, at: now });

    let seconds: number;
    if (typeof signal.retryAfterSeconds === 'number' && signal.retryAfterSeconds > 0) {
      seconds = signal.retryAfterSeconds;
    } else if (signal.dayLevel) {
      seconds = secondsUntilNextUtcDay(now);
    } else if (count === 1) {
      seconds = secondsUntilNextMinute(now);
    } else if (count === 2) {
      seconds = durations.rateLimitSeconds;
    } else if (count === 3) {
      seconds = Math.max(durations.rateLimitSeconds * 5, 300);
    } else {
      seconds = secondsUntilNextUtcDay(now);
    }
    return Math.max(1, Math.min(Math.floor(seconds), durations.quotaSeconds));
  }

  /** Reset a key's 429 escalation after a successful response. */
  noteSuccess(keyId: string): void {
    this.rateLimitStreak.delete(keyId);
  }

  /** Apply a cooldown and honour `returnToOriginalPosition`. Caller holds the lock. */
  private applyCooling(keyId: string, seconds: number): void {
    this.state.setCooling(keyId, Math.max(1, Math.floor(seconds)));
    if (!this.returnToPosition) {
      // With return-to-position off, move the key to the end so the cursor does
      // not keep skipping it.
      const idx = this.items.indexOf(keyId);
      if (idx >= 0) {
        this.items.splice(idx, 1);
        this.items.push(keyId);
      }
    }
  }

  async clearCooling(keyId: string): Promise<void> {
    const release = await this.acquire();
    try {
      this.state.clearCooling(keyId);
    } finally {
      release();
    }
  }

  /** Snapshot of keys still cooling: keyId -> epoch-seconds until expiry. */
  exportCooling(): Map<string, number> {
    return this.state.exportCooling();
  }

  /** Restore cooling state (after app restart / config rebuild). */
  importCooling(entries: Map<string, number> | Record<string, number>): void {
    this.state.importCooling(entries);
  }

  /** Whether every key for this model is unavailable. */
  async isAllUnavailable(model: string | null): Promise<boolean> {
    return !(await this.availability(model)).available;
  }

  /**
   * Whether any key can serve `model`, and if not, why and for how long.
   *
   * The gateway needs more than a boolean here: "every key is out of quota"
   * must answer 429 with a real Retry-After, while "every key is cooling after
   * upstream failures" stays 503. The reported cause/recovery belongs to the
   * soonest-recovering key — a client retrying then has a live key to hit.
   */
  async availability(model: string | null): Promise<KeyAvailability> {
    const release = await this.acquire();
    try {
      if (this.items.length === 0) {
        return { available: false, reason: 'cooling', retryAfterSeconds: 0 };
      }
      let best: KeyAvailability | null = null;
      for (const id of this.items) {
        if (this.state.isCooling(id)) {
          best = soonest(best, {
            available: false,
            reason: 'cooling',
            retryAfterSeconds: this.state.remainingCooldown(id),
          });
          continue;
        }
        if (this.atCapacity(id)) {
          // In-flight requests drain on their own; 1s is a floor, not a guess at
          // the upstream's latency.
          best = soonest(best, { available: false, reason: 'concurrency', retryAfterSeconds: 1 });
          continue;
        }
        const rules = this.rulesFor(id);
        if (this.state.isRateLimited(id, model, rules, this.windows, { commit: false })) {
          best = soonest(best, {
            available: false,
            reason: 'rate_limit',
            retryAfterSeconds: this.state.secondsUntilRateLimitClears(id, model, rules, this.windows),
          });
          continue;
        }
        return { available: true, reason: 'rate_limit', retryAfterSeconds: 0 };
      }
      return best ?? { available: false, reason: 'cooling', retryAfterSeconds: 0 };
    } finally {
      release();
    }
  }

  // ==========================================================================
  // In-flight tracking (least_busy + UI)
  // ==========================================================================

  /** Reserve an in-flight slot for a selected key. Caller holds the lock. */
  private reserve(keyId: string): void {
    this.inFlight.set(keyId, (this.inFlight.get(keyId) ?? 0) + 1);
  }

  /** Release the slot reserved by {@link next}. */
  finishRequest(keyId: string): void {
    const n = (this.inFlight.get(keyId) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(keyId);
    else this.inFlight.set(keyId, n);
  }

  /**
   * Replace a reservation's pre-dispatch token estimate with the measured
   * usage, so TPM/TPD windows reflect what the request actually cost.
   */
  reconcileTokens(reservation: WindowEntry, tokens: number): void {
    this.state.reconcile(reservation, tokens);
  }

  // ==========================================================================
  // Introspection (drives the UI)
  // ==========================================================================

  /** Per-key state snapshot. */
  snapshot(model?: string | null): Array<{
    keyId: string;
    cooling: boolean;
    cooldownRemaining: number;
    inFlight: number;
    available: boolean;
    weight: number;
  }> {
    const cooling = this.state.coolingItems();
    return this.items.map(id => {
      const rules = this.rulesFor(id);
      const coolingRemaining = cooling.get(id) ?? 0;
      const rateLimited = this.state.isRateLimited(id, model ?? null, rules, this.windows, { commit: false });
      return {
        keyId: id,
        cooling: coolingRemaining > 0,
        cooldownRemaining: coolingRemaining,
        inFlight: this.inFlightFor(id),
        // At the concurrency ceiling the key is temporarily unselectable too;
        // the table should show that rather than implying spare capacity.
        available: coolingRemaining === 0 && !rateLimited && !this.atCapacity(id),
        weight: this.weights.get(id) ?? 1,
      };
    });
  }



  // ==========================================================================
  // Internals
  // ==========================================================================

  private rulesFor(keyId: string): RateLimitRule[] {
    return this.rules.get(keyId) ?? [];
  }
}

function truncate(value: string, max = 12): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
