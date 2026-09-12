# LLM compatibility notes

This document records LLM-endpoint compatibility incidents encountered when
running Craft Agent against a custom OpenAI-compatible proxy (LiteLLM), and the
fixes applied so the same issues are not repeated.

## Background

Custom endpoint connections (`customEndpoint.api: "openai-completions"`) build a
synthetic model definition via `buildCustomEndpointModelDef` in
`packages/pi-agent-server/src/custom-endpoint-models.ts`. Because we cannot query
the endpoint for its real capabilities, the synthetic definition must declare
intent explicitly, and the declared values must be safe for *every* upstream
model behind the proxy.

The Pi SDK (`@earendil-works/pi-ai`) decides request shape from two fields on the
model definition:

- `model.reasoning` — gates whether `reasoning_effort` / thinking level is sent.
- `model.compat.supportsDeveloperRole` — gates whether the system prompt is sent
  as the `developer` role instead of `system`.

Detection (`pi-ai` auto-detects compat from the base URL) leaves
`supportsDeveloperRole` enabled for standard OpenAI-compatible URLs, which is
wrong for endpoints that terminate at a model rejecting the `developer` role.

## Incident 1: `400 developer is not one of [...]` (2026-08-22)

### Symptom

Craft replies were slow / silent. The LiteLLM proxy log showed repeated:

```text
OpenAIException - Error code: 400 - {'error': {'message':
"the request is invalid: developer is not one of ['system', 'assistant', 'user', 'tool', 'function']
- 'messages.['0].role'. ...", 'code': '400001'}}
```

with `LiteLLM Retried: 1 times` on each. Every conversation turn hit the 400,
retried, and occasionally also hit empty-stream / TPM-429 symptoms — compounding
into intermittent failures.

### Root cause

`buildCustomEndpointModelDef` declared `reasoning: true` (required so the user's
session `thinkingLevel` actually reaches the request — see Incident 2), but did
**not** pin `compat.supportsDeveloperRole`. With `reasoning: true` and detected
`compat.supportsDeveloperRole` defaulting to enabled, `pi-ai`
(`openai-completions.js`) emitted:

```js
const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
const role = useDeveloperRole ? "developer" : "system";
```

The upstream model behind the proxy (stealth / ox-alpha) rejects the `developer`
role → hard 400 on every request.

### Fix

Pin the role explicitly in the synthetic definition:

```ts
return {
  id,
  name: id,
  reasoning: true,
  compat: { supportsDeveloperRole: false },   // ← required for custom endpoints
  input,
  // ...
}
```

With `supportsDeveloperRole: false`, `pi-ai` selects `role = "system"`, which the
upstream model accepts. The `dist` build was regenerated and the server restarted;
the 400s stopped immediately.

The equivalent runtime guard is already present in the bundled `dist/index.js`:

```js
const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
```

### Prevention

- Custom endpoints must **always** set `compat.supportsDeveloperRole: false`
  unless the upstream is confirmed to accept the `developer` role.
- Do not rely on `pi-ai` detected compat for custom endpoints — detection assumes
  a standard OpenAI model and is wrong for relay-terminated models.
- When adding new `compat.*` flags to the synthetic definition, verify the
  upstream's accepted request schema, not just OpenAI's.

## Incident 2: empty reply / `finish_reason=length` truncation (2026-08-22)

### Symptom

Even after the 400 was fixed, some turns returned an empty visible reply with
`finish_reason=length` despite the model producing hidden reasoning.

### Root cause

The historical `maxTokens` default for synthetic custom-endpoint models was
`8_192`. Reasoning-style models consume most of that budget on hidden
`reasoning_content`, leaving nothing for the visible assistant message → silent
truncation.

### Fix

Raised the default to a moderate `65_536` (`DEFAULT_MAX_TOKENS`) and exposed a
per-model `maxTokens` override in the model config:

```ts
export const DEFAULT_MAX_TOKENS = 65_536
// ...
maxTokens: overrides?.maxTokens ?? DEFAULT_MAX_TOKENS,
```

