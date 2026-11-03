# LLM Gateway Retry and Cooldown Redesign

**Date:** 2026-11-03  
**Status:** Approved for implementation by the user in this session.

## Goal

Make strategy retry controls describe attempts across actual provider/model/key targets; support finite or time-bounded unlimited retries; make zero cooldown disable local cooling; and make 429 behavior deterministic without user-configurable `switchPolicy`.

## Strategy editor

- Rename `单 Key 尝试次数` to `尝试次数`.
- Options are total attempts `1` through `5`, plus `无限（时限）`. Count includes the initial call (`1` = no retry).
- When `无限（时限）` is selected, display exactly one duration input directly below the attempt selector, then the retry interval controls; show an amber warning that retries on one target continue only until this duration expires.
- Unlimited target duration defaults to **300 seconds**, valid range **1–86400 seconds**.
- Retry interval mode: fixed or exponential. Fixed mode shows one interval-in-seconds input; exponential mode hides it.
- Exponential default is **1, 2, 4, 8, 16, 30, 30… seconds** with positive random jitter of **0–10%**; cap applies to the calculated exponential base, not to an upstream `Retry-After` minimum.
- Fixed mode defaults to **0.5 seconds**, preserving the existing runtime default.

## Retry config

`LlmStrategy.retry`:

```ts
retry?: {
  /** Total upstream attempts per target including the first, or 'unlimited'. */
  maxAttempts?: number | 'unlimited'
  /** Required for unlimited attempts; per-target duration in seconds. */
  maxDurationSeconds?: number
  /** Fixed wait or built-in capped exponential backoff. */
  intervalMode?: 'fixed' | 'exponential'
  /** Existing optional HTTP status allowlist for same-target server-error retries. */
  onStatusCodes?: number[]
  /** Fixed interval only, in milliseconds. */
  backoffMs?: number
}
```

Defaults: 3 attempts, fixed mode, 500ms fixed interval. The UI writes a 300s per-target duration for unlimited mode.

## Attempt target and exhaustion

- Target = one `(provider, model, key)` selection. A keyless provider target = `(provider, model)`.
- Attempt count and unlimited duration are scoped to the current target. When either is exhausted, move to another key, then the next model/provider unit or fallback according to the existing route order.
- Switching target resets attempt count and target-duration clock.

## Built-in retry classification

- Same-target retryable: connection/transport errors; first-byte timeout; HTTP 500, 502, 503, 504; stream truncation continuation; HTTP 429 only when the applicable local `rateLimitSeconds` is zero.
- HTTP 429 with positive local `rateLimitSeconds`: cool the current target and immediately advance to the next key/route target. This does not spend the same-target retry budget and does not wait for `Retry-After` before advancing. The cooldown expiry is the greater of local configured cooldown and a valid upstream `Retry-After`.
- HTTP 429 with `rateLimitSeconds === 0`: apply no local configured cooldown; retry the same target within its finite attempt/time budget, using the chosen interval. If a valid `Retry-After` exists, wait no less than it.
- HTTP 402 quota and HTTP 401/403 authentication errors: do not retry the same target; cool according to quota policy (zero means no local cooldown), then try another key/route.
- Model-not-found: cool only the provider/model route and advance to the next unit.
- Invalid client request (400 and equivalent request errors): terminal for the request; do not retry.
- Remove user-configurable `switchPolicy` from config types, schema/validation, runtime, tests, and docs. This is intentionally breaking: configuration containing `switchPolicy` is rejected with a clear error; no legacy compatibility/migration.
- Keep existing `retry.onStatusCodes` support for retryable server errors (default `[429, 500, 502, 503, 504]`). A zero-cooldown 429 is retryable regardless of this allowlist; a positive-cooldown 429 always cools and advances.

## Cooldown semantics

- Preset cooldown fields remain `rateLimitSeconds`, `quotaExhaustedSeconds`, and `defaultSeconds`.
- An explicit `0` means no local cooldown for that failure class. It does not make a non-retryable failure retryable.
- The rate-limit streak escalation ladder runs only when the local `rateLimitSeconds` is positive. It must not synthesize an implicit minute/day cooldown when the field is explicitly zero.
- `Retry-After` is never capped by `quotaExhaustedSeconds`; quota cooldown is not a ceiling for a rate-limit reset.
- Cooldown remains scoped as today: keyed providers cool the failed key; keyless providers cool only the current provider/model route. Do not add cross-model provider-wide throttle state.

## Verification

- Planner tests: finite attempts 1–5, unlimited requires a valid duration, duration clamps/rejects out-of-range, interval mode defaults and explicit values.
- Backoff tests: exponential sequence, 30s cap, deterministic injected random source for 0–10% jitter, fixed interval, and Retry-After lower bound.
- Config tests: reject removed `switchPolicy`; retain validation/support for retry status allowlists; accept retry values and zero cooldown; reject malformed retry options.
- KeyPool tests: zero rate/quota/default cooldown does not cool; positive configured cooldown works; rate-limit Retry-After is not clipped by quota cooldown; zero does not trigger implicit escalation.
- Gateway tests: 429 positive cooldown immediately advances and sets cooldown to max(local, Retry-After); 429 zero cooldown retries same target within budget and respects Retry-After; other classifications retain built-in behavior; finite/unlimited per-target expiry; keyless model-scoped cooldown; stream continuation honors per-target attempt/duration budget.
- Renderer tests: retry draft serialization; exact placement/visibility of unlimited duration and interval inputs; cooldown value 0 round-trips.
- Update `docs/llm-switch-units.md` to remove switchPolicy and document the retry ladder and cooldown rules.
