/**
 * Visible-output deadline regression suite.
 *
 * A model stuck in a chain-of-thought loop keeps the socket alive with thinking
 * deltas, so the byte-gap timeout never fires. Observed on `261105-onyx-steel`:
 * ~6 min of pure reasoning, an empty final response, then a from-scratch
 * re-run. These tests pin the gateway cutting such a stream at its own
 * deadline (a retryable empty-response refusal) while leaving ordinary
 * streams untouched.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

const VISIBLE_MS = 1_500;

function setDeadline(value: number | undefined) {
  if (value === undefined) delete process.env.CRAFT_GATEWAY_VISIBLE_OUTPUT_TIMEOUT_MS;
  else process.env.CRAFT_GATEWAY_VISIBLE_OUTPUT_TIMEOUT_MS = String(value);
}

function anthropicProvider(): LlmProvider {
  return {
    id: 'ant',
    name: 'ant',
    baseUrl: 'https://ant.example.com/v1/messages',
    protocol: 'anthropic-messages',
    keys: [{ id: 'ant-k1', key: 'sk-ant' }],
  };
}

function openaiProvider(): LlmProvider {
  return {
    id: 'oai',
    name: 'oai',
    baseUrl: 'https://oai.example.com/v1/chat/completions',
    protocol: 'openai-completions',
    keys: [{ id: 'oai-k1', key: 'sk-oai' }],
  };
}

function config(provider: LlmProvider, firstByteSeconds = 30): LlmConfig {
  return {
    version: 1,
    // Generous gaps: the only thing that may cut these streams short is the
    // visible-output deadline under test.
    presets: { main: { firstByteSeconds, streamGapSeconds: 60, totalSeconds: 120, rateLimitSeconds: 0 } },
    providers: [provider],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: provider.id }],
        // Stream retries share this budget; three attempts leaves room for
        // the retry the deadline is supposed to hand back to the client.
        retry: { maxAttempts: 3, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Streams forever: Anthropic-shaped thinking deltas, never any answer text. */
function reasoningOnlyStreamAnt(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse('message_start', { message: { id: 'msg_1', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: {} } })));
        let n = 0;
        const tick = () => {
          controller.enqueue(encoder.encode(sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: `step ${n++}` } })));
          setTimeout(tick, 20);
        };
        tick();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** OpenAI-shaped stream whose deltas are all reasoning_content. */
function reasoningOnlyStreamOai(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let n = 0;
        const tick = () => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { reasoning_content: `step ${n++}` } }] })}\n\n`));
          setTimeout(tick, 20);
        };
        tick();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Normal completion: some text, then a clean stop. */
function answeredStreamAnt(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse('message_start', { message: { id: 'msg_2', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: {} } })));
        controller.enqueue(encoder.encode(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })));
        controller.enqueue(encoder.encode(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'answer' } })));
        controller.enqueue(encoder.encode(sse('content_block_stop', { index: 0 })));
        controller.enqueue(encoder.encode(sse('message_delta', { delta: { stop_reason: 'end_turn' } })));
        controller.enqueue(encoder.encode(sse('message_stop', { type: 'message_stop' })));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function answeredStreamOai(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'cmpl_2', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('LlmGateway visible-output deadline', () => {
  let gateway: LlmGateway | null = null;
  let configDir = '';
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    // Isolated per test: route cooldowns are written to disk, and a parked key
    // would surface as "no healthy account" instead of the behaviour under
    // test.
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-visible-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
    setDeadline(VISIBLE_MS);
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
      gateway = null;
    }
    setDeadline(undefined);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (sandboxDir) process.env.CRAFT_CONFIG_DIR = sandboxDir;
    else delete process.env.CRAFT_CONFIG_DIR;
  });

  async function ask(provider: LlmProvider, upstream: Response) {
    const cfg = config(provider);
    const impl = (async () => upstream) as unknown as typeof fetch;
    gateway = new LlmGateway({ getConfig: () => cfg, fetchImpl: impl, log: () => {} });
    await gateway.start();
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        stream: true,
        sessionKey: 'vis-session',
        messages: [{ role: 'user', content: 'go' }],
      }),
    });
    return await res.text();
  }

  it('cuts an anthropic reasoning-only stream with the empty-response marker', async () => {
    const started = Date.now();
    const text = await ask(anthropicProvider(), reasoningOnlyStreamAnt());
    const elapsed = Date.now() - started;
    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('"stop_reason":"refusal"');
    expect(elapsed).toBeGreaterThanOrEqual(VISIBLE_MS - 200);
    expect(elapsed).toBeLessThan(VISIBLE_MS + 1_500);
  });

  it('cuts an openai reasoning-only stream with the empty-response marker', async () => {
    const started = Date.now();
    const text = await ask(openaiProvider(), reasoningOnlyStreamOai());
    const elapsed = Date.now() - started;
    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(elapsed).toBeGreaterThanOrEqual(VISIBLE_MS - 200);
    expect(elapsed).toBeLessThan(VISIBLE_MS + 1_500);
  });

  it('lets an answered anthropic stream finish untouched', async () => {
    const text = await ask(anthropicProvider(), answeredStreamAnt());
    expect(text).not.toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('answer');
  });

  it('lets an answered openai stream finish untouched', async () => {
    const text = await ask(openaiProvider(), answeredStreamOai());
    expect(text).not.toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('answer');
  });

  it('honours the env override', async () => {
    setDeadline(300);
    const started = Date.now();
    const text = await ask(anthropicProvider(), reasoningOnlyStreamAnt());
    const elapsed = Date.now() - started;
    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(elapsed).toBeLessThan(1_200);
    setDeadline(VISIBLE_MS);
  });
});
