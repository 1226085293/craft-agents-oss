/**
 * Gateway runtime tests.
 *
 * These use the real filesystem via a temporary CONFIG_DIR, because the
 * behaviour under test is "the gateway arms from a file on disk and re-arms
 * when that file changes" — mocking `loadLlmConfig` would assert the mock
 * rather than the contract.
 *
 * The load-bearing property is the **fallback**: with no usable config the
 * runtime reports not-enabled and injects nothing, so the legacy
 * `resolveAuthEnvVars()` path stays in charge. If that breaks, a typo in
 * `llm-config.json` would take every session's LLM down.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';

import { GatewayRuntime, resetGatewayRuntime } from '../llm-gateway-runtime.ts';
import { LLM_CONFIG_PATH } from '../llm-config-loader.ts';

// CONFIG_DIR comes from `paths.ts`, which redirects any `NODE_ENV=test` process
// to a throwaway directory. That is the only reliable way to keep a test off the
// real ~/.craft-agent: the constant is resolved at import, so switching
// CRAFT_CONFIG_DIR inside a test has no effect. Per-test isolation is the
// `rmSync(LLM_CONFIG_PATH)` in beforeEach.

function writeConfig(body: unknown): void {
  writeFileSync(LLM_CONFIG_PATH, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function validConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    presets: {},
    providers: [
      {
        id: 'p1',
        name: 'p1',
        baseUrl: 'https://p1.example.com/v1/messages',
        protocol: 'anthropic-messages',
        keys: [{ id: 'p1-k1', key: 'sk-p1-k1' }],
        models: { 'upstream-model': 'public-model' },
      },
    ],
    strategies: [
      {
        id: 'auto',
        type: 'round_robin',
        members: [{ provider: 'p1' }],
      },
    ],
    clientKeys: [{ key: 'sk-client-1', strategies: ['auto'] }],
    ...over,
  };
}

describe('GatewayRuntime', () => {
  let runtime: InstanceType<typeof GatewayRuntime>;
  const logs: string[] = [];

  beforeEach(async () => {
    logs.length = 0;
    resetGatewayRuntime();
    runtime = new GatewayRuntime({ log: (m) => logs.push(m) });
    // Start clean so a previous test's file cannot arm this one.
    try {
      rmSync(LLM_CONFIG_PATH, { force: true });
    } catch {}
    await runtime.stop();
  });

  afterEach(async () => {
    await runtime.stop();
    resetGatewayRuntime();
  });

  it('does not arm without a config file, and injects no env', async () => {
    const armed = await runtime.start();
    expect(armed).toBe(false);
    expect(runtime.enabled).toBe(false);
    expect(runtime.sessionEnv('sk-client-1')).toBeNull();
    expect(runtime.defaultClientKey()).toBeNull();
    expect(runtime.status().running).toBe(false);
  });

  it('does not arm when no provider has an enabled key', async () => {
    const cfg = validConfig();
    const p1 = cfg.providers as Array<Record<string, unknown>>;
    p1[0]!.keys = [{ id: 'p1-k1', key: 'sk-p1-k1', enabled: false }];
    writeConfig(cfg);

    expect(await runtime.start()).toBe(false);
    expect(runtime.sessionEnv('sk-client-1')).toBeNull();
  });

  it('arms without client keys — the app uses strategy-scoped paths', async () => {
    // A client key is for external callers on the unscoped endpoint; requiring
    // one to arm left a UI-configured gateway permanently down.
    writeConfig(validConfig({ clientKeys: [] }));
    expect(await runtime.start()).toBe(true);
    expect(runtime.sessionEnv('sk-client-1')).not.toBeNull();
  });

  it('arms on a valid config and injects the gateway env', async () => {
    writeConfig(validConfig());
    expect(await runtime.start()).toBe(true);

    expect(runtime.port).toBeGreaterThan(0);
    const env = runtime.sessionEnv('sk-client-1');
    expect(env).not.toBeNull();
    expect(env!.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${runtime.port}`);
    // The subprocess must receive the client key, never an upstream key.
    expect(env!.ANTHROPIC_API_KEY).toBe('sk-client-1');
    expect(env!.ANTHROPIC_API_KEY).not.toContain('sk-p1');
  });

  it('serves a real request through the injected base URL', async () => {
    writeConfig(validConfig());
    await runtime.start();
    const env = runtime.sessionEnv('sk-client-1')!;

    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
      },
      // Provider 1 has no reachable upstream in tests, so this asserts the
      // gateway answered and reported a routable failure — i.e. the wiring is
      // end-to-end, not the upstream's fault.
      body: JSON.stringify({ model: 'public-model', messages: [] }),
    });
    expect([200, 502, 503]).toContain(res.status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toBeDefined();
  });

  it('keeps the default client key stable across calls', async () => {
    writeConfig(validConfig());
    await runtime.start();
    expect(runtime.defaultClientKey()).toBe('sk-client-1');
    expect(runtime.defaultClientKey()).toBe('sk-client-1');
  });

  it('rebuilds the gateway when the config on disk changes', async () => {
    writeConfig(validConfig());
    await runtime.start();
    expect(runtime.status().strategies.length).toBe(1);

    const before = runtime.port;
    const cfg = validConfig();
    (cfg.strategies as Array<Record<string, unknown>>).push({
      id: 'second',
      type: 'round_robin',
      members: [{ provider: 'p1' }],
    });
    writeConfig(cfg);

    runtime.apply(cfg as never);

    // The port must not change: sessions already hold this URL in their env.
    expect(runtime.port).toBe(before);
    expect(runtime.status().strategies.length).toBe(2);
  });

  it('ignores a broken config and keeps serving the previous one', async () => {
    writeConfig(validConfig());
    await runtime.start();
    const goodPort = runtime.port;

    writeFileSync(LLM_CONFIG_PATH, '{ this is not json', 'utf8');
    runtime.refresh();

    expect(runtime.enabled).toBe(false);
    // Still running: the previous snapshot stays live, sessions are unaffected.
    expect(runtime.running).toBe(true);
    expect(runtime.port).toBe(goodPort);
  });

  it('stops cleanly and can be restarted', async () => {
    writeConfig(validConfig());
    await runtime.start();
    const first = runtime.port;
    await runtime.stop();
    expect(runtime.status().running).toBe(false);
    expect(runtime.status().port).toBe(0);

    await runtime.start();
    expect(runtime.running).toBe(true);
    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.port).not.toBe(first);
  });

  it('re-arms after the config becomes unusable and then valid again', async () => {
    // Verified on a dev instance: deleting llm-config.json tore down the
    // gateway *and* the watcher, so restoring the file left it dead until the
    // next launch. reconcile() must only ever stop the gateway.
    writeConfig(validConfig());
    await runtime.start();
    expect(runtime.running).toBe(true);
    const firstPort = runtime.port;

    // Become unusable. A *broken* config does not tear anything down: the
    // watcher discards invalid JSON and keeps serving the previous snapshot,
    // which is the documented hot-reload rule. To exercise teardown we have to
    // remove the file entirely.
    rmSync(LLM_CONFIG_PATH, { force: true });
    for (let i = 0; i < 20 && runtime.running; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runtime.running).toBe(false);

    // A broken write while down is also fine — it is simply ignored.
    writeFileSync(LLM_CONFIG_PATH, '{ broken', 'utf8');

    // Become usable again — the watcher must still be alive to notice.
    writeConfig(validConfig());
    for (let i = 0; i < 14 && !runtime.running; i++) {
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(runtime.running).toBe(true);
    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.port).not.toBe(firstPort);
    expect(runtime.sessionEnv('sk-client-1')).not.toBeNull();
  }, 20000);

  it('keeps watching while not armed and arms when the file appears later', async () => {
    // Booting with no config must not make the runtime permanently deaf: the
    // user creates llm-config.json minutes later via the UI, and the gateway
    // has to come up without a restart.
    //
    // This drives the real watcher (file write -> poll -> onChange -> arm)
    // rather than calling apply() directly, because the bug being pinned was
    // that no watcher existed at all — an apply()-driven test would pass either
    // way. Bun's 5s test cap means we run this one with an explicit timeout.
    const armed = await runtime.start();
    expect(armed).toBe(false);
    expect(runtime.running).toBe(false);

    writeConfig(validConfig());

    // Poll interval is 2s plus a 400ms settle, so expect ~2.4s per cycle.
    for (let i = 0; i < 14 && !runtime.running; i++) {
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(runtime.running).toBe(true);
    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.sessionEnv('sk-client-1')).not.toBeNull();
  }, 20000);
});
