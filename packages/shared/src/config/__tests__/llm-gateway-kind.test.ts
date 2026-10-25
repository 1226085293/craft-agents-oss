/**
 * Request-kind attribution, end to end.
 *
 * The gateway stamps every usage row with what the request was for, so the log
 * can answer "who made this call?" rather than only "which provider served it".
 *
 * Two properties matter, and both are about *not* leaking:
 *
 *   1. The marker must never reach the upstream — it is ours, and a strict
 *      provider would reject an unknown header or body field.
 *   2. A request without the marker must still be recorded, just without a
 *      kind, rather than being rejected or guessed at.
 *
 * The header is the real channel (the subprocess registers it per backend
 * through the SDK's provider `headers`). The body field exists for clients we
 * do not control, so both paths are pinned here.
 */

import { describe, it, expect, afterEach } from 'bun:test'

import { LlmGateway } from '../llm-gateway.ts'
import type { LlmConfig, LlmProvider } from '../llm-config.ts'
import { MODEL_KIND_HEADER, MODEL_KIND_OVERRIDE_HEADER } from '../model-request-kind.ts'

function provider(id: string): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-SECRET-1` }],
  }
}

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [provider('p1')],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: 'p1' }],
        modelAliases: { auto: 'upstream-model' },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    ...over,
  }
}

interface UpstreamCall {
  url: string
  init: RequestInit | undefined
}

function stubUpstream() {
  const calls: UpstreamCall[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ id: 'msg_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('request-kind attribution', () => {
  let gateway: LlmGateway | undefined

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
  })

  async function start() {
    const stub = stubUpstream()
    gateway = new LlmGateway({ getConfig: () => config(), fetchImpl: stub.impl, log: () => {} })
    await gateway.start()
    return stub
  }

  function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(`${gateway!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client', ...headers },
      body: JSON.stringify({ model: 'auto', ...body }),
    })
  }

  it('records the kind sent as a header', async () => {
    await start()
    const res = await post({}, { [MODEL_KIND_HEADER]: 'title' })
    expect(res.status).toBe(200)

    const usage = gateway!.drainUsage()
    expect(usage).toHaveLength(1)
    expect(usage[0]!.kind).toBe('title')
  })

  it('records the kind sent as a body field', async () => {
    await start()
    const res = await post({ kind: 'busy_decision' })
    expect(res.status).toBe(200)
    expect(gateway!.drainUsage()[0]!.kind).toBe('busy_decision')
  })

  it('prefers the header when both are present', async () => {
    // The subprocess knows who the caller is; a body field is only a fallback
    // for clients we do not control, so it must not be able to override.
    await start()
    await post({ kind: 'forged' }, { [MODEL_KIND_HEADER]: 'chat' })
    expect(gateway!.drainUsage()[0]!.kind).toBe('chat')
  })

  it('leaves the kind absent when the caller does not declare one', async () => {
    await start()
    await post({})
    const usage = gateway!.drainUsage()
    expect(usage).toHaveLength(1)
    expect(usage[0]!.kind).toBeUndefined()
  })

  it('never forwards the marker upstream — header', async () => {
    const stub = await start()
    await post({}, { [MODEL_KIND_HEADER]: 'memory' })
    const sent = stub.calls[0]!.init?.headers as Record<string, string>
    const names = Object.keys(sent).map((h) => h.toLowerCase())
    expect(names).not.toContain(MODEL_KIND_HEADER)
  })

  it('never forwards the marker upstream — body', async () => {
    const stub = await start()
    await post({ kind: 'memory' })
    const body = JSON.parse(String(stub.calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.kind).toBeUndefined()
    // The model still gets swapped to the upstream alias; stripping the marker
    // must not disturb that.
    expect(body.model).toBe('upstream-model')
  })

  it('prefers the per-call override over the process-wide kind', async () => {
    // One subprocess serves the conversation and, from inside it, call_llm /
    // the verification judge / the steer check. The provider header can only
    // describe the process, so the per-call one has to win.
    await start()
    await post({}, { [MODEL_KIND_HEADER]: 'chat', [MODEL_KIND_OVERRIDE_HEADER]: 'verification' })
    expect(gateway!.drainUsage()[0]!.kind).toBe('verification')
  })

  it('falls back to the process-wide kind when there is no override', async () => {
    await start()
    await post({}, { [MODEL_KIND_HEADER]: 'chat' })
    expect(gateway!.drainUsage()[0]!.kind).toBe('chat')
  })

  it('keeps an unknown kind verbatim so the row is still traceable', async () => {
    // Forward compatibility: a newer build may send a kind this one does not
    // know. Storing it beats dropping it.
    await start()
    await post({}, { [MODEL_KIND_HEADER]: 'some_future_kind' })
    expect(gateway!.drainUsage()[0]!.kind).toBe('some_future_kind')
  })

  it('records the kind on a failed request too', async () => {
    // The rows that most need attribution are the ones that failed.
    const stub = stubUpstream()
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    gateway = new LlmGateway({
      getConfig: () => config(),
      fetchImpl: failing,
      log: () => {},
    })
    await gateway.start()
    void stub

    const res = await post({}, { [MODEL_KIND_HEADER]: 'verification' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const usage = gateway!.drainUsage()
    expect(usage.length).toBeGreaterThan(0)
    expect(usage[0]!.kind).toBe('verification')
  })
})