Kept moderate (not a huge global value) because some strict OpenAI-compatible
backends reject oversized `max_tokens` parameters outright. Generous endpoints
should override per model via `models: [{ id, maxTokens }]` in `config.json`.

### Prevention

- Treat `8_192` as unsafe for any reasoning-capable custom endpoint.
- Prefer per-model `maxTokens` overrides over a very large global default to
  stay compatible with strict backends.

## Incident 3: `terminated` errors and stale `💭 thinking…` bubble (2026-09-05)

### Symptom

Telegram runs showed repeated `❌ terminated` errors mid-tool-chain and a
`💭 thinking…` progress bubble that never cleared. Session logs contained
`Context compaction failed: ... terminated`, `completed without assistant
response`, and `Processing stopped ...: complete`. Several terminations
occurred ~121 s after request start (matches the 120 s HTTP idle timeout in
`pi-agent-server` and `CALLBACK_TOOL_TIMEOUT_MS` in `session-mcp-server`).

### Root cause (three stacked gaps)

1. **Silent complete swallowed non-400 API errors.**
   `SessionManager`'s complete handler only surfaced captured API errors when
   `apiError.status === 400`; a run ending with no assistant reply due to a 5xx
   or relay fault was still finalized as `reason: 'complete'`, so both the UI
   and the defense evaluator treated it as a healthy finish.

2. **Retryable Pi errors were reported immediately.**
   For retryable failures the Pi SDK sequence is
   `message_end(stopReason: error)` → `agent_end(willRetry: true)` →
   `auto_retry_start` → successful retry. The event adapter yielded
   `error`/`typed_error` at `message_end`, so Telegram posted `❌ terminated`
   before a retry that usually succeeded.

3. **Renderer error path missed restart-recovered bubbles.**
   `handleError` sent the `❌` text **before** deleting the progress bubble; if
   that send threw (or the app restarted between bubble post and terminal
   event — the persisted state file was never hydrated on the error path),
   cleanup was skipped and the bubble stayed in the chat forever.

### Fixes

- `packages/server-core/src/sessions/SessionManager.ts` — complete handler
  surfaces **any** captured API error (`getLastApiError` has no status filter
  now). 400 image errors keep their dedicated branch; everything else is
  classified via `parseError` (5xx → `service_error`, 429 → `rate_limited`,
  401 → auth codes that can trigger the auth-retry pipeline).
- `packages/messaging-gateway/src/renderer.ts` — `handleError` now
  hydrates the persisted bubble from disk first, wraps the `❌` send in
  try/catch, and always deletes the bubble + clears persisted state + resets
  run state.
