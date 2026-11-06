import { afterEach, describe, expect, it } from 'bun:test'

import { LlmGateway } from '../llm-gateway.ts'
import type { LlmConfig, LlmProvider } from '../llm-config.ts'

function provider(): LlmProvider {
  return {
    id: 'oai',
    name: 'oai',
    baseUrl: 'https://oai.example.com/v1/chat/completions',
    protocol: 'openai-completions',
    defaultPreset: 'gap',
    keys: [{ id: 'oai-k1', key: 'sk-oai' }],
  }
}

function config(): LlmConfig {
  return {
    version: 1,
    presets: {
      gap: { firstByteSeconds: 5, streamGapSeconds: 0.2, totalSeconds: 30, rateLimitSeconds: 0 },
    },
    providers: [provider()],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: 'oai' }],
        retry: { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
  }
}

describe('LlmGateway stream gap', () => {
  let gateway: LlmGateway | null = null

  afterEach(async () => {
    if (gateway) {
      await gateway.clearKeyCooldown()
      await gateway.stop()
      gateway = null
    }
  })

  it('turns a silent stream into a retryable refusal before the total timeout', async () => {
    const encoder = new TextEncoder()
    let aborted = false
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`,
            ),
          )
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            try {
              controller.error(new Error('aborted'))
            } catch {
              // Already closed.
            }
          })
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as never

    gateway = new LlmGateway({
      getConfig: config,
      fetchImpl,
      log: () => {},
    })
    await gateway.start()

    const started = Date.now()
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        stream: true,
        sessionKey: 'gap-session',
        messages: [{ role: 'user', content: 'go' }],
      }),
    })
    const text = await res.text()

    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY')
    expect(text).toContain('went silent')
    expect(text).toContain('"stop_reason":"refusal"')
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

})
