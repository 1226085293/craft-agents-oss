/**
 * The gateway end of the thinking-level fix.
 *
 * What the user saw (2026-10-29): composer 最大, relay log `reasoning_effort:
 * high`. The relay resolves effort from the request body and falls back to the
 * model's `defaultEffort` — so the only question that matters here is "does the
 * request carry `reasoning_effort`, and is it the level the session asked for".
 *
 * Guarantees pinned below:
 *  - a model that declares `reasoningEfforts` gets the level, clamped into that
 *    list;
 *  - a model that declares nothing gets the level the session asked for, and a
 *    relay that refuses it is stepped down one level at a time — 最大 must not
 *    be quietly replaced by the upstream's own default (2026-10-30);
 *  - an `anthropic-messages` upstream receives a budget block instead of the
 *    adaptive shape it has never been sent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmGateway } from '../llm-gateway.ts'
import type { LlmConfig, LlmProvider } from '../llm-config.ts'

const SSE_OK =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

function configWith(provider: Partial<LlmProvider>): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [
      {
        id: 'wb',
        name: 'wb',
        baseUrl: 'https://wb.example.com/v1/chat/completions',
        protocol: 'openai-completions',
        keys: [{ id: 'wb-k1', key: 'sk-wb-SECRET-1' }],
        models: { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash' },
        ...provider,
      },
    ],
    strategies: [
      {
        id: 'workbuddy',
        type: 'round_robin',
        members: [{ provider: 'wb', model: 'deepseek-v4.1-flash' }],
        modelAliases: { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash' },
        retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['workbuddy'] }],
  }
}

/**
 * Upstream stub.
 *
 * `calls` records the chat bodies; `onChat` lets a test reject a specific level
 * so the step-down path can be exercised.
 */