- `packages/shared/src/agent/backend/pi/event-adapter.ts` — retryable errors
  (per the SDK's own `isRetryableAssistantError`) are now buffered and
  deferred until a definite failure terminal instead of being reported at
  `message_end`. The SDK sequence is `message_end(stopReason: error)` →
  `agent_end(willRetry: true)` → `auto_retry_start` → retried turn → final
  `agent_end(willRetry: false)`. The adapter holds the queue open on
  `willRetry: true` (same pattern as `defenseResumePending`), surfaces the
  buffered error exactly once on the failure terminal (final `agent_end`
  without retry, or `auto_retry_end(success: false)` after an abort), clears
  the buffer when a retry succeeds, never reports twice
  (`hasEmittedTerminalError`), leaves user aborts untouched, and treats
  legacy payloads without `willRetry` as terminal for backwards
  compatibility.

### Prevention

- Treat `complete without assistant response` as an error signal, not a
  normal finish, whenever a captured API error explains it.
- Terminal-event cleanup in messaging renderers must never depend on a
  prior network send succeeding, and must hydrate persisted state first so
  post-restart events can clean pre-restart bubbles.
- `terminated` from a relay is usually the 120 s idle timeout or upstream
  fault, not a model stop. Check `httpIdleTimeoutMs` (120_000) and
  `CALLBACK_TOOL_TIMEOUT_MS` (120000) before assuming a hung model.

## Incident 5: `400 property 'reasoning_content' is unsupported` (2026-09-13)

### Symptom

With the custom endpoint pointed at a local uni-api gateway that routes to
Groq (`openai/gpt-oss-120b`), every **multi-turn** request failed:

```text
Error 400 with provider groq-1 ... openai/gpt-oss-120b
"'messages.2' : for 'role:assistant' the following must be satisfied
 [('messages.2' : property 'reasoning_content' is unsupported)]"
```

First turn succeeded; the failure appeared as soon as a prior assistant
message was echoed back in `messages`.

### Root cause

`buildCustomEndpointModelDef` hard-coded
`compat.requiresReasoningContentOnAssistantMessages: true` for **every**
custom endpoint. That flag was added for one specific relay
(stealth/ox-alpha), whose thinking-mode handshake *requires* every assistant
message to carry `reasoning_content` — without it the relay 400s with
"the reasoning_content in the thinking mode must be passed back".

Groq takes the exact opposite position and rejects the property outright.
Because the flag was unconditional, there was no way to serve both: the
value is genuinely upstream-specific, and no single setting is safe for all
endpoints behind a proxy.

This is the same class of mistake as Incident 1 (`supportsDeveloperRole`) —
a value derived from one upstream baked into the synthetic definition for
all of them.

### Fix

Made the flag configurable instead of hard-coded:

- `packages/pi-agent-server/src/custom-endpoint-models.ts` — added
  `requiresReasoningContentOnAssistantMessages` to both
  `CustomEndpointModelDefaults` and `CustomEndpointModelOverrides`; the
  builder now resolves `per-model override ?? connection default ?? true`.
  Default stays `true` so the original relay keeps working.
- `packages/pi-agent-server/src/index.ts` — plumbed the connection-level
  value from `initConfig.customEndpoint` and the per-model value through
  `customModelOverrides`.
- `packages/shared/src/config/llm-connections.ts` — added the field to
  `CustomEndpointConfig` so it can be set in `config.json`.
- `packages/server-core/src/sessions/runtime-config.ts` — included it in
  `buildBackendRuntimeSignature` so changing it rebuilds the backend instead
  of being ignored by the in-place refresh path.

Endpoints that reject the property now set it in `config.json`:

```json
{
  "customEndpoint": {
    "api": "openai-completions",
    "requiresReasoningContentOnAssistantMessages": false
  }
}
```

### Prevention

- A `compat.*` flag whose correct value **differs per upstream** must be
  configurable, never hard-coded — even if today only one upstream needs the
  non-default value. Incident 1 and Incident 5 are both instances of this.
- When a gateway fans out to several providers (uni-api `auto`, LiteLLM),
  assume the strictest common denominator: any per-provider field that isn't
  universally accepted has to be opt-in.
- Test multi-turn conversations, not just the first turn. Both Incident 1
  and Incident 5 only manifest once history is echoed back.

## Incident 6: deterministic 4xx errors retried for the full 2h budget (2026-09-13)

### Symptom

Same session as Incident 5. After the `reasoning_content` fix the failure
changed — but the session *still* did not recover, and the UI kept reporting
"retrying" with no error surfaced.

### Root cause

`classifyAutoRetryError` classified **both** real errors as `transient`:

| Error | Was | Should be |
|---|---|---|
| `400 ... property 'reasoning_content' is unsupported` | transient | **permanent** |
| `413 Request too large ... Limit 8000, Requested 61426` | transient | **permanent** |

Two independent causes:

1. **Unknown text defaulted to transient.** The classifier is a list of
   "permanent" phrases; anything unmatched fell through to transient
   ("conservative about giving up"). But the retry loop re-sends the *same*
   history (`stripTrailingErrorAssistant` + `agent.continue()`), so any error
   that is a property of the request reproduces forever. A misclassified
   permanent error costs the entire 2h / 30-round budget, and it does so
   silently.
2. **The HTTP status never reached the classifier.** `errorText` is only
   `msg.errorMessage`; the status lives in a sibling `status` field.
   `api-error.json` for this session reads
   `{"status":400,...,"message":"'messages.2' : ... is unsupported"}` — the
   message contains no status code at all, so no status-based rule could fire.

### Fix

Two layers, both in `packages/pi-agent-server/src/auto-retry.ts`:

- **Status-code layer.** `extractHttpStatus()` recovers a code from the
  provider string (`HTTP/1.1 400`, `status_code=400`, `"status":400`,
  `Error 400 with provider`, …). 5xx → transient; 4xx → permanent unless it is
  in `TRANSIENT_4XX` (`408/409/425/429` — the codes that can legitimately heal
  with an identical request). Per RFC 9110 this is the correct default: 4xx
  means "change the request", 5xx means "the server may recover".
- **Request-shape / request-size phrases.** Added to `PERMANENT_ERROR_PATTERNS`
  for the status-free case: `is unsupported`, `must be satisfied`,
  `request too large`, `please reduce your message`, … Notably **not**
  `is not supported` — that phrasing appears in transient upstream notices
  ("User location is not supported"), which the test suite pins.

Verified by running the real classifier over both incident strings.

### Prevention

- The conservative default is right for **unknown strings** (transport errors
  carry no status) but wrong for the **4xx class**. Prefer splitting on the
  status-code layer when a code is available.
- "Retry the same request" can only succeed if the failure was environmental.
  Before classifying anything transient, ask: *can the next request differ?*
- Test with the verbatim provider string, not a paraphrase. Both regressions
  here were invisible until the exact text (status-free) was used.

## Incident 7: context compaction ignores the channel's real ceiling (2026-09-13)

### Symptom

The session sat at ~61K tokens and was rejected with
`Request too large ... Limit 8000, Requested 61426`. Auto-compaction never ran.

### Root cause

Two different numbers were being conflated:

- the model's **declared `contextWindow`** (openai/gpt-oss-120b → 131072)
- the **largest request the channel actually accepts** (Groq free tier → 8000)

The SDK compacts at ~87.5% of the declared window (114688). The session died at
8000 — **14x below the only threshold that exists** — so compaction never
triggered. Nothing in the codebase represented "what this channel will accept".

### Fix

Added `contextTokenBudget` (connection-level in `customEndpoint`, or per model
in `customModels`) stating the channel's real ceiling. `forced-compaction.ts`
gained a budget lane: when context reaches 90% of the budget, compaction is
forced regardless of stopReason, so the session degrades instead of walling
into a 413. Reuses the existing anti-loop guard (skip if the last compaction
shrank context by < 4000 tokens) and logs when the session is simply too big
for the channel.

Resolved lazily via `resolveContextTokenBudget()` because the active model can
change mid-session.

### Prevention

- A model's context window and a channel's request ceiling are **orthogonal**
  constraints. Anything that sizes work by the former will be wrong whenever a
  gateway enforces the latter.
- Prefer failing loudly ("this session needs a bigger channel") over silently
  not compacting.

## Related files

- `packages/pi-agent-server/src/custom-endpoint-models.ts` — synthetic model
  definition and `DEFAULT_MAX_TOKENS`.
- `packages/pi-agent-server/src/index.ts` — builds the model list from
  `buildCustomEndpointModelDef`.
- `~/.craft-agent/config.json` — live connection (`litellm-proxy`, base URL
  `http://127.0.0.1:4000/v1`, model `default`, `customEndpoint.api:
  openai-completions`).
- `@earendil-works/pi-ai/dist/api/openai-completions.js` — request-shaping logic
  (`supportsDeveloperRole`, `reasoning`).
- `packages/shared/src/config/llm-connections.ts` — `CustomEndpointConfig`
  (`requiresReasoningContentOnAssistantMessages` Incident 5,
  `contextTokenBudget` Incident 7).
- `packages/pi-agent-server/src/auto-retry.ts` — status-code classification
  layer (`extractHttpStatus`, `TRANSIENT_4XX`, Incident 6).
- `packages/pi-agent-server/src/forced-compaction.ts` — budget lane
  (`shouldCompactForBudget`, Incident 7).
- `packages/pi-agent-server/src/tool-payload.ts` — per-turn tool preamble
  measurement + promptSnippet shaping.
- `packages/shared/src/interceptor-common.ts` — append-only error history
  (`api-errors.jsonl`) alongside the single-slot `api-error.json`.
- `packages/server-core/src/sessions/SessionManager.ts` — complete handler
  error surfacing (Incident 3).
- `packages/messaging-gateway/src/renderer.ts` — progress bubble lifecycle and
  error-path cleanup (Incident 3).
- `packages/shared/src/agent/backend/pi/event-adapter.ts` — Pi event mapping;
  retryable-error deferral (Incident 3) and queued-continuation hold
  (Incident 4).
- `packages/shared/src/agent/pi-agent.ts` — subprocess event loop; passes
  `defenseResumePending` / `queuedFollowUpPending` to the adapter (Incident 4).

## Incident 4: steer-after-`agent_end` invisible continuation loses events (2026-09-06)

### Symptom

Session `260906-golden-swamp`: the UI froze on the last intermediate assistant
message while the subprocess kept making LLM calls and executing tools for
~3 more minutes, until the stall watchdog killed the zombie turn
(`Turn stalled: no activity for 300s — aborting`, prompt_error). Everything
the continuation turn did (bun test runs, tsc, doc edits, set_session_status)
was real — side effects landed — but none of it was rendered or persisted to
the session JSONL. Log timeline: `completed without assistant response` at
18:27:09 → `complete` / `Processing stopped` at 18:27:09 → tool executions
18:27:51–18:29:57 → `Turn stalled` at 18:30:24.

### Root cause

A cross-session message (`send_agent_message`) was delivered mid-stream via
steer near the end of the turn. The SDK's `runLoop` drains steering inside
the inner loop, but when a steer lands after the last reasoning step it
stays queued past `agent_end`. Then:

1. `agent_end` fires with no flag (no `willRetry`, no
   `defenseResumePending`, no overflow) → adapter completed the event queue
   → UI marked the turn done.
2. SDK `_runAgentPrompt` → `_handlePostAgentRun()` checks
   `hasQueuedMessages()` AFTER `agent_end` and calls `agent.continue()` —
   starting a continuation turn with no flag of its own.
3. The continuation's events (text deltas, tool starts/results, final
   answer) landed in the closed iterator and were silently lost.

