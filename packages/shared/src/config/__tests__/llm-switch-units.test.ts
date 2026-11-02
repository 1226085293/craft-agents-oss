/**
 * Switching-unit behaviour, end to end.
 *
 * These pin what the 261027-long-bronze incident changed:
 *
 * 1. a strategy that names several routes for one public model is several
 *    ordered attempts, so a model the provider does not serve falls through to
 *    the next unit instead of failing the request;
 * 2. a 404 cools the *route*, not the key — the account stays usable for its
 *    other models;
 * 3. an empty balance answers 402 instead of masquerading as a rate limit;
 * 4. the log keeps a digest of the upstream body, so "returned 404" is
 *    diagnosable without replaying the request.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider, LlmStrategy } from '../llm-config.ts';

function provider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-SECRET-1` }],
    models: { flash: 'flash', hy4: 'hy4', hy3: 'hy3' },
    ...over,
  };
}

/** One provider, three models, one unit per model. */
function threeModelConfig(over: Partial<LlmStrategy> = {}): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [provider('wb')],
    strategies: [
      {
        id: 'wb',
        type: 'round_robin',
        members: [
          { provider: 'wb', model: 'flash' },
          { provider: 'wb', model: 'hy4' },
          { provider: 'wb', model: 'hy3' },
        ],
        retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
        ...over,
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['wb'] }],
  };
}

/**
 * One public name served by two upstream ids on the same provider — the shape
 * a chain like A-A1 → B-A1 needs, and the only way to test "try the next unit
 * for the *same* request".
 */
function sharedModelConfig(over: Partial<LlmStrategy> = {}): LlmConfig {
  const cfg = threeModelConfig(over);
  const strategy = cfg.strategies[0]!;
  strategy.members = [
    { provider: 'wb', model: 'shared', upstreamModel: 'flash' },
    { provider: 'wb', model: 'shared', upstreamModel: 'hy4' },
  ];
  strategy.modelAliases = { shared: 'shared' };
  cfg.providers[0]!.models = { flash: 'shared', hy4: 'shared' };
  return cfg;
}

/**
 * A keyless relay serving three models — the shape of a local multi-channel
 * gateway (uni-api) that needs no credentials. Its pool has one synthetic `''`
 * key shared by every model.
 */
function keylessThreeModelConfig(over: Partial<LlmStrategy> = {}): LlmConfig {
  const cfg = threeModelConfig(over);
  cfg.providers[0]!.keys = [];
  return cfg;
}

type StubResponse = { status?: number; body?: string } | (() => Response);

