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

  /**
   * A stream that stops sending is a gap; a stream that ends in an error is not.
   *
   * Both used to arrive as 「upstream stream went silent for 60s」, because `readChunkWithGap`
   * reported every rejection as a gap timeout. Measured on 261115-steady-gecko: four failures
   * carrying that sentence had each lasted 5.5–7.1 seconds, and the real first failure on the same
   * route was `transport error: fetch failed`. These two cases are what keeps the sentence honest.
   */
  async function runWith(
    bodyFactory: (encoder: TextEncoder) => ReadableStream<Uint8Array>,
  ): Promise<{ text: string; aborted: boolean; elapsedMs: number }> {
    const encoder = new TextEncoder()
    let aborted = false
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = bodyFactory(encoder)
      init?.signal?.addEventListener('abort', () => {
        aborted = true
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
    return { text, aborted, elapsedMs: Date.now() - started }
  }

  const partialChunk = (encoder: TextEncoder): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`,
    )

  it('turns a silent stream into a retryable refusal before the total timeout', async () => {
    // No error, no close: one chunk arrives and then nothing does. This is the real gap, and the
    // gap budget (0.2s here) must abort it long before the total budget (30s).
    const { text, aborted, elapsedMs } = await runWith(
      (encoder) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(partialChunk(encoder))
            // Deliberately never closes and never errors.
          },
        }),
    )

    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY')
    expect(text).toContain('went silent')
    expect(text).toContain('"stop_reason":"refusal"')
    expect(aborted).toBe(true)
    expect(elapsedMs).toBeLessThan(3_000)
  })

  it('names the read failure instead of calling it silence', async () => {
    // The upstream ends the body in an error — a reset connection, or the request being aborted.
    // Reporting this as 「went silent」 invented a timeout that never happened, and spent the retry
    // budget a genuinely stalled stream was meant to have.
    const { text, elapsedMs } = await runWith(
      (encoder) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(partialChunk(encoder))
          },
          pull(controller) {
            // The first read got the chunk above; this is the second read — the connection drops.
            controller.error(new Error('terminated'))
          },
        }),
    )

    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY')
    expect(text).toContain('upstream stream read failed: terminated')
    expect(text).not.toContain('went silent')
    expect(text).toContain('"stop_reason":"refusal"')
    // It must fail on the error itself, not wait out the gap budget.
    expect(elapsedMs).toBeLessThan(3_000)
  })
})
