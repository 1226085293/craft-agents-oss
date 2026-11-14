/**
 * End-to-end transcoding tests through the real gateway.
 *
 * The unit tests in `llm-transcode.test.ts` prove the field mapping; these prove
 * the wiring — that an `openai-completions` provider actually gets a transcoded
 * request, that the stream it returns is rewritten before it reaches the client,
 * and that an Anthropic provider is still byte-forwarded untouched.
 *
 * The last one matters most: transcoding must not have disturbed the pass-through
 * path, because that is what runs until the user opts into the new config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LlmGateway } from '../llm-gateway.ts';
import { SESSION_HEADER } from '../model-request-kind.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

/** An OpenAI-shaped upstream, reachable only through transcoding. */
function openAIProvider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/chat/completions`,
    protocol: 'openai-completions',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-SECRET-1` }],
    ...over,
  };
}

function anthropicProvider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-SECRET-1` }],
    ...over,
  };
}

function configWith(provider: LlmProvider): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [provider],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: provider.id }],
        retry: { maxAttempts: 1, onStatusCodes: [429], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
  };
}

/** Build an OpenAI SSE stream as text. */
function openAISSE(chunks: Array<Record<string, unknown>>): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

function textChunk(text: string): Record<string, unknown> {
  return { id: 'cmpl_1', choices: [{ index: 0, delta: { content: text } }] };
}

function toolCallChunk(id: string, name: string, args: string): Record<string, unknown> {
  return {
    id: 'cmpl_1',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
  };
}

function finishChunk(reason: string): Record<string, unknown> {
  return { id: 'cmpl_1', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
}

describe('gateway transcoding — outbound', () => {
  let gateway: LlmGateway;
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
  });

  it('sends an OpenAI-shaped request to an openai-completions upstream', async () => {
    let sentBody: Record<string, unknown> = {};
    let sentUrl = '';
    let sentAuth = '';
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async (input: never, init: RequestInit) => {
        sentUrl = String(input);
        sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        sentAuth = (init.headers as Record<string, string>).authorization ?? '';
        return new Response(openAISSE([textChunk('hi'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: (m) => logs.push(m),
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        system: 'be brief',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(sentUrl).toBe('https://oai.example.com/v1/chat/completions');
    // Bearer, not x-api-key: the Anthropic header set is wrong for this upstream.
    expect(sentAuth).toBe('Bearer sk-oai-SECRET-1');
    // No modelAliases configured, so the public id is forwarded unchanged.
    expect(sentBody.model).toBe('auto');
    expect(sentBody.max_tokens).toBe(256);
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('resolves a version-root baseUrl to the chat endpoint before sending', async () => {
    // The three shapes users paste must all reach the same upstream path.
    // 261027-long-bronze: posting `…/v1` verbatim got a 404 from the relay root
    // on every request, which surfaced as a generic 502.
    let sentUrl = '';
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai', { baseUrl: 'https://oai.example.com/v1' })),
      fetchImpl: (async (input: never) => {
        sentUrl = String(input);
        return new Response(openAISSE([textChunk('hi'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: (m) => logs.push(m),
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    await res.text();

    expect(sentUrl).toBe('https://oai.example.com/v1/chat/completions');
    // The rewrite is announced once per rebuild, not per request.
    expect(logs.some((l) => l.includes('chat endpoint https://oai.example.com/v1/chat/completions'))).toBe(true);
  });

  it('keeps a query string when resolving the chat endpoint', async () => {
    let sentUrl = '';
    gateway = new LlmGateway({
      getConfig: () =>
        configWith(
          openAIProvider('oai', { baseUrl: 'https://oai.example.com/v1/chat/completions?realm=cn' }),
        ),
      fetchImpl: (async (input: never) => {
        sentUrl = String(input);
        return new Response(openAISSE([textChunk('hi'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: (m) => logs.push(m),
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    await res.text();

    expect(sentUrl).toBe('https://oai.example.com/v1/chat/completions?realm=cn');
  });

  it('converts tool_use into OpenAI tool_calls on the wire', async () => {
    let sentBody: Record<string, unknown> = {};
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async (_input: never, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(openAISSE([textChunk('ok'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: (m) => logs.push(m),
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({
        model: 'auto',
        tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        ],
      }),
    });
    await res.text();

    const messages = sentBody.messages as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    expect(messages[0]!.tool_calls![0]!.function.arguments).toBe('{"command":"ls"}');
    const tools = sentBody.tools as Array<{ type: string }>;
    expect(tools[0]!.type).toBe('function');
  });

  it('keeps the sessionKey out of the upstream request', async () => {
    let sentBody = '';
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async (_input: never, init: RequestInit) => {
        sentBody = String(init.body);
        return new Response(openAISSE([textChunk('x'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: (m) => logs.push(m),
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', sessionKey: 'internal', messages: [] }),
    });
    await res.text();
    expect(sentBody).not.toContain('sessionKey');
  });
});

describe('gateway transcoding — inbound', () => {
  let gateway: LlmGateway;

  beforeEach(() => {
    // Fresh instance per case; the SSE stream is stateful so it cannot be shared.
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.clearKeyCooldown();
      await gateway.stop();
    }
  });

  async function startWithSSE(sse: string): Promise<Response> {
    const cfg = configWith(openAIProvider('oai'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () =>
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never,
      log: () => {},
    });
    await gateway.start();
    return fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, sessionKey: 'retry-session', messages: [{ role: 'user', content: 'go' }] }),
    });
  }

  it('rewrites an OpenAI stream into Anthropic event names', async () => {
    const res = await startWithSSE(openAISSE([textChunk('hello'), finishChunk('stop')]));
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('"text":"hello"');
    expect(text).toContain('"stop_reason":"end_turn"');
    // OpenAI's own vocabulary must not leak through.
    expect(text).not.toContain('chat.completion');
    expect(text).not.toContain('[DONE]');
  });

  it('converts tool calls into a tool_use block', async () => {
    const res = await startWithSSE(
      openAISSE([toolCallChunk('call_1', 'Bash', '{"command":"ls"}'), finishChunk('tool_calls')]),
    );
    const text = await res.text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"id":"call_1"');
    expect(text).toContain('"name":"Bash"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('retries a cleanly-ended OpenAI stream with no visible text or tool call', async () => {
    const res = await startWithSSE('data: [DONE]\n\n');
    const text = await res.text();

    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('"stop_reason":"refusal"');
    expect(gateway.drainUsage()[0]).toMatchObject({ status: 'error', superseded: true });
  });

  it('treats thinking-only output as empty because it has no user-visible answer', async () => {
    const thinkingOnly = `data: ${JSON.stringify({ id: 'cmpl_1', choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' } }] })}\n\ndata: [DONE]\n\n`;
    const res = await startWithSSE(thinkingOnly);
    const text = await res.text();

    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('"stop_reason":"refusal"');
    expect(gateway.drainUsage()[0]).toMatchObject({ status: 'error', superseded: true });
  });

  it('does not answer a non-streaming client with an empty JSON message', async () => {
    let calls = 0;
    const cfg = configWith(openAIProvider('oai'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            id: 'cmpl_empty',
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();

    expect(res.status).not.toBe(200);
    expect(calls).toBe(2);
    expect(gateway.drainUsage().every((row) => row.status === 'error')).toBe(true);
  });

  it('reports a cut stream with a supported retry marker, not an unknown stop reason', async () => {
    // No finish_reason and no [DONE]: the upstream dropped the connection
    // mid-stream. The refusal stop reason is understood by Pi's Anthropic
    // parser; the marker tells the session layer to discard this partial and
    // re-run the same model step through the gateway strategy.
    const cut = `data: ${JSON.stringify(textChunk('partial'))}\n\n`;
    const res = await startWithSSE(cut);
    const text = await res.text();

    expect(text).toContain('"stop_reason":"refusal"');
    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    expect(text).not.toContain('"stop_reason":"network_error"');

    const usage = gateway.drainUsage();
    expect(usage[0]!.status).toBe('error');
    expect(usage[0]!.error).toContain('without a finish_reason');
    expect(usage[0]!.superseded).toBe(true);
  });

  it('retries a truncated stream on the same key up to maxAttempts, then advances to the next key', async () => {
    const cut = `data: ${JSON.stringify(textChunk('partial'))}\n\n`;
    const complete = openAISSE([textChunk('recovered'), finishChunk('stop')]);
    const calls: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
    const provider = openAIProvider('oai');
    provider.keys.push({ id: 'oai-k2', key: 'sk-oai-SECRET-2' });
    const cfg = configWith(provider);
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 250 };
    const retryWaits: number[] = [];
    gateway = new LlmGateway({
      getConfig: () => cfg,
      waitForRetry: async (ms) => { retryWaits.push(ms); },
      fetchImpl: (async (_input: never, init: RequestInit) => {
        calls.push({
          auth: (init.headers as Record<string, string>).authorization ?? null,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        const body = calls.length <= 2 ? cut : complete;
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const requestBody = {
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'go' }],
    };
    const makeRequest = () => fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-client',
        [SESSION_HEADER]: 'retry-session',
      },
      body: JSON.stringify(requestBody),
    });

    const first = await makeRequest();
    expect(await first.text()).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    const second = await makeRequest();
    expect(await second.text()).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    const third = await makeRequest();
    expect(await third.text()).toContain('"text":"recovered"');

    expect(calls.map((call) => call.auth)).toEqual([
      'Bearer sk-oai-SECRET-1',
      'Bearer sk-oai-SECRET-1',
      'Bearer sk-oai-SECRET-2',
    ]);
    expect(retryWaits).toEqual([250]);
    expect(calls.every((call) => !JSON.stringify(call.body).includes('sessionKey'))).toBe(true);
    const usage = gateway.drainUsage();
    expect(usage.filter((row) => row.status === 'error').map((row) => row.attempts)).toEqual([1, 2]);
    expect(usage.filter((row) => row.status === 'error').every((row) => row.superseded)).toBe(true);
    expect(usage.at(-1)).toMatchObject({ status: 'success', retried: true });
  });

  it('counts same-turn server retries against the truncated-stream target budget', async () => {
    const cut = `data: ${JSON.stringify(textChunk('partial'))}\n\n`;
    const complete = openAISSE([textChunk('recovered'), finishChunk('stop')]);
    const calls: string[] = [];
    const provider = openAIProvider('oai');
    provider.keys.push({ id: 'oai-k2', key: 'sk-oai-SECRET-2' });
    const cfg = configWith(provider);
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [500], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async (_input: never, init: RequestInit) => {
        calls.push((init.headers as Record<string, string>).authorization ?? '');
        if (calls.length === 1) return new Response('{"error":"temporary"}', { status: 500 });
        return new Response(calls.length === 2 ? cut : complete, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const requestBody = { model: 'auto', stream: true, messages: [{ role: 'user', content: 'go' }] };
    const makeRequest = () => fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client', [SESSION_HEADER]: 'budget-session' },
      body: JSON.stringify(requestBody),
    });
    const first = await makeRequest();
    expect(await first.text()).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    const second = await makeRequest();
    expect(await second.text()).toContain('"text":"recovered"');
    expect(calls).toEqual(['Bearer sk-oai-SECRET-1', 'Bearer sk-oai-SECRET-1', 'Bearer sk-oai-SECRET-2']);
  });

  it('closes cleanly when [DONE] arrives', async () => {
    const res = await startWithSSE(openAISSE([textChunk('x'), finishChunk('stop')]));
    const text = await res.text();
    expect(text).not.toContain('network_error');
  });

  it('answers a non-streaming client with a JSON message, not an SSE error', async () => {
    // Before this branch the gateway always parsed the upstream as SSE, so a
    // client that sent no `stream` got the upstream's JSON read as a broken
    // stream: "upstream stream ended without a finish_reason".
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'cmpl_1',
            model: 'upstream-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { type: string; content: Array<{ type: string; text: string }> };
    expect(body.type).toBe('message');
    expect(body.content[0]).toEqual({ type: 'text', text: 'ok' });

    const usage = gateway.drainUsage();
    expect(usage[0]!.promptTokens).toBe(7);
    expect(usage[0]!.completionTokens).toBe(2);
  });

  it('records usage tokens scraped from the transcoded stream', async () => {
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async () =>
        new Response(openAISSE([textChunk('x'), finishChunk('stop')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as never,
      log: () => {},
    });
    await gateway.start();

    await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [] }),
    }).then((r) => r.text());

    const usage = gateway.drainUsage();
    expect(usage[0]!.promptTokens).toBe(10);
    expect(usage[0]!.completionTokens).toBe(2);
  });

  it('carries the cached prompt tokens through the transcoded stream', async () => {
    // OpenAI reports the cache hit beside the prompt count; the Anthropic
    // client and the usage page expect it in its own field, so the gateway has
    // to read it off the transcoder instead of the raw upstream body.
    const finish = {
      id: 'cmpl_1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    };
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async () =>
        new Response(openAISSE([textChunk('x'), finish]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as never,
      log: () => {},
    });
    await gateway.start();

    const responseText = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [] }),
    }).then((r) => r.text());

    const messageDelta = responseText.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; usage?: unknown })
      .find((event) => event.type === 'message_delta');
    expect(messageDelta?.usage).toEqual({ input_tokens: 176, output_tokens: 30, cache_read_input_tokens: 1024 });

    const usage = gateway.drainUsage();
    expect(usage[0]!.promptTokens).toBe(1200);
    expect(usage[0]!.completionTokens).toBe(30);
    expect(usage[0]!.cachedTokens).toBe(1024);
  });

  it('carries the cached prompt tokens through the non-streaming path', async () => {
    gateway = new LlmGateway({
      getConfig: () => configWith(openAIProvider('oai')),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'cmpl_1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 900, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 768 } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as never,
      log: () => {},
    });
    await gateway.start();

    const response = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', max_tokens: 16, messages: [] }),
    });
    const responseBody = await response.json() as { usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
    expect(responseBody.usage).toEqual({ input_tokens: 132, output_tokens: 12, cache_read_input_tokens: 768 });

    const usage = gateway.drainUsage();
    expect(usage[0]!.promptTokens).toBe(900);
    expect(usage[0]!.completionTokens).toBe(12);
    expect(usage[0]!.cachedTokens).toBe(768);
  });
});

