/**
 * LlmConfigWatcher tests.
 *
 * The behaviour under test is the one that broke in production: the app boots
 * before `llm-config.json` exists, so `start()` used to give up entirely and the
 * gateway stayed disarmed for the whole process lifetime even after the file
 * appeared. `start()` now polls until the file shows up.
 *
 * The other property worth pinning is **self-write suppression** — the gateway
 * writes the config (saving usage or a user edit from the UI) and must not treat
 * its own write as a signal to rebuild, which would loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The watcher resolves the path at module scope, so the temp dir must exist
// before the import chain runs.
const configDir = mkdtempSync(join(tmpdir(), 'llm-watcher-'));
process.env.CRAFT_CONFIG_DIR = configDir;

const { LlmConfigWatcher } = await import('../llm-config-watcher.ts');
const { LLM_CONFIG_PATH } = await import('../llm-config-loader.ts');

function writeConfig(body: unknown): void {
  writeFileSync(LLM_CONFIG_PATH, JSON.stringify(body, null, 2), 'utf8');
}

function minimalConfig(tag = 'a'): Record<string, unknown> {
  return {
    version: 1,
    presets: {},
    providers: [
      {
        id: `p-${tag}`,
        name: `p-${tag}`,
        baseUrl: 'https://a.example.com/v1/messages',
        protocol: 'anthropic-messages',
        keys: [{ id: `k-${tag}`, key: `sk-${tag}` }],
      },
    ],
    strategies: [
      { id: `s-${tag}`, type: 'round_robin', members: [{ provider: `p-${tag}` }] },
    ],
    clientKeys: [{ key: 'sk-client', strategies: [`s-${tag}`] }],
  };
}

function removeConfig(): void {
  rmSync(LLM_CONFIG_PATH, { force: true });
}

describe('LlmConfigWatcher', () => {
  let watcher: InstanceType<typeof LlmConfigWatcher> | null = null;

  beforeEach(() => {
    removeConfig();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = null;
    removeConfig();
  });

  it('starts watching a file that already exists', async () => {
    writeConfig(minimalConfig());
    const seen: string[] = [];
    watcher = new LlmConfigWatcher({ onChange: (cfg) => seen.push(cfg.providers[0]!.id) });

    watcher.start();

    writeConfig(minimalConfig('b'));
    // fs.watch latency is well under a second; the settle window is 400ms.
    await new Promise((r) => setTimeout(r, 1500));

    expect(seen).toEqual(['p-b']);
  });

  it('picks up a file created after start (boot before first config)', async () => {
    // This is the production failure: the app starts with no config, the user
    // then creates one via the UI, and nothing noticed.
    const seen: string[] = [];
    watcher = new LlmConfigWatcher({ onChange: (cfg) => seen.push(cfg.providers[0]!.id) });

    watcher.start();
    expect(existsSync(LLM_CONFIG_PATH)).toBe(false);

    writeConfig(minimalConfig('late'));
    expect(existsSync(LLM_CONFIG_PATH)).toBe(true);
    // Poll interval 2s + 400ms settle, so the first change lands at ~2.4s.
    // Bun's default 5s per-test timeout means a flat 6s wait would fail as a
    // timeout rather than an assertion, so poll instead.
    for (let i = 0; i < 12 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 400));
    }

    expect(seen).toEqual(['p-late']);
  });

  it('ignores its own write when told to', async () => {
    writeConfig(minimalConfig());
    const seen: string[] = [];
    watcher = new LlmConfigWatcher({ onChange: (cfg) => seen.push(cfg.providers[0]!.id) });
    watcher.start();

    watcher.markSelfWrite();
    writeConfig(minimalConfig('mine'));
    await new Promise((r) => setTimeout(r, 1500));

    expect(seen).toEqual([]);
  });

  it('reports the reason when the file is invalid, and keeps the old config', async () => {
    writeConfig(minimalConfig());
    const seen: string[] = [];
    const errors: string[] = [];
    watcher = new LlmConfigWatcher({
      onChange: (cfg) => seen.push(cfg.providers[0]!.id),
      onError: (reason) => errors.push(reason),
    });
    watcher.start();

    writeFileSync(LLM_CONFIG_PATH, '{ not valid json', 'utf8');
    await new Promise((r) => setTimeout(r, 1500));

    expect(seen).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('stop() ends the wait without applying a change', async () => {
    const seen: string[] = [];
    watcher = new LlmConfigWatcher({ onChange: (cfg) => seen.push(cfg.providers[0]!.id) });
    watcher.start();
    watcher.stop();

    writeConfig(minimalConfig('after-stop'));
    await new Promise((r) => setTimeout(r, 2500));

    expect(seen).toEqual([]);
  });
});
