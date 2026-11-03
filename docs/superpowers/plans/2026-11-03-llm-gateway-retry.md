# LLM Gateway Retry Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement strategy retry count/time controls, fixed/exponential backoff, deterministic built-in error switching, zero-cooldown semantics, and the agreed 429 behavior.

**Architecture:** Keep retry policy resolution in the shared gateway planner and isolate retry-delay math in a pure shared helper so it can be deterministically tested. The gateway will own per-target attempt/deadline state and make the 429 branch explicit: positive configured local rate cooldown cools and advances immediately; zero configured cooldown retries the same target subject to retry budget and `Retry-After`. The renderer serializes the new retry fields and preset cooldown zero without changing unrelated settings.

**Tech Stack:** TypeScript, Bun tests, React renderer, shared LLM config loader/gateway, Electron renderer.

---

## Existing Worktree Constraints

- Continue on `main` because the user explicitly requested the fix on `main`.
- Preserve the existing uncommitted changes in `apps/electron/src/renderer/pages/settings/llm/helpers.ts` and `apps/electron/src/renderer/pages/settings/llm/__tests__/helpers.test.ts`; do not stage or revert them.
- Do not use `git add -A` or commit unrelated files.
- Test first for every behavior change; run the new focused test and confirm the expected failure before editing its production implementation.

## Files and Responsibilities

- `packages/shared/src/config/llm-config.ts`: retry config types; remove switch-policy types/field.
- `packages/shared/src/config/llm-config-loader.ts`: retry field validation and explicit rejection of removed `switchPolicy`; allow zero cooldown values.
- `packages/shared/src/config/llm-planner.ts`: resolved finite/unlimited retry policy and defaults.
- `packages/shared/src/config/llm-retry.ts` (new): pure fixed/exponential delay computation, jitter, Retry-After lower bound, and retry budget helpers.
- `packages/shared/src/config/gateway-stream-retry.ts`: per-route attempt/deadline state spanning truncated-stream continuation requests.
- `packages/shared/src/config/llm-key-pool.ts` and `llm-rate-limiter.ts`: no-local-cooldown behavior for explicit zero and rate-limit streak calculations.
- `packages/shared/src/config/llm-gateway.ts`: per-target attempts/deadlines; built-in error switching; 429 cooldown-positive versus cooldown-zero behavior; Retry-After handling.
- `packages/shared/src/config/__tests__/llm-planner.test.ts`, `llm-scheduling.test.ts`, `llm-gateway.test.ts`, `llm-switch-units.test.ts`, `gateway-stream-retry.test.ts`: regression coverage.
- `apps/electron/src/renderer/pages/settings/llm/types.ts`: renderer retry shape.
- `apps/electron/src/renderer/pages/settings/llm/proto/dialogs.tsx`: retry fields UI and serialization.
- `apps/electron/src/renderer/pages/settings/llm/proto/TypeCard.tsx`: cooldown zero helper text and persisted value.
- `apps/electron/src/renderer/pages/settings/llm/proto/__tests__/retrySettings.test.ts` (new): pure serialization/visibility-policy helper tests if extracted; otherwise extend the closest settings helper test.
- `docs/llm-switch-units.md`: remove switchPolicy examples and update retry/cooldown semantics.

## Task 1: Retry Policy Types, Validation, Resolution, and Delay Math

**Files:**
- Modify: `packages/shared/src/config/llm-config.ts`
- Modify: `packages/shared/src/config/llm-config-loader.ts`
- Modify: `packages/shared/src/config/llm-planner.ts`
- Create: `packages/shared/src/config/llm-retry.ts`
- Test: `packages/shared/src/config/__tests__/llm-planner.test.ts`
- Test: `packages/shared/src/config/__tests__/llm-config.test.ts`
- Test: `packages/shared/src/config/__tests__/llm-retry.test.ts` (new)

- [ ] **Step 1: Add failing retry policy resolver tests**

Cover defaults (`3`, fixed, `500ms`), finite attempts `1..5`, unlimited requiring `maxDurationSeconds`, invalid attempt/duration/mode validation, and preserve `onStatusCodes` (default `[429, 500, 502, 503, 504]`). Add validation that `switchPolicy` is rejected with a clear error.

- [ ] **Step 2: Run planner/config tests and verify expected failures**

Run: `bun test packages/shared/src/config/__tests__/llm-planner.test.ts packages/shared/src/config/__tests__/llm-config.test.ts`
Expected: failures only for the new retry shape and removed `switchPolicy` validation behavior.

- [ ] **Step 3: Add failing delay-helper tests**

Test exponential base sequence `1, 2, 4, 8, 16, 30, 30...` seconds, positive jitter bounded to 10% using an injected random function, fixed interval, Retry-After lower bound, and remaining target duration exhaustion.

- [ ] **Step 4: Run the new delay-helper tests and verify expected failures**

Run: `bun test packages/shared/src/config/__tests__/llm-retry.test.ts`
Expected: module/API missing or assertions fail because the helper is not implemented.

