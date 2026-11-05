/**
 * The model of a fallback request is chosen by the group that serves it.
 *
 * `fallbackStrategyId` used to transfer the *model name* along with the
 * strategy: the caller's group had picked `model-a`, so the target group was
 * asked for `model-a` too. `candidateUnits` only offers members that declare
 * the requested name (or fall through when the group declares it at all), so
 * the target produced no units and the transfer died with
 * `no member serves "model-a"` — a fallback group could only work if it
 * happened to declare the source group's model name (261105-onyx-steel,
 * 2026-11-05: `workbuddy` → `free`).
 *
 * A group owns its model list, so a transfer must re-pick from the target's own
 * `modelAliases` — the same `pickStrategyModel` rule the session router uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider, LlmStrategy } from '../llm-config.ts';

function provider(id: string): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/messages`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: `sk-${id}-1` }],
  };
}

function strategy(partial: Partial<LlmStrategy> & { id: string }): LlmStrategy {
  return {
    type: 'sequential',
    members: [],
    // One attempt: every test counts units walked, and same-target retries
    // would blur that.
    retry: { maxAttempts: 1, onStatusCodes: [429, 500, 502, 503, 504], backoffMs: 0 },
    ...partial,
  } as LlmStrategy;
}

type StubResponse =
  | { status?: number; body?: string }
  | (() => Response);

function stubUpstream(responses: StubResponse[]) {
  const calls: Array<{ url: string; model: string | undefined; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    let pathname = String(input);
    try {
      pathname = new URL(String(input)).pathname;
    } catch {
      /* not a URL */
    }
    if (pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ url: String(input), model: parsed.model as string | undefined, body: parsed });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (typeof spec === 'function') return spec();
    const { body = JSON.stringify({ ok: true }), status = 200 } = spec;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function postTo(gateway: LlmGateway, strategyId: string, model: string) {
  return fetch(`${gateway.baseUrl}/s/${encodeURIComponent(strategyId)}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
    body: JSON.stringify({ model }),
  });
}

describe('LlmGateway fallback model ownership', () => {
  let gateway: LlmGateway | null = null;
  let configDir = '';
  const logs: string[] = [];
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    logs.length = 0;
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-fb-'));
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

  function config(strategies: LlmStrategy[], providers: LlmProvider[]): LlmConfig {
    return {
      version: 1,
      presets: {},
      providers,
      strategies,
      clientKeys: [{ key: 'sk-client', strategies: strategies.map((s) => s.id) }],
    } as LlmConfig;
  }

  it('serves the transfer with the target group own model', async () => {
    const cfg = config(
      [
        strategy({
          id: 'src',
          modelAliases: { 'model-a': 'model-a' },
          members: [{ provider: 'p1', model: 'model-a' }],
          fallbackStrategyId: 'dst',
        }),
        strategy({
          id: 'dst',
          modelAliases: { 'model-b': 'model-b' },
          members: [{ provider: 'p2', model: 'model-b' }],
        }),
      ],
      [provider('p1'), provider('p2')],
    );
    const stub = await start(cfg, [
      { status: 500, body: '{"error":"boom"}' },
      { body: JSON.stringify({ id: 'from-dst' }) },
    ]);

    const res = await postTo(gateway!, 'src', 'model-a');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('from-dst');
    // The first attempt carried the source group's model; the transfer carried
    // the target group's, which is the whole point.
    expect(stub.calls.map((c) => c.model)).toEqual(['model-a', 'model-b']);
    expect(stub.calls[1]!.url).toContain('p2.example.com');
  });

  it('picks the target group model even when the source name is a different model entirely', async () => {
    const cfg = config(
      [
        strategy({
          id: 'src',
          modelAliases: { 'wb/d4.1f': 'wb/d4.1f' },
          members: [{ provider: 'p1', model: 'wb/d4.1f' }],
          fallbackStrategyId: 'dst',
        }),
        strategy({
          id: 'dst',
          modelAliases: { 'gpt-6-luna': 'gpt-6-luna' },
          members: [{ provider: 'p2', model: 'gpt-6-luna' }],
        }),
      ],
      [provider('p1'), provider('p2')],
    );
    const stub = await start(cfg, [
      { status: 429, body: '{"error":"rate limited"}' },
      { body: JSON.stringify({ id: 'other-family' }) },
    ]);

    const res = await postTo(gateway!, 'src', 'wb/d4.1f');
    expect(res.status).toBe(200);
    expect(stub.calls[1]!.model).toBe('gpt-6-luna');
  });

  it('skips a fallback group that declares no model and keeps walking the chain', async () => {
    const cfg = config(
      [
        strategy({
          id: 'src',
          modelAliases: { 'model-a': 'model-a' },
          members: [{ provider: 'p1', model: 'model-a' }],
          fallbackStrategyId: 'empty',
        }),
        // Declares no model at all: it can never serve a request, so answering
        // 503 on its behalf would be a lie.
        strategy({ id: 'empty', members: [{ provider: 'p2', model: 'model-b' }], fallbackStrategyId: 'dst' }),
        strategy({
          id: 'dst',
          modelAliases: { 'model-c': 'model-c' },
          members: [{ provider: 'p3', model: 'model-c' }],
        }),
      ],
      [provider('p1'), provider('p2'), provider('p3')],
    );
    const stub = await start(cfg, [
      { status: 500, body: '{"error":"boom"}' },
      { body: JSON.stringify({ id: 'from-dst' }) },
    ]);

    const res = await postTo(gateway!, 'src', 'model-a');
    expect(res.status).toBe(200);
    // p2 never saw a request: its group has no model to ask for.
    expect(stub.calls.map((c) => c.url)).toHaveLength(2);
    expect(stub.calls.some((c) => c.url.includes('p2.example.com'))).toBe(false);
    expect(stub.calls[1]!.model).toBe('model-c');
  });

  it('terminates a fallback cycle instead of looping', async () => {
    const cfg = config(
      [
        strategy({
          id: 'src',
          modelAliases: { 'model-a': 'model-a' },
          members: [{ provider: 'p1', model: 'model-a' }],
          fallbackStrategyId: 'dst',
        }),
        strategy({
          id: 'dst',
          modelAliases: { 'model-b': 'model-b' },
          members: [{ provider: 'p2', model: 'model-b' }],
          fallbackStrategyId: 'src',
        }),
      ],
      [provider('p1'), provider('p2')],
    );
    const stub = await start(cfg, [{ status: 500, body: '{"error":"boom"}' }]);

    const res = await postTo(gateway!, 'src', 'model-a');
    // Both groups were tried once and the chain stopped: no group is retried
    // because it was reached twice.
    expect(stub.calls).toHaveLength(2);
    expect(res.status).toBe(502);
  });

  it('keeps the source group model when no fallback is configured', async () => {
    const cfg = config(
      [
        strategy({
          id: 'src',
          modelAliases: { 'model-a': 'model-a' },
          members: [{ provider: 'p1', model: 'model-a' }],
        }),
      ],
      [provider('p1')],
    );
    const stub = await start(cfg, [{ status: 500, body: '{"error":"boom"}' }]);

    const res = await postTo(gateway!, 'src', 'model-a');
    expect(res.status).toBe(502);
    expect(stub.calls.map((c) => c.model)).toEqual(['model-a']);
  });
});