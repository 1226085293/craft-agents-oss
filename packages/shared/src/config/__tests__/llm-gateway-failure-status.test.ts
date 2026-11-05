/**
 * Client-facing status of a failed request.
 *
 * Three classes used to collapse into `503 no healthy account for this model`,
 * which sent the operator looking for a credential problem:
 *
 * 1. **A payload the model cannot take** (an image on a text-only route). The
 *    body names the model, so the generic 400 heuristic read it as "this
 *    provider does not serve this model", cooled the route for 300s and
 *    answered 503. `261105-onyx-steel`: every turn of a session with one pasted
 *    screenshot died that way.
 * 2. **A transport failure / first-byte timeout.** No HTTP answer at all.
 * 3. **A genuine route failure** (404 on that model) — the only class that is
 *    legitimately "no healthy account".
 *
 * The statuses are asserted end-to-end (status line + body), and the cooldown
 * file is inspected where the difference is "was the route parked?".
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

const IMAGE_REJECTION =
  '{"error":{"message":"Model GLM-5.3-Flash does not support image input. Remove the image content or use a model that supports vision."}}';

function provider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-1` }],
    ...over,
  };
}

/**
 * One strategy over the given providers.
 *
 * Built from the provider list so a single-provider test cannot leave the
 * strategy pointing at a provider that no longer exists — the planner throws
 * on that, and the request dies as `plan_failed` before any upstream call.
 */
function config(over: Partial<LlmConfig> = {}): LlmConfig {
  const providers = over.providers ?? [provider('p1'), provider('p2')];
  return {
    version: 1,
    presets: {},
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: providers.map((p) => ({ provider: p.id })),
        // No same-target retries: every test asserts how many units the chain
        // walked, which retries would blur.
        retry: { maxAttempts: 1, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    ...over,
    providers,
  };
}

type StubResponse =
  | { status?: number; body?: string; headers?: Record<string, string> }
  | (() => Response);

function stubUpstream(responses: StubResponse[]) {
  const calls: Array<{ url: string }> = [];
  let i = 0;
  const impl = (async (input: string | URL) => {
    let pathname = String(input);
    try {
      pathname = new URL(String(input)).pathname;
    } catch {
      /* not a URL; treat as a chat call */
    }
    if (pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    calls.push({ url: String(input) });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (typeof spec === 'function') return spec();
    const { body = JSON.stringify({ ok: true }), status = 200, headers } = spec;
    return new Response(body, { status, headers: headers ?? { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function post(gateway: LlmGateway, body: Record<string, unknown> = {}) {
  return fetch(`${gateway.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
    body: JSON.stringify({ model: 'auto', ...body }),
  });
}

/** A response that answers headers and then never sends a body byte. */
function neverEnding(): Response {
  return new Response(
    new ReadableStream({ start() { /* never enqueue */ } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('LlmGateway failure status', () => {
  let gateway: LlmGateway | null = null;
  let configDir = '';
  const logs: string[] = [];
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    logs.length = 0;
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-status-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    gateway = null;
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (sandboxDir) process.env.CRAFT_CONFIG_DIR = sandboxDir;
  });

  async function start(cfg: LlmConfig, responses: StubResponse[]) {
    const stub = stubUpstream(responses);
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: (m) => logs.push(m),
    });
    await gateway.start();
    return stub;
  }

  /** Persisted cooldown map: `unit|provider::model` / `provider::key` keys. */
  function cooldowns(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(join(configDir, 'llm-cooldowns.json'), 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }

  it('answers 400 for a payload every member refuses, without cooling the route', async () => {
    const stub = await start(config(), [
      { status: 400, body: IMAGE_REJECTION },
      { status: 400, body: IMAGE_REJECTION },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('payload was rejected');
    // Both members were offered the payload: a vision-capable fallback can
    // still serve it, so a capability refusal must not end the chain.
    expect(stub.calls.length).toBe(2);
    // And nothing was parked: the route serves text requests fine.
    expect(Object.keys(cooldowns()).filter((key) => key.startsWith('unit|'))).toEqual([]);
    expect(logs.some((line) => line.includes('does not accept this payload'))).toBe(true);
  });

  it('serves the turn from a later member that accepts the payload', async () => {
    const stub = await start(config(), [
      { status: 400, body: IMAGE_REJECTION },
      { body: JSON.stringify({ id: 'vision-member' }) },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('vision-member');
    expect(stub.calls.length).toBe(2);
  });

  it('still reports 503 and parks the route when the model is genuinely absent', async () => {
    // The regression guard: 404 is a routing problem, not a payload problem.
    const stub = await start(config({ providers: [provider('p1')] }), [
      { status: 404, body: '{"error":{"message":"model not found"}}' },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'no healthy account for this model',
    );
    expect(stub.calls.length).toBe(1);
    expect(Object.keys(cooldowns())).toEqual(['unit|p1::auto']);
  });

  it('keeps 400 "unknown model" on the route path', async () => {
    const stub = await start(config({ providers: [provider('p1')] }), [
      { status: 400, body: '{"error":{"message":"unknown model: auto"}}' },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(503);
    expect(stub.calls.length).toBe(1);
    expect(Object.keys(cooldowns())).toEqual(['unit|p1::auto']);
  });

  it('answers 502 when no upstream answers at all', async () => {
    const stub = await start(config({ providers: [provider('p1')] }), [
      () => {
        throw new Error('fetch failed');
      },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.message).toBe('all upstreams failed');
    expect(stub.calls.length).toBe(1);
  });

  it('answers 504 when the upstream never sends a first byte', async () => {
    const cfg = config({
      presets: { slow: { firstByteSeconds: 0.05 } },
      providers: [provider('p1', { defaultPreset: 'slow' })],
    });
    const stub = await start(cfg, [neverEnding]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.message).toBe('no upstream answered before the deadline');
    expect(stub.calls.length).toBe(1);
  });

  it('keeps an unclassified upstream error at 502, not 503', async () => {
    const stub = await start(config({ providers: [provider('p1')] }), [
      { status: 503, body: '{"error":"overloaded"}' },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(502);
    expect(stub.calls.length).toBe(1);
  });
});