- [ ] **Step 5: Implement the retry types, validation, resolver, and pure delay helper**

`maxAttempts` accepts integer `1..5` or `'unlimited'`; unlimited requires integer `maxDurationSeconds` in `1..86400`. `intervalMode` accepts `'fixed' | 'exponential'`; fixed `backoffMs` is finite and non-negative. Keep `retry.onStatusCodes`. Remove the `LlmSwitchPolicy` type and `LlmStrategy.switchPolicy` field. The planner keeps a hard internal attempt guard for malformed direct callers, but the validated config allows the explicit unlimited sentinel with a duration.

- [ ] **Step 6: Run focused planner/config/delay tests**

Run: `bun test packages/shared/src/config/__tests__/llm-planner.test.ts packages/shared/src/config/__tests__/llm-config.test.ts packages/shared/src/config/__tests__/llm-retry.test.ts`
Expected: all pass.

## Task 2: Cooldown Zero and Retry-After Calculation

**Files:**
- Modify: `packages/shared/src/config/llm-key-pool.ts`
- Modify: `packages/shared/src/config/llm-rate-limiter.ts` only if needed to avoid storing/rotating on zero
- Test: `packages/shared/src/config/__tests__/llm-scheduling.test.ts`

- [ ] **Step 1: Add failing zero-cooldown tests**

Test `setCooling` with `defaultSeconds: 0`, quota `0`, and rate limit `0`: no local cooling state, no cooling count, and no implicit escalation ladder. Test positive rate-limit cooldown still escalates.

- [ ] **Step 2: Verify tests fail on current implementation**

Run: `bun test packages/shared/src/config/__tests__/llm-scheduling.test.ts`
Expected: new zero-cooldown assertions fail because cooling is currently floored to at least one second / first 429 uses the minute boundary.

- [ ] **Step 3: Implement zero as no local cooldown and separate provider hints**

When local cooldown is explicitly zero, do not apply the local rate-limit streak ladder. A valid `Retry-After` or explicit daily signal may still produce an external wait/cooldown. With positive configured rate cooldown, use the existing local escalation ladder and extend it to at least `Retry-After`; do not cap a rate-limit wait by `quotaExhaustedSeconds`. `setCooling(..., seconds=0)` must not mark cooling or reorder keys.

- [ ] **Step 4: Run focused scheduling tests**

Run: `bun test packages/shared/src/config/__tests__/llm-scheduling.test.ts`
Expected: all pass, including existing 429 escalation and keyless tests.

## Task 3: Gateway Built-in Retry and 429 Target Routing

**Files:**
- Modify: `packages/shared/src/config/llm-gateway.ts`
- Modify: `packages/shared/src/config/gateway-stream-retry.ts`
- Test: `packages/shared/src/config/__tests__/llm-gateway.test.ts`
- Test: `packages/shared/src/config/__tests__/llm-switch-units.test.ts`
- Test: `packages/shared/src/config/__tests__/gateway-stream-retry.test.ts`

- [ ] **Step 1: Add failing gateway tests for the agreed 429 split**

Add one test with `rateLimitSeconds > 0`: upstream 429, then another key or route succeeds immediately; assert retry attempts on the cooled target are not made and cooldown duration is at least the upstream hint. Add one test with `rateLimitSeconds: 0`: same target gets retried within the finite attempt budget; assert a Retry-After response delays the retry by at least the value using an injectable/testable clock or delay seam rather than a real long sleep.

- [ ] **Step 2: Run focused gateway tests and verify the new cases fail**

Run: `bun test packages/shared/src/config/__tests__/llm-gateway.test.ts -t '429'`
Expected: new branch semantics fail against the current `switchPolicy` implementation.

- [ ] **Step 3: Add per-key target attempt and duration tracking**

Reset attempts and target start time when selecting a different key. Finite attempt counts include the first call. Unlimited mode retries only until its per-target `maxDurationSeconds` expires; if a delay would exceed the remaining budget, stop retrying that target and route onward.

- [ ] **Step 4: Replace switchPolicy dispatch with built-in classification**

Remove `DEFAULT_SWITCH_POLICY`, `switchAction`, and all policy branches. Preserve `retry.onStatusCodes` for same-target server-error retries. Built-ins: transport/first-byte/eligible 5xx retry same target; auth/quota rotate key; model-not-found cool route and advance; invalid request terminates; 429 follows the configured cooldown split below.

- [ ] **Step 5: Implement the 429 cooldown split**

If the effective local `rateLimitSeconds > 0`, calculate/apply the local cooldown (extended to `Retry-After` if longer), then release and immediately select the next key; if no key remains, advance to the next route unit. This branch ignores the same-target attempt count. If local rate cooldown is exactly zero, apply no configured cooldown; apply a temporary Retry-After hold if supplied, compute the selected fixed/exponential delay with Retry-After as a minimum, and retry the same target only while attempt and duration budgets allow. When the budget is exhausted, release and select another key/route without repeating cooldown calculations.

