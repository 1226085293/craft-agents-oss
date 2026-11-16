/**
 * waitForCooldown end-to-end tests.
 *
 * Same harness as `llm-gateway.test.ts`: a real loopback server with a
 * stubbed upstream `fetch`. The waits themselves are real (1-2s cooldowns)
 * because `cooldownSleep` deliberately polls the wall clock — a fake
 * instant-resolving sleep would spin the poll loop.
 *
 * Cooldown control: the presets use `rateLimitSeconds: 0`, which disables the
 * first-429 "until next minute" escalation and makes the cooldown exactly the
 * upstream `retry-after` header. `retry-after` has 1s granularity, so a wait
 * can wake a few ms early and burn one extra wait-retry round on a near-zero
 * remainder — assertions use ranges where that boundary shows up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider } from '../llm-config.ts';

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

/** rateLimitSeconds 0: no escalation ladder; cooldown = upstream retry-after. */
function baseConfig(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: { noLadder: { rateLimitSeconds: 0, quotaExhaustedSeconds: 2592000, defaultSeconds: 1 } },
    providers: [provider('p1', { defaultPreset: 'noLadder' })],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: 'p1' }],
        retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['auto'] }],
    ...over,
  };
}

type StubResponse = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Hold the answer so a cooldown can expire while this unit is in flight. */
  delayMs?: number;
};

