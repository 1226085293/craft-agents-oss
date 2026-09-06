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
- `packages/shared/src/agent/backend/pi/event-adapter.ts` — Pi event mapping;
  queued-continuation hold (Incident 4).
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
steer near the end of the turn. The SDK's runLoop drains steering inside
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

This is the same failure family as the overflow-recovery and
`defenseResumeHeld` holds — every path where the SDK continues a turn after
an `agent_end` needs a queue hold — but this one had no flag and no hold.

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
