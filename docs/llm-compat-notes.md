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