function stubUpstream(responses: StubResponse[]) {
  const calls: Array<{ url: string }> = [];
  let i = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    void init;
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
    calls.push({ url: String(input) });
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const { body = JSON.stringify({ ok: true }), status = 200, headers, delayMs } = spec;
    if (delayMs && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(body, { status, headers: headers ?? { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function post(gateway: LlmGateway, body: Record<string, unknown>, key = 'sk-client') {
  return fetch(`${gateway.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ model: 'auto', ...body }),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('LlmGateway waitForCooldown', () => {
  let gateway: LlmGateway | null = null;
  let configDir = '';
  const logs: string[] = [];
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    logs.length = 0;
    configDir = mkdtempSync(join(tmpdir(), 'llm-gw-wait-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    gateway = null;
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (sandboxDir) process.env.CRAFT_CONFIG_DIR = sandboxDir;
  });

  async function start(
    cfg: LlmConfig,
    responses: StubResponse[],
    onCooldownWait?: (event: { sessionId?: string; waiting: boolean; seconds?: number }) => void,
  ) {
    const stub = stubUpstream(responses);
    gateway = new LlmGateway({
      getConfig: () => cfg,
      fetchImpl: stub.impl,
      log: (m) => logs.push(m),
      ...(onCooldownWait ? { onCooldownWait } : {}),
    });
    await gateway.start();
    return stub;
  }

  it('waits out a short cooldown and retries the same strategy (stream chat)', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const started = Date.now();
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'rate limited' }) },
      { status: 200, body: JSON.stringify({ id: 'after-wait' }) },
    ]);

    const res = await post(gateway!, { stream: true });
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('after-wait');
    // The retry hit the SAME strategy/provider — wait-and-retry, not a
    // transfer. The near-expiry boundary may add one tiny extra wait-retry.
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
    expect(stub.calls.length).toBeLessThanOrEqual(4);
    expect(stub.calls.every((call) => call.url.includes('p1.example.com'))).toBe(true);
    // The wall clock really waited out the cooldown.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('signals cooldown wait start/end for the owning session', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const events: Array<{ sessionId?: string; waiting: boolean; seconds?: number }> = [];
    await start(
      cfg,
      [
        { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'rate limited' }) },
        { status: 200, body: JSON.stringify({ id: 'after-wait' }) },
      ],
      (event) => events.push(event),
    );

    const res = await post(gateway!, { stream: true, sessionKey: 'wait-session' });
    await readJson(res);

    expect(events[0]).toMatchObject({ sessionId: 'wait-session', waiting: true, phase: 'cooldown' });
    expect(events[0]!.seconds).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toEqual({ sessionId: 'wait-session', waiting: false, phase: 'cooldown' });
  });

  it('does not wait when the strategy has no waitForCooldown config', async () => {
    const started = Date.now();
    const stub = await start(baseConfig(), [
      { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'rate limited' }) },
    ]);

    const res = await post(gateway!, { stream: true });
    expect(res.status).toBe(429);
    expect(stub.calls.length).toBe(1);
    expect(logs.some((line) => line.includes('all units cooling, waiting'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not wait for a non-stream request', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const started = Date.now();
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'rate limited' }) },
    ]);

    const res = await post(gateway!, {});
    expect(res.status).toBe(429);
    expect(stub.calls.length).toBe(1);
    expect(logs.some((line) => line.includes('all units cooling, waiting'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not wait when the cooldown exceeds maxWaitSeconds', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 5 };
    const started = Date.now();
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '120' }, body: JSON.stringify({ error: 'rate limited' }) },
    ]);

    const res = await post(gateway!, { stream: true });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(60);
    expect(stub.calls.length).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never waits for a quota wall (402) even with waitForCooldown on', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const started = Date.now();
    const stub = await start(cfg, [
      { status: 402, body: JSON.stringify({ error: { type: 'insufficient_balance' } }) },
    ]);

    const res = await post(gateway!, { stream: true });
    expect(res.status).toBe(402);
    expect(stub.calls.length).toBe(1);
    expect(logs.some((line) => line.includes('all units cooling, waiting'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps wait→retry rounds per strategy and then answers the terminal status', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: 'rate limited' }) },
    ]);

    const res = await post(gateway!, { stream: true });
    expect(res.status).toBe(429);
    // First attempt + at most 3 wait-retry rounds (WAIT_COOLDOWN_ROUNDS); the
    // near-expiry boundary can end a round's cooldown early, but never adds
    // attempts beyond the cap.
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
    expect(stub.calls.length).toBeLessThanOrEqual(4);
    const waits = logs.filter((line) => line.includes('all units cooling, waiting'));
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits.length).toBeLessThanOrEqual(3);
  }, 20000);

  it('re-plans when a unit that was cooling at plan time has thawed', async () => {
    // The 2026-11-05 incident (`261105-onyx-steel`): the plan was built while
    // p1 was parked, so only p2 was in it. p2 took 2.1s to fail — by then p1
    // had finished its 2s cooldown — and `soonest === 0` ("something is
    // servable now") was read as "stop", answering 503 while a healthy route
    // sat right there. A stale plan must be refreshed, not obeyed.
    const cfg = baseConfig({
      providers: [provider('p1', { defaultPreset: 'noLadder' }), provider('p2', { defaultPreset: 'noLadder' })],
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          members: [{ provider: 'p1' }, { provider: 'p2' }],
          retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
          waitForCooldown: { enabled: true, maxWaitSeconds: 60 },
        },
      ],
    });
    const stub = await start(cfg, [
      // Priming request: park p1 for 2s, let p2 serve.
      { status: 429, headers: { 'retry-after': '2' }, body: JSON.stringify({ error: 'rate limited' }) },
      { body: JSON.stringify({ id: 'p2-first' }) },
      // Second request: p2 is alone in the plan and fails slowly enough for
      // p1's cooldown to expire while it is in flight.
      { status: 503, delayMs: 2100, body: JSON.stringify({ error: 'overloaded' }) },
      { body: JSON.stringify({ id: 'p1-after-replan' }) },
    ]);

    const first = await post(gateway!, { stream: true });
    expect(first.status).toBe(200);

    const second = await post(gateway!, { stream: true });
    expect(second.status).toBe(200);
    expect((await readJson(second)).id).toBe('p1-after-replan');
    expect(logs.some((line) => line.includes('stalePlan'))).toBe(true);
    // p1 twice (429, then the successful re-plan), p2 twice (served the first
    // request, failed the second).
    const hosts = stub.calls.map((call) => new URL(call.url).hostname);
    expect(hosts.filter((h) => h === 'p1.example.com').length).toBe(2);
    expect(hosts.filter((h) => h === 'p2.example.com').length).toBe(2);
  }, 20000);

  it('re-plans a stale plan for non-stream requests too', async () => {
    // Re-planning is a correctness fix, not part of the waiting policy: a
    // title/judge/compaction call must not be answered 503 just because its
    // plan snapshot went stale.
    const cfg = baseConfig({
      providers: [provider('p1', { defaultPreset: 'noLadder' }), provider('p2', { defaultPreset: 'noLadder' })],
      strategies: [
        {
          id: 'auto',
          type: 'round_robin',
          members: [{ provider: 'p1' }, { provider: 'p2' }],
          retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
        },
      ],
    });
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '2' }, body: JSON.stringify({ error: 'rate limited' }) },
      { body: JSON.stringify({ id: 'p2-first' }) },
      { status: 503, delayMs: 2100, body: JSON.stringify({ error: 'overloaded' }) },
      { body: JSON.stringify({ id: 'p1-after-replan' }) },
    ]);

    expect((await post(gateway!, {})).status).toBe(200);
    const second = await post(gateway!, {});
    expect(second.status).toBe(200);
    expect((await readJson(second)).id).toBe('p1-after-replan');
    expect(logs.some((line) => line.includes('stalePlan'))).toBe(true);
    expect(stub.calls.length).toBe(4);
  }, 20000);

  it('pairs the wait-end callback when a reload interrupts the wait', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const events: Array<{ sessionId?: string; waiting: boolean; seconds?: number }> = [];
    await start(
      cfg,
      [{ status: 429, headers: { 'retry-after': '30' }, body: JSON.stringify({ error: 'rate limited' }) }],
      (event) => events.push(event),
    );

    const pending = post(gateway!, { stream: true, sessionKey: 'reload-wait' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    gateway!.rebuild();
    const res = await pending;
    await res.text();

    expect(res.status).toBe(503);
    expect(events[0]).toMatchObject({ sessionId: 'reload-wait', waiting: true, phase: 'cooldown' });
    expect(events[events.length - 1]).toEqual({ sessionId: 'reload-wait', waiting: false, phase: 'cooldown' });
  });

  it('gives up waiting when the client disconnects mid-wait', async () => {
    const cfg = baseConfig();
    cfg.strategies[0]!.waitForCooldown = { enabled: true, maxWaitSeconds: 60 };
    const stub = await start(cfg, [
      { status: 429, headers: { 'retry-after': '30' }, body: JSON.stringify({ error: 'rate limited' }) },
    ]);

    // Abort the client side while the gateway sits in its 30s wait.
    const controller = new AbortController();
    const pending = fetch(`${gateway!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-client' },
      body: JSON.stringify({ model: 'auto', stream: true }),
      signal: controller.signal,
    });
    // Give the gateway time to reach the wait, then cut the connection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The wait must end well before the full 30s cooldown elapses.
    expect(stub.calls.length).toBe(1);
  });

  it('signals retry-backoff waits during same-key retries (429, no local cooldown)', async () => {
    const cfg = baseConfig();
    // Enough same-key budget for two 429s, and a small real backoff so the
    // gap is observable in the wait signal (fixed mode: delay = backoffMs).
    cfg.strategies[0]!.retry = { maxAttempts: 3, intervalMode: 'fixed', backoffMs: 25, onStatusCodes: [500, 502, 503, 504] };
    const events: Array<{ sessionId?: string; waiting: boolean; seconds?: number; phase?: string }> = [];
    await start(
      cfg,
      [
        { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
        { status: 429, body: JSON.stringify({ error: 'rate limited' }) },
        { status: 200, body: JSON.stringify({ id: 'after-backoff' }) },
      ],
      (event) => events.push(event),
    );

    const res = await post(gateway!, { stream: true, sessionKey: 'backoff-session' });
    expect(res.status).toBe(200);
    expect((await readJson(res)).id).toBe('after-backoff');

    // Two same-key retries ⇒ two backoff waits, each bracketed by signals.
    const backoffs = events.filter((e) => e.phase === 'retry_backoff');
    expect(backoffs.length).toBeGreaterThanOrEqual(4);
    expect(backoffs[0]).toMatchObject({ sessionId: 'backoff-session', waiting: true, seconds: 1 });
    expect(backoffs[1]).toEqual({ sessionId: 'backoff-session', waiting: false, phase: 'retry_backoff' });
  });
});