describe('gateway transcoding — pass-through intact', () => {
  let gateway: LlmGateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.clearKeyCooldown();
      await gateway.stop();
    }
  });

  it('forwards an Anthropic upstream byte-for-byte without rewriting', async () => {
    const upstreamBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    let forwarded = '';
    gateway = new LlmGateway({
      getConfig: () => configWith(anthropicProvider('anth')),
      fetchImpl: (async () =>
        new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    forwarded = await res.text();

    // Identical to what the upstream produced: healthy pass-through is untouched.
    expect(forwarded).toBe(upstreamBody);
  });

  it('forwards a streamed Anthropic tool call without mistaking its empty input seed for empty output', async () => {
    const upstreamBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const cfg = configWith(anthropicProvider('anth'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () =>
        new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, sessionKey: 'tool-session', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();

    expect(text).toBe(upstreamBody);
    expect(text).not.toContain('CRAFT_GATEWAY_EMPTY_RESPONSE');
  });

  it('applies the stream-gap timeout to Anthropic pass-through streams too', async () => {
    const encoder = new TextEncoder();
    let aborted = false;
    const cfg = configWith(anthropicProvider('anth', { defaultPreset: 'gap' } as never));
    cfg.presets = { gap: { firstByteSeconds: 5, streamGapSeconds: 0.2, totalSeconds: 30 } };
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async (_input: never, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n' +
                  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
              ),
            );
            // Must record the abort without ending the body in an error: an errored read is a
            // different fact from a gap, and is reported as such (see the stream-gap suite).
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
            });
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const started = Date.now();
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, sessionKey: 'anth-gap', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();

    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    expect(text).toContain('went silent');
    expect(text).toContain('"stop_reason":"refusal"');
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('reports an Anthropic stream that ends cleanly with no visible answer as empty', async () => {
    const upstreamBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const cfg = configWith(anthropicProvider('anth'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () =>
        new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, sessionKey: 'anth-retry', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();

    expect(text).toContain('CRAFT_GATEWAY_EMPTY_RESPONSE_RETRY');
    expect(text).toContain('"stop_reason":"refusal"');
  });

  it('turns an Anthropic SSE error event into a retryable failed stream', async () => {
    const upstreamBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
    const cfg = configWith(anthropicProvider('anth'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () =>
        new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true, sessionKey: 'anth-retry', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();

    expect(text).toContain('CRAFT_GATEWAY_STREAM_TRUNCATION_RETRY');
    expect(text).toContain('busy');
    expect(text).not.toContain('event: error');
  });

  it('retries an empty non-streaming Anthropic message instead of returning it', async () => {
    let calls = 0;
    const cfg = configWith(anthropicProvider('anth'));
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 };
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ type: 'message', role: 'assistant', content: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();

    expect(res.status).not.toBe(200);
    expect(calls).toBe(2);
    expect(gateway.drainUsage().every((row) => row.status === 'error')).toBe(true);
  });

  it('sends Anthropic auth headers to an anthropic-messages upstream', async () => {
    let sentAuth = '';
    let sentVersion = '';
    gateway = new LlmGateway({
      getConfig: () => configWith(anthropicProvider('anth')),
      fetchImpl: (async (_i: never, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        sentAuth = headers['x-api-key'] ?? '';
        sentVersion = headers['anthropic-version'] ?? '';
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as never,
      log: () => {},
    });
    await gateway.start();

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    });
    await res.text();

    expect(sentAuth).toBe('sk-anth-SECRET-1');
    expect(sentVersion).toBe('2023-06-01');
  });
});
