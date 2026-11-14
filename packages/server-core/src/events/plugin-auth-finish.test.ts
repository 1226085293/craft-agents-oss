/**
 * The two observation paths must end in the same place.
 *
 * The plugin cannot push, so a scan is normally discovered by the renderer
 * polling `getPluginAuthState`. These tests drive the shared tail directly:
 *  - a `connected` seen only through the read must still persist the token;
 *  - a `connected` seen by both the action and the read must persist once.
 *
 * The write goes through `writeListenerConfigFile` — the very function the
 * supervisor calls when it starts a plugin — so the assertions read the actual
 * `<dataDir>/config.json` the plugin process will open. A test-local copy of
 * that JSON would prove nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthFinisher } from './plugin-auth-finish.ts';
import { writeListenerConfigFile } from './listener-supervisor.ts';
import type { PluginAuthResult } from './plugin-auth.ts';
import type { PluginAuthStateDto } from '@craft-agent/shared/protocol/dto';

let root: string;
let dataDir: string;

const connected = (attempt: number): PluginAuthStateDto => ({
  listenerId: 'wechat',
  phase: 'connected',
  attempt,
});

const resultFor = (state: PluginAuthStateDto, token?: string): PluginAuthResult =>
  token ? { ok: true, state, credentials: { token } } : { ok: true, state };

/**
 * The finisher wired to the production writer. `applyCredentials` also keeps
 * the previous config, the way the real handler merges rather than replaces.
 */
function finisher(configPath = join(dataDir, 'config.json')) {
  const broadcasts: PluginAuthStateDto[] = [];
  const applied: string[] = [];
  let stored: Record<string, unknown> = {};
  if (existsSync(configPath)) stored = JSON.parse(readFileSync(configPath, 'utf8'));

  const finish = createAuthFinisher({
    pushAuthEvent: (_ws, _id, state) => broadcasts.push(state),
    applyCredentials: async (_ws, listenerId, _root, credentials) => {
      stored = { ...stored, ...credentials };
      const written = writeListenerConfigFile(dataDir, stored);
      if (!written) throw new Error('config.json could not be written');
      applied.push(listenerId);
    },
  });
  return { finish, broadcasts, applied };
}

const fileToken = (): unknown => {
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }).token;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-auth-finish-'));
  dataDir = join(root, 'events-data', 'wechat');
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createAuthFinisher', () => {
  it('persists the token when only the poll observes connected', async () => {
    const { finish, applied } = finisher();

    // Nothing but a read — this is the shape of getPluginAuthState polling.
    const safe = await finish('ws', 'wechat', root, resultFor(connected(1), 'poll-token'));

    expect(applied).toEqual(['wechat']);
    // The file the plugin process opens at start.
    expect(fileToken()).toBe('poll-token');
    // The renderer still gets the snapshot, and never the credential.
    expect(safe.state?.phase).toBe('connected');
    expect('credentials' in safe).toBe(false);
  });

  // NTFS has no POSIX mode bits — writeFileSync's `mode` is a no-op there, so
  // asserting 0o600 on Windows would test the platform, not this code.
  it.skipIf(process.platform === 'win32')('writes the file with owner-only permissions', () => {
    writeListenerConfigFile(dataDir, { token: 'secret' });
    const mode = statSync(join(dataDir, 'config.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('keeps a field the person already filled in', async () => {
    writeListenerConfigFile(dataDir, { email: 'me@example.test' });
    const { finish } = finisher();

    await finish('ws', 'wechat', root, resultFor(connected(1), 't'));

    const file = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    expect(file).toEqual({ email: 'me@example.test', token: 't' });
  });

  it('writes once when both the action path and the poll see connected', async () => {
    const { finish, applied, broadcasts } = finisher();

    await finish('ws', 'wechat', root, resultFor(connected(1), 'once')); // action
    await finish('ws', 'wechat', root, resultFor(connected(1), 'once')); // poll
    await finish('ws', 'wechat', root, resultFor(connected(1))); // later poll, no credentials

    expect(applied).toEqual(['wechat']);
    expect(broadcasts).toHaveLength(1);
    expect(fileToken()).toBe('once');
  });

  it('writes again for a genuinely new sign-in', async () => {
    const { finish, applied } = finisher();

    await finish('ws', 'wechat', root, resultFor(connected(1), 'first'));
    // A new flow passes through a non-connected phase before connecting again.
    await finish('ws', 'wechat', root, resultFor({ listenerId: 'wechat', phase: 'awaiting', attempt: 2, qr: 'x' }));
    await finish('ws', 'wechat', root, resultFor(connected(2), 'second'));

    expect(applied).toEqual(['wechat', 'wechat']);
    expect(fileToken()).toBe('second');
  });

  it('a failed write stays retryable instead of being recorded as done', async () => {
    let attempts = 0;
    const finish = createAuthFinisher({
      pushAuthEvent: () => {},
      applyCredentials: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    });
    const state = connected(1);

    const failed = await finish('ws', 'wechat', root, resultFor(state, 't'));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('写入插件配置失败');

    const retried = await finish('ws', 'wechat', root, resultFor(state, 't'));
    expect(retried.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('leaves failed and expired relays alone', async () => {
    const { finish, applied, broadcasts } = finisher();
    const res = await finish('ws', 'wechat', root, {
      ok: false,
      code: 'timeout',
      error: '插件没有在时限内回应',
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('timeout');
    expect(applied).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('broadcasts the non-connected phases so the UI can follow the flow', async () => {
    const { finish, broadcasts } = finisher();
    await finish('ws', 'wechat', root, resultFor({ listenerId: 'wechat', phase: 'awaiting', attempt: 1, qr: 'q' }));
    await finish('ws', 'wechat', root, resultFor({ listenerId: 'wechat', phase: 'scanned', attempt: 1 }));
    expect(broadcasts.map((b) => b.phase)).toEqual(['awaiting', 'scanned']);
  });
});