function stubUpstream(responses: StubResponse[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (typeof spec === 'function') return spec();
    const { body = JSON.stringify({ ok: true }), status = 200 } = spec;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SSE_OK =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function post(gateway: LlmGateway, model: string) {
  return fetch(`${gateway.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('LlmGateway — switching units', () => {
  let gateway: LlmGateway;
  let configDir = '';
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'craft-units-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    if (sandboxDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
    else process.env.CRAFT_CONFIG_DIR = sandboxDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it('falls through to the next unit when the provider does not serve this model', async () => {
    // flash 404s on the relay, hy4 answers. Before units this was one attempt
    // on one provider: the 404 cooled the only key and the request failed even
    // though a healthy route was configured right behind it.
    const { impl, calls } = stubUpstream([
      { status: 404, body: JSON.stringify({ error: { message: 'model flash not found' } }) },
      { status: 200, body: SSE_OK },
    ]);
    gateway = new LlmGateway({ getConfig: () => sharedModelConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'shared');
    expect(res.status).toBe(200);
    await res.text();

    // Two units, two upstream calls, in declared order.
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4']);
  });

  it('cools only the failed route: the next model in the group serves the turn', async () => {
    const { impl, calls } = stubUpstream([
      { status: 404, body: JSON.stringify({ error: { message: 'model flash not found' } }) },
      { status: 200, body: SSE_OK },
    ]);
    gateway = new LlmGateway({ getConfig: () => threeModelConfig(), fetchImpl: impl });
    await gateway.start();

    // flash 404s; the same request falls through to the next model in the group.
    const first = await post(gateway, 'flash');
    expect(first.status).toBe(200);
    await first.text();
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4']);

    // The failed route stays cooled, so the next request skips it entirely.
    const other = await post(gateway, 'flash');
    expect(other.status).toBe(200);
    await other.text();
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4', 'hy4']);
  });

  it('refuses a route that is cooling, without blaming the account', async () => {
    const { impl, calls } = stubUpstream([
      { status: 404, body: JSON.stringify({ error: { message: 'model flash not found' } }) },
    ]);
    gateway = new LlmGateway({ getConfig: () => threeModelConfig(), fetchImpl: impl });
    await gateway.start();

    // Every model in the group 404s, so every route cools.
    const first = await post(gateway, 'flash');
    expect(first.status).toBe(503);
    await first.text();
    expect(calls).toHaveLength(3);

    const second = await post(gateway, 'flash');
    expect(second.status).toBe(503);
    const text = await second.text();
    expect(text).toContain('no healthy account');
    // The second request never left the gateway: all three routes are cooling.
    expect(calls).toHaveLength(3);
  });

  it('answers 402 when the account has no balance', async () => {
    const { impl } = stubUpstream([
      { status: 402, body: JSON.stringify({ error: { message: 'insufficient balance', type: 'billing' } }) },
    ]);
    gateway = new LlmGateway({ getConfig: () => threeModelConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'flash');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('insufficient_balance');
    expect(body.error.message).toContain('balance');
  });

  it('classifies a balance body on a 400 as quota, not as a bad request', async () => {
    // Relays routinely answer 「余额不足」 with 400; calling that a client error
    // hides a dead account behind "bad request".
    const { impl } = stubUpstream([
      { status: 400, body: JSON.stringify({ error: { message: '账户余额不足，请充值' } }) },
    ]);
    gateway = new LlmGateway({ getConfig: () => threeModelConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'flash');
    expect(res.status).toBe(402);
    await res.text();
  });

  it('keeps a digest of the upstream body on the failure row', async () => {
    const { impl } = stubUpstream([
      { status: 404, body: JSON.stringify({ error: { message: 'no such model: flash' } }) },
    ]);
    gateway = new LlmGateway({ getConfig: () => threeModelConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'flash');
    await res.text();

    const rows = gateway.drainUsage();
    const row = rows.find((r) => r.status === 'error')!;
    expect(row.unitId).toBe('wb::flash');
    expect(row.error).toContain('does not serve this model');
    expect(row.error).toContain('no such model: flash');
  });

  it('honours switchPolicy stop: no second unit is attempted', async () => {
    const { impl, calls } = stubUpstream([
      { status: 404, body: JSON.stringify({ error: { message: 'model not found' } }) },
    ]);
    gateway = new LlmGateway({
      getConfig: () => sharedModelConfig({ switchPolicy: { model_not_found: 'stop' } }),
      fetchImpl: impl,
    });
    await gateway.start();

    const res = await post(gateway, 'shared');
    expect(res.status).toBe(503);
    await res.text();
    expect(calls).toHaveLength(1);
  });

  it('cools the route, not the shared key, when a keyless relay rate-limits one model', async () => {
    // A keyless provider has a single synthetic `''` key shared by every model.
    // A 429 for `flash` must cool the flash *route* and fall through to hy4 —
    // cooling the shared key would take the whole relay down (2026-10-29).
    const { impl, calls } = stubUpstream([
      { status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) },
      { status: 200, body: SSE_OK },
    ]);
    gateway = new LlmGateway({ getConfig: () => keylessThreeModelConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'flash');
    expect(res.status).toBe(200);
    await res.text();
    // flash 429s and cools its route; hy4 on the same relay still serves.
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4']);
  });

  it('a keyless relay rate limit stays model-scoped across requests', async () => {
    // After flash is cooled, the next request for flash skips it and lands on
    // hy4 directly — the shared key is NOT cooled, so hy4 stays reachable.
    const { impl, calls } = stubUpstream([
      { status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) },
      { status: 200, body: SSE_OK },
      { status: 200, body: SSE_OK },
    ]);
    gateway = new LlmGateway({ getConfig: () => keylessThreeModelConfig(), fetchImpl: impl });
    await gateway.start();

    const first = await post(gateway, 'flash');
    expect(first.status).toBe(200);
    await first.text();
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4']);

    const second = await post(gateway, 'flash');
    expect(second.status).toBe(200);
    await second.text();
    // The failed route stays cooled, so the second request goes straight to hy4.
    expect(calls.map((c) => c.body.model)).toEqual(['flash', 'hy4', 'hy4']);
  });
});