- [ ] **Step 6: Extend stream retry continuation state**

Track per-route started-at and attempt count across truncated-stream continuation requests. Enforce the same finite/unlimited target budget and duration; once exhausted, cool according to the existing non-429 default failure handling and let the planner choose the next key/route/fallback.

- [ ] **Step 7: Run gateway and stream retry tests**

Run: `bun test packages/shared/src/config/__tests__/llm-gateway.test.ts packages/shared/src/config/__tests__/llm-switch-units.test.ts packages/shared/src/config/__tests__/gateway-stream-retry.test.ts packages/shared/src/config/__tests__/llm-transcode-gateway.test.ts`
Expected: all pass; update obsolete switchPolicy-stop tests to assert the fixed built-in route behavior.

## Task 4: Strategy Editor and Preset Cooldown UI

**Files:**
- Modify: `apps/electron/src/renderer/pages/settings/llm/types.ts`
- Modify: `apps/electron/src/renderer/pages/settings/llm/proto/dialogs.tsx`
- Modify: `apps/electron/src/renderer/pages/settings/llm/proto/TypeCard.tsx`
- Create/modify: a small pure retry form helper and its test only if needed for isolated serialization coverage.

- [ ] **Step 1: Add failing pure form tests for retry serialization**

Verify finite mode omits the duration, unlimited mode writes `maxAttempts: 'unlimited'` plus one duration, fixed mode persists seconds as milliseconds, exponential mode omits fixed `backoffMs`, and existing `onStatusCodes` survives editing.

- [ ] **Step 2: Run the new focused UI-helper test and confirm failure**

Run: `bun test apps/electron/src/renderer/pages/settings/llm/proto/__tests__/retrySettings.test.ts`
Expected: missing helper or expected new serialized shape.

- [ ] **Step 3: Implement strategy editor controls**

Rename label/helper to describe the current model/provider/key target; show options 1–5 and `无限（时限）`; only unlimited shows one duration field directly below; show an amber warning; add fixed/exponential interval selector; only fixed displays seconds; serialize exactly the canonical retry shape.

- [ ] **Step 4: Update cooldown UI copy**

Update the rate-limit, quota, and other-failure descriptions so `0` explicitly means no local cooldown. Preserve numeric zero through `draftFromConfig` and `applyTypeDrafts`; do not treat it as unset.

- [ ] **Step 5: Run Electron tests and typecheck**

Run: `bun test apps/electron/src/renderer/pages/settings/llm/proto/__tests__/retrySettings.test.ts apps/electron/src/renderer/pages/settings/llm/proto/__tests__/TypeCard.test.ts` and `bun run typecheck:electron`.
Expected: focused tests pass. Record any pre-existing unrelated typecheck errors separately.

## Task 5: Remove Switch Policy Docs and Verify End-to-End

**Files:**
- Modify: `docs/llm-switch-units.md`
- Review: `packages/shared/src/config/llm-config.ts`, `llm-config-loader.ts`, `llm-gateway.ts`, retry tests, renderer files.

- [ ] **Step 1: Update the switch-units documentation**

Remove the `switchPolicy` table/config snippet; document per-target attempts, unlimited-with-duration, fixed/exponential interval, zero cooldown, positive-cooldown 429 advancement, zero-cooldown same-target 429 retry, and Retry-After handling.

- [ ] **Step 2: Search for removed policy references**

Run: `git grep -n -E 'switchPolicy|DEFAULT_SWITCH_POLICY|LlmSwitchPolicy|LlmSwitchAction|LlmSwitchFailure' -- packages apps docs`.
Expected: no runtime/config/UI/documentation references; test name may assert explicit rejection but must not instantiate policy values.

- [ ] **Step 3: Run full relevant verification**

Run:

```bash
bun test packages/shared/src/config/__tests__/llm-gateway.test.ts packages/shared/src/config/__tests__/llm-planner.test.ts packages/shared/src/config/__tests__/llm-scheduling.test.ts packages/shared/src/config/__tests__/llm-config.test.ts packages/shared/src/config/__tests__/llm-switch-units.test.ts packages/shared/src/config/__tests__/llm-transcode-gateway.test.ts packages/shared/src/config/__tests__/gateway-stream-retry.test.ts
bun run typecheck:shared
bun test apps/electron/src/renderer/pages/settings/llm/proto/__tests__/retrySettings.test.ts apps/electron/src/renderer/pages/settings/llm/proto/__tests__/TypeCard.test.ts
cd apps/electron && ../../node_modules/.bin/eslint src/renderer/pages/settings/llm/types.ts src/renderer/pages/settings/llm/proto/dialogs.tsx src/renderer/pages/settings/llm/proto/TypeCard.tsx
bun run typecheck:electron
```

Expected: all focused shared tests, Electron UI tests and lint pass; shared typecheck passes. Report existing unrelated Electron typecheck failures if still present. Finish with `git diff --check`, inspect exact diff, verify the user's pre-existing helper/test edits remain intact, and re-read every new/edited artifact.
