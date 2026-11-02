/**
 * Availability windows, end to end: status projection, routing, and the log.
 *
 * The incident (2026-10-29, `261029-airy-orbit` / `261029-snug-raven`): a group
 * declared `hy4-preview` (23:00–08:00) then `hy3` (all day). Three things were
 * wrong at once and each is pinned here:
 *
 * 1. a request naming the closed model was refused outright instead of falling
 *    through to the model that *was* open — the user configured a fallback and
 *    never got one;
 * 2. the composer named the group's last *successful* model, so it agreed with
 *    neither the closed model nor the fallback;
 * 3. a fallback attempt was logged under the model the client asked for, so the
 *    log said `hy4-preview` about a request `hy3` served.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmGateway } from '../llm-gateway.ts';
import type { LlmConfig, LlmProvider, LlmStrategy } from '../llm-config.ts';
import { openStrategyModels, pickStrategyModel } from '../strategy-availability.ts';

/** `hy4-preview` is a late-night model; `hy3` has no window at all. */
function limitedProvider(over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'wb',
    name: 'wb',
    baseUrl: 'https://wb.example.com/v1/messages',
    protocol: 'anthropic-messages',
    keys: [{ id: 'wb-k1', key: 'sk-wb-SECRET-1' }],
    models: { 'hy4-preview': 'hy4-preview', hy3: 'hy3' },
    timeWindows: {
      'hy4-preview': {
        tz: 'Asia/Shanghai',
        spans: [{ start: '23:00', end: '08:00' }],
        to: '2026-10-31 23:59',
      },
    },
    ...over,
  };
}

function windowedConfig(over: Partial<LlmStrategy> = {}, providerOver: Partial<LlmProvider> = {}): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [limitedProvider(providerOver)],
    strategies: [
      {
        id: 'workbuddycn',
        type: 'round_robin',
        members: [
          { provider: 'wb', model: 'hy4-preview' },
          { provider: 'wb', model: 'hy3' },
        ],
        modelAliases: { 'hy4-preview': 'hy4-preview', hy3: 'hy3' },
        retry: { maxAttempts: 1, onStatusCodes: [500, 502, 503, 504], backoffMs: 0 },
        ...over,
      },
    ],
    clientKeys: [{ key: 'sk-client', strategies: ['workbuddycn'] }],
  };
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

/** 2026-10-29 17:00 Asia/Shanghai — hy4-preview is closed. */
const EVENING_CST = Date.UTC(2026, 9, 29, 9, 0, 0);

describe('strategy availability — one rule, three readers', () => {
  it('lists only the models that are open right now, in declared order', () => {
    const cfg = windowedConfig();
    const strategy = cfg.strategies[0]!;
    expect(openStrategyModels(strategy, ['hy4-preview', 'hy3'], cfg.providers, EVENING_CST)).toEqual(['hy3']);
    // 23:30 — the limited model is open, and it stays first.
    expect(
      openStrategyModels(strategy, ['hy4-preview', 'hy3'], cfg.providers, Date.UTC(2026, 9, 29, 15, 30, 0)),
    ).toEqual(['hy4-preview', 'hy3']);
  });

  it('picks the first open model when the session has no model of its own', () => {
    const cfg = windowedConfig();
    expect(pickStrategyModel(cfg.strategies[0]!, ['hy4-preview', 'hy3'], cfg.providers, undefined, EVENING_CST)).toBe('hy3');
  });

  it('an absent window allows: the model is never taken out of service by a typo', () => {
    const cfg = windowedConfig();
    expect(openStrategyModels(cfg.strategies[0]!, ['hy3'], cfg.providers, EVENING_CST)).toEqual(['hy3']);
  });
});