function stubUpstream(opts: {
  onChat?: (body: Record<string, unknown>) => Response | undefined
  /** `GET /models` response body. Default: no ladders advertised. */
  models?: unknown
} = {}) {
  const calls: Array<Record<string, unknown>> = []
  const modelProbes: string[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    // The catalog discovery is a separate `GET /models` request; keep it out
    // of `calls` so the chat-body assertions stay 1:1 with dispatched chats.
    if (String(input).endsWith('/models')) {
      modelProbes.push(String(input))
      return new Response(JSON.stringify(opts.models ?? { data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push(body)
    const custom = opts.onChat?.(body)
    if (custom) return custom
    return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls, modelProbes }
}

/** An Anthropic-shaped request as the Pi SDK sends it on the adaptive path. */
function post(gateway: LlmGateway, thinking: Record<string, unknown>, outputConfig?: Record<string, unknown>) {
  return fetch(`${gateway.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking,
      ...(outputConfig ? { output_config: outputConfig } : {}),
    }),
  })
}

describe('LlmGateway — thinking level reaches the upstream', () => {
  let gateway: LlmGateway | undefined
  let configDir = ''
  const sandboxDir = process.env.CRAFT_CONFIG_DIR

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'craft-effort-'))
    process.env.CRAFT_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
    if (sandboxDir === undefined) delete process.env.CRAFT_CONFIG_DIR
    else process.env.CRAFT_CONFIG_DIR = sandboxDir
    rmSync(configDir, { recursive: true, force: true })
  })

  it('sends the level the session asked for', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({
      getConfig: () => configWith({
        modelOptions: { 'deepseek-v4.1-flash': { supportsThinking: true, reasoningEfforts: ['low', 'high', 'max'] } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    // 最大 is 最大: the relay reports what the request carries.
    expect(calls[0]!.reasoning_effort).toBe('max')
  })

  it('clamps to what the model declares', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({
      getConfig: () => configWith({
        modelOptions: { 'deepseek-v4.1-flash': { reasoningEfforts: ['low', 'medium', 'high'] } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    // An upstream that tops out at high must not be sent "max".
    expect(calls[0]!.reasoning_effort).toBe('high')
  })

  it('sends the requested level when the model declares nothing', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({ getConfig: () => configWith({}), fetchImpl: impl })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    // Nothing is known about this model, so the session's own choice goes out.
    // Clamping into a guessed ladder first is what quietly turned 最大 into the
    // upstream's default.
    expect(calls[0]!.reasoning_effort).toBe('max')
  })

  it('clamps 最大 into the ladder the upstream catalog advertises', async () => {
    // The model tops out at `xhigh`; the relay silently falls back to its
    // default when handed `max`, so the step-down ladder never fires. The
    // catalog is the only place the ceiling is visible, and it must be clamped
    // into *before* the request goes out.
    const { impl, calls, modelProbes } = stubUpstream({
      models: { data: [{ id: 'deepseek-v4.1-flash', reasoning_efforts: ['high', 'xhigh'] }] },
    })
    gateway = new LlmGateway({ getConfig: () => configWith({}), fetchImpl: impl })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    expect(modelProbes.length).toBe(1)
    expect(calls[0]!.reasoning_effort).toBe('xhigh')
  })

  it('sends no field at all when the model is declared not to reason', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({
      getConfig: () => configWith({
        modelOptions: { 'deepseek-v4.1-flash': { supportsThinking: false } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    expect('reasoning_effort' in calls[0]!).toBe(false)
  })

  it('steps down through the standard ladder when an unknown level is refused', async () => {
    // Nothing declared, so the relay is the only authority — and it rejects max.
    const { impl, calls } = stubUpstream({
      onChat: (body) =>
        body.reasoning_effort === 'max'
          ? new Response(
              JSON.stringify({ error: { message: 'unsupported reasoning_effort: max' } }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    })
    gateway = new LlmGateway({ getConfig: () => configWith({}), fetchImpl: impl })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    //The turn survives: a level the relay does not take is not a dead request.
    expect(res.status).toBe(200)
    await res.text()
    expect(calls.map((c) => c.reasoning_effort)).toEqual(['max', 'high'])
  })

  it('steps down inside a declared ladder and remembers where it landed', async () => {
    const rejected = (body: Record<string, unknown>): Response | undefined =>
      body.reasoning_effort === 'max'
        ? new Response(
            JSON.stringify({ error: { message: 'unsupported reasoning_effort: max' } }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        : undefined
    const { impl, calls } = stubUpstream({ onChat: rejected })
    gateway = new LlmGateway({
      getConfig: () => configWith({
        modelOptions: { 'deepseek-v4.1-flash': { reasoningEfforts: ['low', 'high', 'max'] } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()
    expect(calls.map((c) => c.reasoning_effort)).toEqual(['max', 'high'])

    // The working level is remembered, so the next turn does not pay the 400 again.
    const again = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(again.status).toBe(200)
    await again.text()
    expect(calls[2]!.reasoning_effort).toBe('high')
  })

  it('does not burn requests on a 400 that is not about the effort', async () => {
    const { impl, calls } = stubUpstream({
      onChat: () =>
        new Response(JSON.stringify({ error: { message: 'messages: invalid role' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    })
    gateway = new LlmGateway({ getConfig: () => configWith({}), fetchImpl: impl })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(400)
    await res.text()

    // Exactly one attempt: retrying a malformed request would only cost another
    // round trip, and its body must still reach the caller's classifier.
    expect(calls.length).toBe(1)
  })

  it('carries a budget-based level too, so older clients are not a no-op', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({
      getConfig: () => configWith({
        modelOptions: { 'deepseek-v4.1-flash': { reasoningEfforts: ['low', 'medium', 'high'] } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    // No output_config: the SDK's budget path (medium = 8192 tokens).
    const res = await post(gateway, { type: 'enabled', budget_tokens: 8192 })
    expect(res.status).toBe(200)
    await res.text()

    expect(calls[0]!.reasoning_effort).toBe('medium')
  })

  it('gives an anthropic upstream a budget block, not the adaptive shape', async () => {
    const { impl, calls } = stubUpstream()
    gateway = new LlmGateway({
      getConfig: () => configWith({
        protocol: 'anthropic-messages',
        baseUrl: 'https://wb.example.com/v1/messages',
        modelOptions: { 'deepseek-v4.1-flash': { reasoningEfforts: ['low', 'high', 'max'] } },
      }),
      fetchImpl: impl,
    })
    await gateway.start()

    const res = await post(gateway, { type: 'adaptive' }, { effort: 'max' })
    expect(res.status).toBe(200)
    await res.text()

    // A relay that has only ever seen `budget_tokens` keeps seeing it, and
    // `output_config` never leaks through.
    expect(calls[0]!.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 })
    expect('output_config' in calls[0]!).toBe(false)
  })
})
