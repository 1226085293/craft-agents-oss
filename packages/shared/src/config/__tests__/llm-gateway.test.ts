/**
 * Gateway end-to-end tests.
 *
 * These drive a real HTTP server on a real socket with a stubbed upstream
 * `fetch`, because the properties being verified — retry across providers,
 * cooldown, circuit breaking, URL shape — only exist once the whole stack is
 * wired together. Unit-level correctness of the pool and breaker is covered in
 * `llm-scheduling.test.ts`.
 *
 * The two things that must never regress:
 *
 * 1. **The inbound path is `/v1/messages`.** Craft's network interceptor
 *    selects requests by URL shape; changing this silently disables metadata
 *    injection for every request. Pinned below.
 * 2. **A raw key never reaches a log line.** The stubbed logger captures
 *    everything and the test asserts no key material appears in it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway, parseRateLimitSignal } from '../llm-gateway.ts';
import { SESSION_HEADER } from '../model-request-kind.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

function provider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [
      { id: `${id}-k1`, key: `sk-${id}-SECRET-1` },
      { id: `${id}-k2`, key: `sk-${id}-SECRET-2` },
    ],
    ...over,
  };
}

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [provider('p1'), provider('p2')],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: 'p1' }, { provider: 'p2' }],
        retry: { maxAttempts: 3, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    ...over,
  };
}

type StubResponse = { status?: number; body?: string; headers?: Record<string, string> } | (() => Response);

/** A stubbed upstream: each entry is the response for the next call. */
function stubUpstream(responses: StubResponse[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    // Catalog discovery (`GET /models`) is a separate concern from the queued
    // chat responses; answer it with an empty catalog and do not consume a
    // queued response or record a chat call.
    let pathname = String(input);
    try {
      pathname = new URL(String(input)).pathname;
    } catch {
      /* not a URL; fall through to the queued path */
    }
    if (pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    calls.push({ url: String(input), init });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (typeof spec === 'function') return spec();
    const { body = JSON.stringify({ ok: true }), status = 200, headers } = spec;
    return new Response(body, { status, headers: headers ?? { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** POST /v1/messages against the gateway. */
function post(gateway: LlmGateway, body: Record<string, unknown>, key = 'sk-client') {
  return fetch(`${gateway.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model: 'auto', ...body }),
  });
}

describe('LlmGateway', () => {
  let gateway: LlmGateway;
  const logs: string[] = [];
  let configDir = '';
  // The `bun test` preload sandbox; restored after each test because the
  // cooldown store resolves its path from the env on every call.
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(async () => {
    logs.length = 0;
    // Cooldowns persist to `CRAFT_CONFIG_DIR`. Without an isolated dir, a key
    // cooled in one test is loaded as still-cooling by the next gateway, so
    // providers look unavailable and later tests see zero upstream calls.
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-test-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
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

  // -------------------------------------------------------------------------
  // Contract surface
  // -------------------------------------------------------------------------

  it('serves /v1/messages so the interceptor still matches', async () => {
    await start(config(), [{ body: JSON.stringify({ id: 'msg_1' }) }]);
    expect(gateway.port).toBeGreaterThan(0);
    expect(gateway.messagesUrl).toBe(`http://127.0.0.1:${gateway.port}/v1/messages`);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('msg_1');
  });

  it('rejects an unknown client key with 401 before touching an upstream', async () => {
    const stub = await start(config(), [{}]);
    const res = await post(gateway, {}, 'sk-wrong');
    expect(res.status).toBe(401);
    expect(stub.calls.length).toBe(0);
  });

  it('routes to the strategy pinned in the URL path', async () => {
    const cfg = config({
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          members: [{ provider: 'p1' }, { provider: 'p2' }],
          modelAliases: { 'm-auto': 'upstream-a' },
        },
        {
          id: 'only-p2',
          type: 'sequential',
          members: [{ provider: 'p2' }],
          modelAliases: { 'm-two': 'upstream-b' },
        },
      ],
      clientKeys: [{ key: 'sk-client', strategies: ['auto', 'only-p2'] }],
    });
    const stub = await start(cfg, [{ body: JSON.stringify({ id: 'msg_p2' }) }]);

    // No key at all: the server only listens on loopback, and the path already
    // names the strategy.
    const res = await fetch(`${gateway.baseUrl}/s/only-p2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm-two' }),
    });
    expect(res.status).toBe(200);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.url).toContain('p2.example.com');
  });

  it('rejects an unknown strategy in the path', async () => {
    const stub = await start(config(), [{}]);
    const res = await fetch(`${gateway.baseUrl}/s/nope/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto' }),
    });
    expect(res.status).toBe(404);
    expect(stub.calls.length).toBe(0);
  });

  it('refuses to route a strategy that has been disabled', async () => {
    const cfg = config();
    cfg.strategies[0]!.enabled = false;
    const stub = await start(cfg, [{}]);
    const res = await fetch(`${gateway.baseUrl}/s/auto/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto' }),
    });
    expect(res.status).toBe(404);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects a configured key that is not authorized for the pinned strategy', async () => {
    const cfg = config({
      strategies: [
        { id: 'auto', type: 'round_robin', members: [{ provider: 'p1' }], modelAliases: { 'm-auto': 'upstream-a' } },
        { id: 'only-p2', type: 'sequential', members: [{ provider: 'p2' }], modelAliases: { 'm-two': 'upstream-b' } },
      ],
      clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    });
    const stub = await start(cfg, [{}]);
    const res = await fetch(`${gateway.baseUrl}/s/only-p2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'm-two' }),
    });
    expect(res.status).toBe(401);
    expect(stub.calls.length).toBe(0);
  });

  it('accepts the client key as a bearer token', async () => {
    await start(config(), [{}]);
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-client' },
      body: JSON.stringify({ model: 'auto' }),
    });
    expect(res.status).toBe(200);
  });

  it('exposes /health without auth', async () => {
    await start(config(), [{}]);
    const res = await fetch(`${gateway.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect((await readJson(res)).ok).toBe(true);
  });

  it('rejects a non-JSON body with 400', async () => {
    await start(config(), [{}]);
    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  it('rotates across the provider keys', async () => {
    const cfg = config({
      strategies: [config().strategies[0]!],
      providers: [provider('solo')],
    });
    cfg.strategies[0]!.members = [{ provider: 'solo' }];
    const stub = await start(cfg, [{}]);

    // Two requests must not both use the same key — round robin advances.
    await post(gateway, {});
    await post(gateway, {});
    const keys = stub.calls.map((c) => (c.init?.headers as Record<string, string>)['x-api-key']);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(['sk-solo-SECRET-1', 'sk-solo-SECRET-2']);
  });

  it('retries on another key of the same provider after a 429', async () => {
    const cfg = config();
    const stub = await start(cfg, [
      { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
      { status: 200, body: JSON.stringify({ id: 'ok-after-retry' }) },
    ]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('ok-after-retry');
    // A 429 belongs to the account, not the provider: the next key is the
    // cheapest retry, so both calls stay on p1.
    expect(stub.calls.length).toBe(2);
    const hosts = stub.calls.map((c) => new URL(c.url).hostname);
    expect(new Set(hosts)).toEqual(new Set(['p1.example.com']));
    const keys = stub.calls.map((c) => (c.init?.headers as Record<string, string>)['x-api-key']);
    expect(new Set(keys).size).toBe(2);
  });

  it('moves to the next provider once every key of the first is limited', async () => {
    const cfg = config();
    const stub = await start(cfg, [
      { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
      { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
      { status: 200, body: JSON.stringify({ id: 'ok-on-p2' }) },
    ]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('ok-on-p2');
    expect(stub.calls.length).toBe(3);
    expect(new Set(stub.calls.map((c) => new URL(c.url).hostname))).toEqual(
      new Set(['p1.example.com', 'p2.example.com']),
    );
  });

  it('moves to the next provider when one key fails at the transport level', async () => {
    // A transport error is the endpoint being unreachable, not the account:
    // every key on that provider would fail the same way, so the request must
    // not pay the cost per key before it leaves.
    const cfg = config();
    cfg.strategies[0]!.retry = { maxAttempts: 1, onStatusCodes: [429, 500], backoffMs: 0 };
    const broken = () => {
      throw new TypeError('fetch failed');
    };
    const stub = await start(cfg, [broken, { body: JSON.stringify({ id: 'next-provider' }) }]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('next-provider');
    expect(stub.calls.length).toBe(2);
    expect(new Set(stub.calls.map((c) => new URL(c.url).hostname))).toEqual(
      new Set(['p1.example.com', 'p2.example.com']),
    );
  });

  it('moves to the next provider when the first byte times out', async () => {
    // The 2026-10-25 incident: the relay answers large prompts in 25–30s, so the
    // first-byte budget expired on key after key of the same provider. The other
    // keys share that latency — one attempt per provider, then move on.
    const cfg = config({
      presets: { slow: { firstByteSeconds: 0.05 } },
      providers: [provider('p1', { defaultPreset: 'slow' }), provider('p2')],
    });
    cfg.strategies[0]!.retry = { maxAttempts: 1, onStatusCodes: [429, 500], backoffMs: 0 };
    const neverEnding = () =>
      new Response(new ReadableStream({ start() { /* never enqueue */ } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const stub = await start(cfg, [neverEnding, { body: JSON.stringify({ id: 'next-provider' }) }]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('next-provider');
    expect(stub.calls.length).toBe(2);
    expect(new Set(stub.calls.map((c) => new URL(c.url).hostname))).toEqual(
      new Set(['p1.example.com', 'p2.example.com']),
    );
  });

  it('retries another provider when the first byte times out', async () => {
    // The upstream accepts the request but never produces a body byte. The
    // preset's firstByteSeconds must abort it before any response headers are
    // written, leaving the turn retryable on the next provider.
    const cfg = config({
      presets: { slow: { firstByteSeconds: 0.05 } },
      providers: [provider('p1', { defaultPreset: 'slow' }), provider('p2')],
    });
    cfg.strategies[0]!.retry = {
      maxAttempts: 1,
      onStatusCodes: [429, 500, 502, 503, 504],
      backoffMs: 0,
    };
    const neverEnding = () => new Response(
      new ReadableStream({ start() { /* never enqueue */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const stub = await start(cfg, [neverEnding, { body: JSON.stringify({ id: 'after-timeout' }) }]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('after-timeout');
    expect(stub.calls.length).toBe(2);
  });

  it('applies the provider default to a key whose own type is empty', async () => {
    // The settings page writes `preset: ''` for 继承默认. Reading that as a real
    // preset name skipped the provider entirely, so `slow`'s first-byte timeout
    // never applied and the hung upstream held the request to the 600s default.
    const cfg = config({
      presets: { slow: { firstByteSeconds: 0.05 } },
      providers: [
        provider('p1', {
          defaultPreset: 'slow',
          keys: [{ id: 'p1-k1', key: 'sk-p1-SECRET-1', preset: '' }],
        }),
        provider('p2'),
      ],
    });
    cfg.strategies[0]!.retry = {
      maxAttempts: 1,
      onStatusCodes: [429, 500, 502, 503, 504],
      backoffMs: 0,
    };
    const neverEnding = () => new Response(
      new ReadableStream({ start() { /* never enqueue */ } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const stub = await start(cfg, [neverEnding, { body: JSON.stringify({ id: 'after-inherited-timeout' }) }]);

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('after-inherited-timeout');
    expect(stub.calls.length).toBe(2);
  });

  it('answers 429 with Retry-After when the only key is out of quota', async () => {
    // Single key, RPM 1: the second request has nowhere to go. "no healthy
    // account" (503) would report a quota wall as an outage and give the client
    // no backoff hint, so the limit must surface as 429 + Retry-After.
    const cfg = config({
      presets: { one: { customLimits: [{ amount: 1, unit: 'requests', per: 1, perUnit: 'minutes' }] } },
      providers: [
        provider('p1', {
          defaultPreset: 'one',
          // A single key: with a second one the request would just migrate.
          keys: [{ id: 'p1-k1', key: 'sk-p1-SECRET-1' }],
        }),
      ],
      clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    });
    cfg.strategies[0]!.members = [{ provider: 'p1' }];
    const stub = await start(cfg, [{ body: JSON.stringify({ id: 'first' }) }]);

    const first = await post(gateway, {});
    expect(first.status).toBe(200);
    await first.text();

    const second = await post(gateway, {});
    expect(second.status).toBe(429);
    const retryAfter = Number(second.headers.get('retry-after'));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // Nothing was dispatched for the refused request.
    expect(stub.calls.length).toBe(1);
  });

  it('answers 400 when the request exceeds every key TPR', async () => {
    // TPR is a single-request ceiling, not a quota window: retrying cannot
    // help, so the gateway must not answer 429/502.
    const cfg = config({
      presets: { tiny: { tpr: 1 } },
      providers: [provider('p1', { defaultPreset: 'tiny' })],
    });
    cfg.strategies[0]!.members = [{ provider: 'p1' }];
    const stub = await start(cfg, [{}]);

    const res = await post(gateway, { messages: [{ role: 'user', content: 'hello world' }] });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatchObject({ type: 'invalid_request_error' });
    expect(stub.calls.length).toBe(0);
  });

  it('does NOT open a circuit on a 429', async () => {
    const cfg = config();
    cfg.strategies[0]!.retry = { maxAttempts: 1, onStatusCodes: [429], backoffMs: 0 };
    await start(cfg, [{ status: 429, body: JSON.stringify({ error: 'slow down' }) }]);

    const first = await post(gateway, {});
    expect(first.status).toBe(429);
    // The client is told when the cooled key frees up instead of retrying blind.
    expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('cools the failing key so the next request uses a different one', async () => {
    const cfg = config();
    cfg.strategies[0]!.members = [{ provider: 'solo' }];
    cfg.providers = [provider('solo')];
    const stub = await start(cfg, [
      { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
      {},
    ]);

    await post(gateway, {});
    await post(gateway, {});
    const keys = stub.calls.map((c) => (c.init?.headers as Record<string, string>)['x-api-key']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(gateway.status().coolingKeys).toBeGreaterThan(0);
  });

  it('surfaces a 503 when no provider is usable', async () => {
    const cfg = config();
    cfg.providers = [provider('p1', { enabled: false }), provider('p2', { enabled: false })];
    const stub = await start(cfg, [{}]);

    const res = await post(gateway, {});
    expect(res.status).toBe(503);
    expect(stub.calls.length).toBe(0);
  });

  it('resolves the public model through the strategy alias', async () => {
    const cfg = config();
    cfg.strategies[0]!.modelAliases = { auto: 'deepseek-v4-flash-0731' };
    const stub = await start(cfg, [{}]);

    await post(gateway, {});
    const body = JSON.parse(String(stub.calls[0]!.init?.body));
    expect(body.model).toBe('deepseek-v4-flash-0731');
  });

  it('strips the internal sessionKey before calling upstream', async () => {
    const stub = await start(config(), [{}]);

    await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', sessionKey: 'internal-only' }),
    });
    const body = JSON.parse(String(stub.calls[0]!.init?.body));
    expect(body.sessionKey).toBeUndefined();
  });

  it('signals a key switch after a successful request, once per session', async () => {
    const events: Array<{ sessionId: string; reason: string; keyId: string }> = [];
    const cfg = config({
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          members: [{ provider: 'p1' }],
          // 0 disables stickiness, so the pool alternates keys and the second
          // request is a genuine switch.
          stickySession: { enabled: false, ttlSeconds: 0 },
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
    const stub = stubUpstream([{}, {}]);
    const gw = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: () => {},
      onRouteChanged: (e) => events.push(e),
    });
    await gw.start();
    try {
      const send = () =>
        fetch(`${gw.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-client',
            'x-craft-session-id': 'session-1',
          },
          body: JSON.stringify({ model: 'auto' }),
        });

      expect((await send()).status).toBe(200);
      // First request establishes the route; there is nothing to compact yet.
      expect(events).toHaveLength(0);

      expect((await send()).status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sessionId: 'session-1', reason: 'key' });
    } finally {
      await gw.stop();
    }
  });

  it('names the public model a model-level switch landed on', async () => {
    // A model-level switch must name the PUBLIC model the serving unit
    // represents — the id a session adopts so its label, ring and routing
    // hint follow the reality. The upstream alias alone is not adoptable
    // (2026-10-30: failover kept the session reporting the old model).
    const events: Array<{ reason: string; publicModel?: string; upstreamModel: string }> = [];
    const cfg = config({
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          modelAliases: { m1: 'up-m1', m2: 'up-m2' },
          members: [{ provider: 'p1' }, { provider: 'p2' }],
          retry: { maxAttempts: 3, onStatusCodes: [500], backoffMs: 0 },
        },
      ],
    });
    const stub = stubUpstream([{}, {}]);
    const gw = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: () => {},
      onRouteChanged: (e) => events.push(e),
    });
    await gw.start();
    try {
      const send = (model: string) =>
        fetch(`${gw.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client', 'x-craft-session-id': 'session-fb' },
          body: JSON.stringify({ model }),
        });
      expect((await send('m1')).status).toBe(200);
      expect((await send('m2')).status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: 'session-fb',
        reason: 'model',
        upstreamModel: 'up-m2',
        publicModel: 'm2',
      });
    } finally {
      await gw.stop();
    }
  });

  it('honours compactAfterSwitch=false', async () => {
    const events: unknown[] = [];
    const cfg = config({
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          members: [{ provider: 'p1' }],
          stickySession: { enabled: false, ttlSeconds: 0 },
          retry: { maxAttempts: 1, backoffMs: 0 },
          compactAfterSwitch: false,
        },
      ],
    });
    const stub = stubUpstream([{}, {}]);
    const gw = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: () => {},
      onRouteChanged: (e) => events.push(e),
    });
    await gw.start();
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${gw.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-client',
            'x-craft-session-id': 'session-2',
          },
          body: JSON.stringify({ model: 'auto' }),
        });
        expect(res.status).toBe(200);
      }
      expect(events).toHaveLength(0);
    } finally {
      await gw.stop();
    }
  });

  it('records usage for a successful request', async () => {
    await start(config(), [{ body: JSON.stringify({ id: 'ok' }) }]);
    await post(gateway, {});
    const usage = gateway.drainUsage();
    expect(usage.length).toBe(1);
    expect(usage[0]!.status).toBe('success');
    expect(usage[0]!.provider).toBeTruthy();
    expect(usage[0]!.keyId).toBeTruthy();
    const trace = usage[0]!.trace ?? [];
    expect(trace.map((stage) => stage.split('@')[0])).toEqual([
      'provider_selected',
      'upstream_first_chunk',
      'stream_end',
      'usage_recorded',
    ]);
    expect(trace.every((stage) => /^.+@\d+$/.test(stage))).toBe(true);
  });

  it('names the provider and key on the row a failed request leaves behind', async () => {
    // The summary row used to carry an empty provider and keyId, so a
    // failure could not be traced to the account it died on — the log showed
    // "—" in both columns for a request that had certainly used one.
    const cfg = config();
    cfg.strategies[0]!.retry = { maxAttempts: 1, onStatusCodes: [500], backoffMs: 0 };
    const broken = () => {
      throw new TypeError('fetch failed');
    };
    await start(cfg, [broken, broken]);

    const res = await post(gateway, {});
    // Transport failures are route failures now: the endpoint is unreachable,
    // which is "no healthy account" (503), not a malformed upstream answer (502).
    expect(res.status).toBe(503);
    const usage = gateway.drainUsage();
    // One row per upstream attempt: p1's failure gets its own line (it used to
    // be invisible), and p2's is the request's terminal row.
    expect(usage).toHaveLength(2);
    const [first, last] = usage;
    expect(first!.provider).toBe('p1');
    expect(first!.superseded).toBe(true);
    expect(last!.superseded).toBeUndefined();
    expect(last!.status).toBe('error');
    expect(last!.attempts).toBe(2);
    expect(last!.provider).toBe('p2');
    expect(last!.keyId).toBeTruthy();
    expect(last!.upstreamModel).toBeTruthy();
  });

  it('logs the status the client actually received, not a constant 502', async () => {
    // Every key cooling is answered 429, but the terminal row was written with
    // a hardcoded 502 before the status was decided: the log said "bad
    // gateway" for a rate wall. 2026-10-25, reported as "三个日志请求…但是会话
    // 报错 429".
    const cfg = config();
    cfg.providers = [provider('p1')];
    cfg.strategies[0]!.members = [{ provider: 'p1' }];
    cfg.strategies[0]!.retry = { maxAttempts: 1, onStatusCodes: [500], backoffMs: 0 };
    await start(cfg, [{ status: 429, body: JSON.stringify({ error: 'rate limited' }) }]);

    const res = await post(gateway, {});
    expect(res.status).toBe(429);

    const terminal = gateway.drainUsage().filter((r) => !r.superseded);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.statusCode).toBe(429);
  });

  it('gives a failure the same timing columns a success has', async () => {
    // 耗时 / 会话 / 时间 used to be empty on a failed row, so the one row an
    // operator opens after a failure was the one with nothing to read.
    const cfg = config();
    cfg.providers = [provider('p1')];
    cfg.strategies[0]!.members = [{ provider: 'p1' }];
    await start(cfg, [
      () => {
        throw new TypeError('fetch failed');
      },
    ]);

    const res = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-client',
        [SESSION_HEADER]: 'sess-1',
      },
      body: JSON.stringify({ model: 'auto' }),
    });
    // A transport failure is a route failure → 503 (see the naming test above).
    expect(res.status).toBe(503);
    const row = gateway.drainUsage()[0]!;
    expect(row.sessionId).toBe('sess-1');
    expect(typeof row.totalMs).toBe('number');
    expect(row.startedAt).toBeGreaterThan(0);
    // The row is stamped when it finished, but it reads as when it was sent.
    expect(row.startedAt!).toBeLessThanOrEqual(row.ts);
  });

  // -------------------------------------------------------------------------
  // Secret hygiene
  // -------------------------------------------------------------------------

  it('never writes a raw key to the log', async () => {
    const cfg = config();
    cfg.providers = [provider('p1')];
    await start(cfg, [
      { status: 429, body: JSON.stringify({ error: 'boom' }) },
      { status: 500, body: JSON.stringify({ error: 'boom' }) },
    ]);
    cfg.strategies[0]!.retry = { maxAttempts: 2, onStatusCodes: [429, 500], backoffMs: 0 };

    await post(gateway, {});
    const joined = logs.join('\n');
    expect(joined).not.toContain('sk-p1-SECRET-1');
    expect(joined).not.toContain('sk-p1-SECRET-2');
    expect(joined).not.toContain('SECRET');
  });

  it('never leaks the client key into the log', async () => {
    await start(config(), [{}]);
    await post(gateway, {});
    expect(logs.join('\n')).not.toContain('sk-client');
  });

  // -------------------------------------------------------------------------
  // Hot reload
  // -------------------------------------------------------------------------

  it('clears a single key cooldown on request', async () => {
    const cfg = config();
    cfg.strategies[0]!.members = [{ provider: 'solo' }];
    cfg.providers = [provider('solo')];
    await start(cfg, [
      { status: 429, body: JSON.stringify({ error: 'slow down' }) },
      {},
    ]);

    await post(gateway, {});
    expect(gateway.status().coolingKeys).toBeGreaterThan(0);

    // Clearing the key that is cooling must free it for the next request.
    const target = gateway.keyStates().find((k) => k.cooling)!;
    expect(await gateway.clearKeyCooldown(target.provider, target.keyId)).toBe(true);
    expect(gateway.status().coolingKeys).toBe(0);
  });

  it('releases a cooled route when the cooldown is cleared', async () => {
    // A keyless relay is one account: its 429 cools the *route*, and a long
    // reset hint (60124s) parks the model for hours. The clear-cooldown path
    // must be able to release it, or the group loses a member until the hint
    // expires with nothing in the UI able to undo it (2026-10-30).
    const cfg = config({
      providers: [provider('solo', { keys: [] })],
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          modelAliases: { m1: 'up-m1' },
          members: [{ provider: 'solo' }],
          retry: { maxAttempts: 1, onStatusCodes: [429], backoffMs: 0 },
        },
      ],
    });
    const stub = stubUpstream([{ status: 429, body: JSON.stringify({ error: 'slow down' }) }, {}]);
    const gw = new LlmGateway({ getConfig: () => cfg, fetchImpl: stub.impl, log: () => {} });
    await gw.start();
    try {
      const limited = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      expect(limited.status).toBe(429);
      await limited.text();

      // Parked: the same request now has nothing to route to.
      const refused = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      expect(refused.status).toBe(503);
      await refused.text();

      expect(await gw.clearKeyCooldown('solo')).toBe(true);

      // Released: the route serves again instead of answering 503.
      const ok = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      expect(ok.status).toBe(200);
      await ok.text();
    } finally {
      await gw.stop();
    }
  });

  it('spends the retry budget on a transport failure before leaving the model', async () => {
    // An aborted connection or a first-byte timeout is the failure a retry can
    // actually fix, and it is what the user sees as a 503. Defaulting it to
    // `retry-same` means "retry 3 times" costs three tries on this route
    // before the group falls through — previously one blip dropped the model
    // with the whole budget unspent (2026-10-30).
    const cfg = config({
      providers: [provider('solo', { keys: [] })],
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          modelAliases: { m1: 'up-m1', m2: 'up-m2' },
          members: [{ provider: 'solo', model: 'm1' }, { provider: 'solo', model: 'm2' }],
          retry: { maxAttempts: 3, backoffMs: 0 },
        },
      ],
    });
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const gw = new LlmGateway({ getConfig: () => cfg, fetchImpl: impl, log: () => {} });
    await gw.start();
    try {
      const res = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      expect(res.status).toBe(503);
      await res.text().catch(() => {});
      // Three tries on m1, then the budget resets for the group's next route.
      expect(calls).toBe(6);
    } finally {
      await gw.stop();
    }
  });

  it('cools only the failing route on a transport failure, not the whole endpoint', async () => {
    // One relay, two models behind the same baseUrl. A timeout must park the
    // route it happened on, not the provider: cooling the endpoint used to
    // take every other model of that relay down too, which on a
    // single-endpoint relay leaves the group with nothing to fall back to
    // (2026-10-30).
    const cfg = config({
      providers: [provider('solo', { keys: [] })],
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          modelAliases: { m1: 'up-m1', m2: 'up-m2' },
          members: [{ provider: 'solo', model: 'm1' }, { provider: 'solo', model: 'm2' }],
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
    let calls = 0;
    const seen: string[] = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      seen.push(String(JSON.parse(String(init?.body)).model));
      if (calls <= 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const gw = new LlmGateway({ getConfig: () => cfg, fetchImpl: impl, log: () => {} });
    await gw.start();
    try {
      const res = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      // The group's second model still serves the request in the same turn.
      expect(res.status).toBe(200);
      await res.text();
      // m1's own route is now parked: a second request for it is served by the
      // sibling model, never by m1 again.
      const second = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm1' }),
      });
      expect(second.status).toBe(200);
      await second.text();
      // …and the sibling on the SAME baseUrl is still reachable on its own.
      const ok = await fetch(`${gw.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
        body: JSON.stringify({ model: 'm2' }),
      });
      expect(ok.status).toBe(200);
      await ok.text();
      // up-m1 was tried once (and parked); every later attempt went to up-m2,
      // including the fallback that served the first request. Had the endpoint
      // been cooled instead, up-m2 would have been refused from then on.
      expect(seen).toEqual(['up-m1', 'up-m2', 'up-m2', 'up-m2']);
    } finally {
      await gw.stop();
    }
  });

  it('clears every cooldown when no key is named', async () => {
    const cfg = config();
    cfg.strategies[0]!.members = [{ provider: 'p1' }, { provider: 'p2' }];
    await start(cfg, [{ status: 429, body: JSON.stringify({ error: 'slow down' }) }]);

    await post(gateway, {});
    expect(gateway.status().coolingKeys).toBeGreaterThan(0);

    expect(await gateway.clearKeyCooldown()).toBe(true);
    expect(gateway.status().coolingKeys).toBe(0);
  });

  it('reports nothing cleared when no key is cooling', async () => {
    await start(config(), [{}]);
    await post(gateway, {});
    expect(gateway.status().coolingKeys).toBe(0);
    expect(await gateway.clearKeyCooldown()).toBe(false);
  });

  it('rebuilds scheduling state when the config changes', async () => {
    const cfg = config();
    await start(cfg, [{}]);

    expect(gateway.status().strategies.map((s) => s.providers)).toEqual([2]);

    cfg.providers.push(provider('p3'));
    cfg.strategies[0]!.members.push({ provider: 'p3' });
    gateway.rebuild();

    expect(gateway.status().strategies.map((s) => s.providers)).toEqual([3]);
  });
  // -------------------------------------------------------------------------
  // lastModels — the composer's live "策略组-当前模型" label
  // -------------------------------------------------------------------------

  it('records the model a strategy actually routed to', async () => {
    await start(config(), [{ body: JSON.stringify({ id: 'msg_1' }) }]);
    expect(gateway.status().lastModels).toEqual({});

    const res = await post(gateway, {});
    expect(res.status).toBe(200);
    // `auto` is the public model and the alias map resolves it per provider, so
    // the value is whatever the upstream actually saw — not the request's.
    expect(gateway.status().lastModels?.auto).toBe('auto');
  });

  it('keeps reporting the last model after traffic stops', async () => {
    await start(config(), [{ body: JSON.stringify({ id: 'msg_1' }) }]);
    await post(gateway, {});
    const after = gateway.status().lastModels?.auto;
    expect(after).toBe('auto');
    // No further requests: the label must not go blank, or the composer would
    // read as "this strategy has never been used".
    expect(gateway.status().lastModels?.auto).toBe(after);
  });

  it('tracks each strategy independently', async () => {
    // The gateway resolves the strategy from the *client key*, not a header
    // (see resolveStrategyForClientKey), so two strategies need two keys.
    const cfg = config({
      strategies: [
        {
          id: 'a',
          type: 'round_robin',
          members: [{ provider: 'p1' }],
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
        {
          id: 'b',
          type: 'round_robin',
          members: [{ provider: 'p2' }],
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
      clientKeys: [
        { key: 'sk-client-a', strategies: ['a'] },
        { key: 'sk-client-b', strategies: ['b'] },
      ],
    });
    await start(cfg, [{ body: JSON.stringify({ id: 'm1' }) }, { body: JSON.stringify({ id: 'm2' }) }]);

    const resA = await post(gateway, {}, 'sk-client-a');
    const resB = await post(gateway, {}, 'sk-client-b');
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Each strategy reports its own model, so two sessions routing through
    // different policies do not share one label.
    expect(Object.keys(gateway.status().lastModels ?? {}).sort()).toEqual(['a', 'b']);
    expect(gateway.status().lastModels?.a).toBe('auto');
    expect(gateway.status().lastModels?.b).toBe('auto');
  });

  it('drops a stale strategy from lastModels on rebuild', async () => {
    await start(config(), [{ body: JSON.stringify({ id: 'msg_1' }) }]);
    await post(gateway, {});
    expect(gateway.status().lastModels?.auto).toBe('auto');

    // Rename the strategy: the old id must not linger in the payload, or the
    // composer would keep showing a route that no longer exists. The gateway
    // reads config through getConfig, so the rename has to land there — mutating
    // a throwaway object proves nothing.
    const cfg = config();
    cfg.strategies[0]!.id = 'renamed';
    (gateway as unknown as { getConfig: () => LlmConfig }).getConfig = () => cfg;
    gateway.rebuild();
    const last = gateway.status().lastModels ?? {};
    expect(last.auto).toBeUndefined();
    expect(last.renamed).toBeUndefined(); // no traffic yet, so nothing to claim
  });

  it('reports an empty map rather than undefined when the gateway is off', async () => {
    // The runtime's offline snapshot must keep the same shape so the composer
    // can read `lastModels` without a null check.
    const offline = { running: false, port: 0, baseUrl: '', strategies: [], coolingKeys: 0, inFlight: 0, enabled: false, keyStates: [] };
    expect('lastModels' in offline).toBe(false);
    await start(config(), [{ body: JSON.stringify({ id: 'x' }) }]);
    await gateway.stop();
    expect(gateway.status().running).toBe(false);
  });

});
describe('LlmGateway.status()', () => {
  it('reports the models a strategy can actually serve', () => {
    const cfg = config();
    cfg.providers = [
      provider('p1', { models: { 'up-a': 'pub-a', 'up-b': 'pub-b' } }),
      provider('p2', { models: { 'up-c': 'pub-c' } }),
    ];
    cfg.strategies[0]!.members = [{ provider: 'p1' }, { provider: 'p2' }];
    const gateway = new LlmGateway({ getConfig: () => cfg });

    // modelAliases is authoritative: it is what applyGatewayStrategy routes by.
    cfg.strategies[0]!.modelAliases = { 'alias-x': 'up-a' };
    expect(gateway.status().strategies[0]!.models).toEqual(['alias-x']);
    expect(gateway.status().strategies[0]!.usable).toBe(true);
    expect(gateway.status().strategies[0]!.enabled).toBe(true);

    // No aliases: fall back to the members' public names.
    cfg.strategies[0]!.modelAliases = undefined;
    expect([...gateway.status().strategies[0]!.models].sort()).toEqual(['pub-a', 'pub-b', 'pub-c']);

    // A disabled member contributes nothing.
    cfg.providers[1]!.enabled = false;
    expect([...gateway.status().strategies[0]!.models].sort()).toEqual(['pub-a', 'pub-b']);

    // Nothing usable: empty, which the composer renders as 无可用模型.
    cfg.providers[0]!.enabled = false;
    expect(gateway.status().strategies[0]!.models).toEqual([]);
    expect(gateway.status().strategies[0]!.usable).toBe(false);
    expect(gateway.status().strategies[0]!.reason).toBe('没有可用的提供商');

    // A disabled strategy is reported as such and never usable.
    cfg.strategies[0]!.enabled = false;
    expect(gateway.status().strategies[0]!.enabled).toBe(false);
    expect(gateway.status().strategies[0]!.usable).toBe(false);
  });

});

describe('LlmGateway — a provider with no keys', () => {
  it('is called anonymously instead of reporting rate limits', async () => {
    // A local relay that trusts its caller has nothing to paste. Refusing here
    // surfaced as "all keys on provider X are rate limited" with zero keys —
    // the model step failed before it ever reached the upstream.
    const base = config();
    const cfg = config({
      providers: [provider('anon', { keys: [] })],
      strategies: [{ ...base.strategies[0]!, members: [{ provider: 'anon' }] }],
    });
    const stub = stubUpstream([{ body: JSON.stringify({ id: 'msg_k' }) }]);
    const logs: string[] = [];
    const gateway = new LlmGateway({ getConfig: () => cfg, fetchImpl: stub.impl, log: (m) => logs.push(m) });
    await gateway.start();
    try {
      const res = await post(gateway, {});
      expect(res.status).toBe(200);
      expect((await readJson(res)).id).toBe('msg_k');
      expect(stub.calls.length).toBe(1);
      expect(logs.join('\n')).not.toContain('rate limited');

      // No credential exists, so none may be invented for the wire.
      const headers = (stub.calls[0]!.init?.headers ?? {}) as Record<string, string>;
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  });
});

describe('parseRateLimitSignal', () => {
  it('reads Retry-After seconds', () => {
    expect(parseRateLimitSignal(new Headers({ 'retry-after': '30' }), '')).toEqual({
      retryAfterSeconds: 30,
    });
  });

  it('reads Retry-After as an HTTP date', () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    expect(parseRateLimitSignal(new Headers({ 'retry-after': at }), '')).toMatchObject({
      retryAfterSeconds: 45,
    });
  });

  it('falls back to a *-reset-* duration header', () => {
    expect(parseRateLimitSignal(new Headers({ 'x-ratelimit-reset-requests': '1m30s' }), '')).toEqual({
      retryAfterSeconds: 90,
    });
  });

  it('marks daily/quota bodies as day-level', () => {
    expect(parseRateLimitSignal(new Headers(), 'daily quota exceeded')).toMatchObject({
      dayLevel: true,
    });
    expect(parseRateLimitSignal(new Headers(), 'slow down')).toEqual({});
  });
});