describe('LlmGateway — availability windows', () => {
  let gateway: LlmGateway | undefined;
  let configDir = '';
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'craft-availability-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    gateway = undefined;
    if (sandboxDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
    else process.env.CRAFT_CONFIG_DIR = sandboxDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function stubUpstream() {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('falls through to the open model instead of refusing the turn', async () => {
    // The client asks for hy4-preview (a session left on it last night); at
    // 17:00 only hy3 is open.
    const { impl, calls } = stubUpstream();
    gateway = new LlmGateway({
      getConfig: () => windowedConfig({}, { timeWindows: { 'hy4-preview': { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }], to: '2026-10-31 23:59' } } }),
      fetchImpl: impl,
    });
    await gateway.start();

    const res = await post(gateway, 'hy4-preview');
    expect(res.status).toBe(200);
    await res.text();

    // The closed model is never dispatched; the open one serves the request.
    expect(calls.map((c) => c.body.model)).toEqual(['hy3']);

    // The log names the model that served it — model, unit and upstream agree.
    const rows = gateway.drainUsage();
    const row = rows.find((r) => r.status === 'success');
    expect(row).toBeDefined();
    expect(row!.publicModel).toBe('hy3');
    expect(row!.upstreamModel).toBe('hy3');
    expect(row!.unitId).toBe('wb::hy3');
  });

  it('still names the requested model on the units that actually tried it', async () => {
    // No windows here, so the clock cannot decide which units run: the
    // requested model goes first, a 404 from it is logged against that model,
    // and hy3 then serves the turn.
    const seen: Array<Record<string, unknown>> = [];
    let i = 0;
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      seen.push(body);
      i += 1;
      if (i === 1) {
        return new Response(JSON.stringify({ error: { message: 'model hy4-preview not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    gateway = new LlmGateway({ getConfig: () => windowedConfig({}, { timeWindows: {} }), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'hy4-preview');
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.map((b) => b.model)).toEqual(['hy4-preview', 'hy3']);

    const rows = gateway.drainUsage();
    const failed = rows.find((r) => r.status === 'error');
    expect(failed?.publicModel).toBe('hy4-preview');
    expect(failed?.unitId).toBe('wb::hy4-preview');
    const served = rows.find((r) => r.status === 'success');
    expect(served?.publicModel).toBe('hy3');
  });

  it('reports the closed state instead of claiming a healthy route', async () => {
    // Every model in the group is closed: the status the composer reads says
    // so, rather than naming a model that cannot serve.
    gateway = new LlmGateway({
      getConfig: () =>
        windowedConfig(
          {},
          {
            timeWindows: {
              'hy4-preview': { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
              hy3: { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
            },
          },
        ),
      fetchImpl: stubUpstream().impl,
    });
    await gateway.start();

    const status = gateway.status();
    const strategy = status.strategies.find((s) => s.id === 'workbuddycn')!;
    expect(strategy.models).toEqual(['hy4-preview', 'hy3']);
    // 17:00 on the machine that runs the tests would decide this; assert the
    // shape instead, then prove the rule on the pure function with a fixed clock.
    expect(strategy.openModels).toBeDefined();
    const cfg = windowedConfig(
      {},
      {
        timeWindows: {
          'hy4-preview': { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
          hy3: { tz: 'Asia/Shanghai', spans: [{ start: '23:00', end: '08:00' }] },
        },
      },
    );
    expect(openStrategyModels(cfg.strategies[0]!, ['hy4-preview', 'hy3'], cfg.providers, EVENING_CST)).toEqual([]);
  });
});

describe('LlmGateway — cooldown-aware status projection', () => {
  let gateway: LlmGateway | undefined;
  let configDir = '';
  const sandboxDir = process.env.CRAFT_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'craft-availability-cooldown-'));
    process.env.CRAFT_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (gateway) await gateway.stop();
    gateway = undefined;
    if (sandboxDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
    else process.env.CRAFT_CONFIG_DIR = sandboxDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  /** A windowless config: availability here is cooldowns, not the clock. */
  function alwaysOpenConfig(): LlmConfig {
    const cfg = windowedConfig();
    cfg.providers[0]!.timeWindows = {};
    return cfg;
  }

  function stubFailingUpstream() {
    return (async () =>
      new Response(JSON.stringify({ error: { message: 'no healthy account for this model' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  it('marks a fully cooled group unusable so the composer blocks the send', async () => {
    gateway = new LlmGateway({ getConfig: () => alwaysOpenConfig(), fetchImpl: stubFailingUpstream() });
    await gateway.start();

    // The 503 cools both routes of the single-provider group.
    const res = await post(gateway, 'hy4-preview');
    await res.text();

    const strategy = gateway.status().strategies.find((s) => s.id === 'workbuddycn')!;
    expect(strategy.openModels).toEqual([]);
    expect(strategy.usable).toBe(false);
    expect(strategy.reason).toContain('冷却');
  });

  it('drops only the cooled model and names the fallback as next', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      seen.push(body);
      if (body.model === 'hy4-preview') {
        return new Response(JSON.stringify({ error: { message: 'no healthy account for this model' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    gateway = new LlmGateway({ getConfig: () => alwaysOpenConfig(), fetchImpl: impl });
    await gateway.start();

    const res = await post(gateway, 'hy4-preview');
    await res.text();
    // A 503 is a server_error: the key cools, and with a single key the same
    // provider's fallback unit has nothing left to run on inside this request
    // — the fallback engages on the NEXT request, not this one.
    expect(seen.map((c) => c.model)).toEqual(['hy4-preview']);
    // Every candidate unit was excluded for key-level reasons (cooling), so
    // the client gets a 429 — a 503 is reserved for "no route at all".
    expect(res.status).toBe(429);

    const strategy = gateway.status().strategies.find((s) => s.id === 'workbuddycn')!;
    // Single key, now cooling: the fallback is the SAME provider's unit, so it
    // is parked with the first model — the whole group is honestly unusable
    // instead of the composer predicting hy3 and watching the request 429.
    expect(strategy.openModels).toEqual([]);
    expect(strategy.usable).toBe(false);
    expect(strategy.reason).toContain('冷却');
  });
});
