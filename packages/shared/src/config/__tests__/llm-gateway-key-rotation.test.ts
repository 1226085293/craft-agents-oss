/**
 * 429 key-rotation tests.
 *
 * With a positive local 429 cooldown (preset `rateLimitSeconds` > 0), a 429
 * cools the key AND the gateway must hand off to the provider's next key —
 * each key is its own account, so one walled key must not end the provider
 * while healthy siblings sit idle (261110-brave-titanium, 2026-11-17: the
 * old `break` answered 429 after a single dispatch per provider even though
 * the sibling key served successfully seconds later).
 *
 * Key tries per provider are uncapped: when upstreams refuse, every enabled
 * key of the provider is worth one fast 429 probe. Worst case stays bounded
 * by the client's first-byte watchdog — a 429 is a fast refusal, not a slow
 * failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

function provider(id: string, keyCount: number, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: Array.from({ length: keyCount }, (_, i) => ({ id: `${id}-k${i + 1}`, key: `sk-${id}-${i + 1}` })),
    ...over,
  };
}

/** Preset WITH a positive local 429 cooldown — the branch these tests target. */
function baseConfig(providers: LlmProvider[], over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: { local: { rateLimitSeconds: 60, quotaExhaustedSeconds: 2592000, defaultSeconds: 1 } },
    providers: providers.map((p) => ({ ...p, defaultPreset: 'local' })),
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: providers.map((p) => ({ provider: p.id })),
        retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    ...over,
  };
}

type StubResponse = { status?: number; body?: string; headers?: Record<string, string> };

function stubUpstream(perHost: Record<string, StubResponse[]>) {
  const calls: Array<{ host: string }> = [];
  const counters: Record<string, number> = {};
  const impl = (async (input: string | URL) => {
    let host = 'unknown';
    try {
      host = new URL(String(input)).hostname;
    } catch {
      /* not a URL */
    }
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    calls.push({ host });
    const specs = perHost[host] ?? [];
    const i = counters[host] ?? 0;
    counters[host] = i + 1;
    const spec = specs[Math.min(i, specs.length - 1)]!;
    return new Response(spec.body ?? JSON.stringify({ ok: true }), {
      status: spec.status ?? 200,
      headers: spec.headers ?? { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('LlmGateway 429 key rotation', () => {
  let gateway: LlmGateway | null = null;
  let configDir = '';
  const logs: string[] = [];
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    logs.length = 0;
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-rot-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    gateway = null;
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (sandboxDir) process.env.CRAFT_CONFIG_DIR = sandboxDir;
  });

  async function start(cfg: LlmConfig, perHost: Record<string, StubResponse[]>) {
    const stub = stubUpstream(perHost);
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: (m) => logs.push(m),
    });
    await gateway.start();
    return stub;
  }

  function post(gateway: LlmGateway, body: Record<string, unknown> = {}, key = 'sk-client') {
    return fetch(`${gateway.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'auto', ...body }),
    });
  }

  it('429 with local cooldown rotates to the provider\'s next key instead of abandoning it', async () => {
    const cfg = baseConfig([provider('p1', 2)]);
    const stub = await start(cfg, { 'p1.example.com': [{ status: 429, body: JSON.stringify({ error: 'rate limited' }) }, { status: 200 }] });

    const res = await post(gateway!);
    expect(res.status).toBe(200);
    // key1 refused (429), cooled 60s, key2 served — a second dispatch on the
    // SAME provider. The old code broke after the first 429 (1 call, 429 out).
    expect(stub.calls.length).toBe(2);
  });

  it('tries every key of a provider when all of them refuse (no key-try cap)', async () => {
    const cfg = baseConfig([provider('p1', 4)]);
    const stub = await start(cfg, {
      'p1.example.com': [{ status: 429, body: JSON.stringify({ error: 'rate limited' }) }],
    });

    const res = await post(gateway!);
    expect(res.status).toBe(429);
    // One 429 probe per key: four keys, four calls. The old cap of 3 answered
    // after three; the pre-rotation break answered after one.
    expect(stub.calls.length).toBe(4);
  });

  it('exhausts every key of a failing provider, then falls through to the next one', async () => {
    const cfg = baseConfig([provider('p1', 2), provider('p2', 1)]);
    const stub = await start(cfg, {
      'p1.example.com': [{ status: 429, body: JSON.stringify({ error: 'rate limited' }) }],
      'p2.example.com': [{ status: 200 }],
    });

    const res = await post(gateway!);
    expect(res.status).toBe(200);
    // Both p1 keys are probed and cooled before the fallback serves.
    expect(stub.calls.filter((c) => c.host === 'p1.example.com').length).toBe(2);
    expect(stub.calls.length).toBe(3);
  });
});
