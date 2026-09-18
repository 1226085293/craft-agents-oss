import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  CRAFT_PI_COMPACTION_RESERVE_TOKENS,
  CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS,
  CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS,
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS,
  CRAFT_PI_RETRY_SETTINGS,
  PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
  PI_DEFAULT_KEEP_RECENT_TOKENS,
  craftCompactionSettings,
  createCraftSettingsManager,
} from './session-settings.ts';

describe('createCraftSettingsManager', () => {
  it('pins the agent-level auto-retry policy', () => {
    const settings = createCraftSettingsManager();
    expect(settings.getRetryEnabled()).toBe(true);
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: CRAFT_PI_RETRY_SETTINGS.maxRetries,
      baseDelayMs: CRAFT_PI_RETRY_SETTINGS.baseDelayMs,
    });
  });

  it('enables provider-level (pre-stream) retries that the SDK leaves off by default', () => {
    const settings = createCraftSettingsManager();
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: CRAFT_PI_RETRY_SETTINGS.provider.maxRetries,
      maxRetryDelayMs: CRAFT_PI_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    // Documents the SDK default this policy overrides. If a future SDK turns
    // provider retries on by itself, this assertion is the cue to revisit.
    expect(SettingsManager.inMemory().getProviderRetrySettings().maxRetries).toBeUndefined();
  });

  it('uses a smaller retry policy for bounded ephemeral queries', () => {
    const settings = createCraftSettingsManager('ephemeral');
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries,
      baseDelayMs: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.baseDelayMs,
    });
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetries,
      maxRetryDelayMs: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    expect(CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS).toBe(66_000);
    expect(CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS).toBe(115_000);
    expect(CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS).toBeLessThan(
      CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS,
    );
  });

  it('keeps auto-compaction enabled', () => {
    expect(createCraftSettingsManager().getCompactionEnabled()).toBe(true);
  });

  it('ignores a .pi/settings.json in the working directory', () => {
    // A repo used as the session's working directory may ship Pi project
    // settings. The SDK's default SettingsManager.create(cwd, agentDir) merges
    // them (project scope is trusted by default) — a repo could silently turn
    // off retries or compaction for Craft sessions. The in-memory manager must
    // not see them.
    const cwd = mkdtempSync(join(tmpdir(), 'craft-pi-settings-'));
    try {
      mkdirSync(join(cwd, '.pi'));
      writeFileSync(
        join(cwd, '.pi', 'settings.json'),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
      );

      // Proves the default path would have honored the repo file…
      const fromDisk = SettingsManager.create(cwd, join(cwd, 'agent-dir'));
      expect(fromDisk.getRetryEnabled()).toBe(false);
      expect(fromDisk.getCompactionEnabled()).toBe(false);

      // …and that Craft's manager does not.
      const settings = createCraftSettingsManager();
      expect(settings.getRetryEnabled()).toBe(true);
      expect(settings.getCompactionEnabled()).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a fresh manager per call so sessions cannot leak settings into each other', () => {
    const a = createCraftSettingsManager('ephemeral');
    const b = createCraftSettingsManager('ephemeral');
    expect(a).not.toBe(b);
    a.setRetryEnabled(false);
    expect(a.getRetryEnabled()).toBe(false);
    expect(b.getRetryEnabled()).toBe(true);
  });
});

describe('craftCompactionSettings', () => {
  it('raises the reserve above the upstream default on large-context models', () => {
    // 0.8 x reserve is the summarization request's maxTokens. The upstream
    // default (16k -> ~13k) is smaller than one `xhigh` summary's thinking
    // spend, so the summary came back stopReason "length" and compaction died.
    const settings = craftCompactionSettings(200_000);
    expect(settings.reserveTokens).toBeGreaterThan(PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
    expect(settings.reserveTokens).toBeLessThanOrEqual(CRAFT_PI_COMPACTION_RESERVE_TOKENS);
  });

  it('never reserves more than the window can absorb on small-context models', () => {
    // A 32k window must keep the upstream default, not a 32k reserve that
    // would leave nothing to work with.
    expect(craftCompactionSettings(32_000).reserveTokens).toBe(PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
    expect(craftCompactionSettings(8_192).reserveTokens).toBe(PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
  });

  it('falls back to the upstream default when the window is unknown', () => {
    expect(craftCompactionSettings().reserveTokens).toBe(PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
    expect(craftCompactionSettings(0).reserveTokens).toBe(PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
  });

  it('keeps compaction enabled and preserves the other SDK fields', () => {
    const settings = craftCompactionSettings(200_000);
    expect(settings.enabled).toBe(true);
    expect(settings.keepRecentTokens).toBe(PI_DEFAULT_KEEP_RECENT_TOKENS);
  });
});