This is the fourth member of the same family as `overflowState`,
`defenseResumeHeld`, and `retryHoldActive` — every path where the SDK
continues a turn after an `agent_end` needs a queue hold — but this one had
no flag and no hold.

### Fix

- `packages/pi-agent-server/src/index.ts` — at `agent_end` forwarding time,
  when `piSession.pendingMessageCount > 0` (steering + followUp still
  queued), annotate the forwarded event with `queuedFollowUpPending: true`.
  Checked after the defense branch so the flags stay consistent; the normal
  path (steer drained inside the loop) annotates nothing.
- `packages/shared/src/agent/backend/pi/event-adapter.ts` — new
  `queuedFollowUpHeld` state, structurally identical to
  `defenseResumeHeld`: `adaptEvent` holds the queue on the flagged
  `agent_end`, `shouldCompleteQueue` gains a third parameter, the final
  unflagged `agent_end` clears it, and `resetOverflowState` resets it.
- `packages/shared/src/agent/pi-agent.ts` — passes the new flag through to
  `shouldCompleteQueue`.

### Prevention

Any SDK mechanism that can continue a turn after `agent_end` (overflow
recovery, defense resume, auto-retry, queued steering/followUp) must have a
corresponding queue hold in the event adapter. When adding a new
continuation path, treat "agent_end fired but the SDK may still emit events"
as the invariant to preserve.
