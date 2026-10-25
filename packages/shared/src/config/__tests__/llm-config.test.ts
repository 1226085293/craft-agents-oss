/**
 * Tests for the llm-config.json schema helpers and validation.
 *
 * Cover the three invariants that keep the gateway safe when a human (or a
 * model) hand-edits the JSON:
 *
 * 1. Invalid configs are rejected wholesale, not partially applied.
 * 2. Every error is reported at once, so the JSON view can list them all.
 * 3. Migration from the legacy `config.json` llmConnections[] array is lossless
 *    for the fields the gateway actually needs, and skips non-API-key auth.
 */

import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_PRESET,
  DEFAULT_PRESET_ID,
  emptyLlmConfig,
  maskKey,
  baseUrlOrigin,
  resolvePreset,
  resolvePresetId,
  type LlmConfig,
} from '../llm-config.ts';
import {
  parseLlmConfig,
  validateLlmConfig,
  saveLlmConfig,
  LLM_CONFIG_PATH,
} from '../llm-config-loader.ts';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: { default: { concurrency: 1 } },
    providers: [
      {
        id: 'p1',
        name: 'p1',
        baseUrl: 'https://api.example.com/v1/chat/completions',
        protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'sk-abcdef1234567890' }],
      },
    ],
    strategies: [{ id: 's1', type: 'round_robin', members: [{ provider: 'p1' }] }],
    clientKeys: [{ key: 'sk-client', strategies: ['s1'] }],
    ...overrides,
  };
}

describe('validateLlmConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(validateLlmConfig(makeConfig())).toEqual([]);
  });

  it('rejects a non-object root', () => {
    expect(validateLlmConfig([])).toEqual(['顶层必须是对象']);
    expect(validateLlmConfig('x')).toEqual(['顶层必须是对象']);
    expect(validateLlmConfig(null)).toEqual(['顶层必须是对象']);
  });

  it('reports every structural error at once', () => {
    const errors = validateLlmConfig({
      version: 2,
      presets: 5,
      providers: 'nope',
      strategies: [],
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.join(' ')).toContain('version');
    expect(errors.join(' ')).toContain('presets');
    expect(errors.join(' ')).toContain('providers');
  });

  it('flags duplicate provider ids', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [
        { id: 'dup', name: 'a', baseUrl: 'https://a.com/v1', protocol: 'openai-completions', keys: [{ id: 'k', key: 'k1' }] },
        { id: 'dup', name: 'b', baseUrl: 'https://b.com/v1', protocol: 'openai-completions', keys: [{ id: 'k2', key: 'k2' }] },
      ],
      strategies: [{ id: 's1', type: 'round_robin', members: [{ provider: 'dup' }] }],
    }));
    expect(errors.join(' ')).toContain('provider id 重复');
  });

  it('flags a strategy member referencing an unknown provider', () => {
    const errors = validateLlmConfig(makeConfig({
      strategies: [{ id: 's1', type: 'round_robin', members: [{ provider: 'ghost' }] }],
    }));
    expect(errors.join(' ')).toContain('不存在的 provider: ghost');
  });

  it('flags a clientKey referencing an unknown strategy', () => {
    const errors = validateLlmConfig(makeConfig({
      clientKeys: [{ key: 'sk-x', strategies: ['nope'] }],
    }));
    expect(errors.join(' ')).toContain('不存在的 strategy: nope');
  });

  it('rejects an unknown strategy type', () => {
    const errors = validateLlmConfig(makeConfig({
      // Cast through unknown: the validator must catch a bogus type at runtime,
      // which the literal union would otherwise reject at compile time.
      strategies: [{ id: 's1', type: 'teleport' as unknown as 'round_robin', members: [{ provider: 'p1' }] }],
    }));
    expect(errors.join(' ')).toContain('type 需为');
  });

  it('rejects negative preset numbers', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'k', overrides: { maxImageParts: -1 } }],
      }],
    }));
    expect(errors.join(' ')).toContain('不能为负');
  });

  it('accepts a well-formed custom window', () => {
    expect(
      validateLlmConfig(makeConfig({
        presets: { p: { customLimits: [{ amount: 500, unit: 'requests', per: 5, perUnit: 'hours' }] } },
      })),
    ).toEqual([]);
  });

  it('rejects malformed custom windows field-by-field', () => {
    // A limit the user believes in but the scheduler cannot read is worse than
    // a refused save, so each bad field is reported at save time.
    const errors = validateLlmConfig(makeConfig({
      presets: {
        p: {
          customLimits: [{ amount: 0, unit: 'widgets', per: -1, perUnit: 'days' }] as never,
        },
      },
    }));
    const joined = errors.join(' ');
    expect(joined).toContain('customLimits[0].amount');
    expect(joined).toContain('customLimits[0].unit');
    expect(joined).toContain('customLimits[0].per');
    expect(joined).toContain('customLimits[0].perUnit');
  });

  it('rejects a customLimits that is not an array', () => {
    const errors = validateLlmConfig(makeConfig({
      presets: { p: { customLimits: 5 as never } },
    }));
    expect(errors.join(' ')).toContain('customLimits 必须是数组');
  });

  it('accepts per-model capability declarations', () => {
    // The settings page writes these on every model save; a false rejection
    // would block the whole dialog, capabilities included.
    const errors = validateLlmConfig(makeConfig({
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'k' }],
        modelOptions: {
          'step-5-preview': { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsImages: true, supportsThinking: true },
        },
      }],
    }));
    expect(errors).toEqual([]);
  });

  it('rejects a non-object modelOptions entry and non-numeric token counts', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'k' }],
        // `'1M'` is what a text input writes when parsing is skipped — it must
        // not reach the file, where every reader would compute with NaN.
        modelOptions: { m: 'yes', n: { contextWindow: '1M' } } as unknown as LlmConfig['providers'][number]['modelOptions'],
      }],
    }));
    expect(errors.join(' ')).toContain('modelOptions[m] 必须是对象');
    expect(errors.join(' ')).toContain('modelOptions[n].contextWindow 必须是数字');
  });

  it('rejects negative and fractional token counts', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'k' }],
        modelOptions: { m: { contextWindow: -1, maxOutputTokens: 1.5 } },
      }],
    }));
    expect(errors.join(' ')).toContain('contextWindow 不能为负');
    expect(errors.join(' ')).toContain('maxOutputTokens 必须是整数');
  });

  it('rejects a non-boolean support flag', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        keys: [{ id: 'k1', key: 'k' }],
        modelOptions: { m: { supportsImages: 'yes', supportsThinking: 1 } } as unknown as LlmConfig['providers'][number]['modelOptions'],
      }],
    }));
    expect(errors.join(' ')).toContain('supportsImages 必须是布尔');
    expect(errors.join(' ')).toContain('supportsThinking 必须是布尔');
  });

  it('rejects keys that are not an array', () => {
    const errors = validateLlmConfig(makeConfig({
      // Deliberately malformed: the validator must reject `keys` as a string
      // even though the compile-time type only admits an array.
      providers: [{ id: 'p1', name: 'p1', baseUrl: 'https://a.com/v1', protocol: 'openai-completions', keys: 'sk-x' } as never],
    }));
    expect(errors.join(' ')).toContain('keys 必须是数组');
  });

  it('accepts a miniStrategy that names a real strategy', () => {
    const errors = validateLlmConfig(makeConfig({ miniStrategy: 's1' }));
    expect(errors).toEqual([]);
  });

  it('rejects a miniStrategy naming a strategy that does not exist', () => {
    // Without this, a typo would silently leave every auxiliary call on the
    // direct connection — the very bypass this setting exists to close.
    const errors = validateLlmConfig(makeConfig({ miniStrategy: 'nope' }));
    expect(errors.join(' ')).toContain('miniStrategy 引用了不存在的 strategy: nope');
  });

  it('rejects a non-string miniStrategy', () => {
    const errors = validateLlmConfig(makeConfig({ miniStrategy: 7 as unknown as string }));
    expect(errors.join(' ')).toContain('miniStrategy 必须是非空字符串');
  });

  it('leaves miniStrategy absent when unset', () => {
    // An existing config without the key must keep validating clean.
    expect(validateLlmConfig(makeConfig({}))).toEqual([]);
  });

  it('accepts a defaultStrategy that names a real strategy', () => {
    const errors = validateLlmConfig(makeConfig({ defaultStrategy: 's1' }));
    expect(errors).toEqual([]);
  });

  it('rejects a defaultStrategy naming a strategy that does not exist', () => {
    // Every new session inherits this, so a typo here would mis-route all of
    // them — including the ones created by automations, which the user never
    // sees being made.
    const errors = validateLlmConfig(makeConfig({ defaultStrategy: 'nope' }));
    expect(errors.join(' ')).toContain('defaultStrategy 引用了不存在的 strategy: nope');
  });

  it('rejects a non-string defaultStrategy', () => {
    const errors = validateLlmConfig(makeConfig({ defaultStrategy: 7 as unknown as string }));
    expect(errors.join(' ')).toContain('defaultStrategy 必须是非空字符串');
  });

  it('leaves defaultStrategy absent when unset', () => {
    expect(validateLlmConfig(makeConfig({}))).toEqual([]);
  });

  it('allows a provider with no keys yet — the gateway stays disabled until one lands', () => {
    const errors = validateLlmConfig(makeConfig({
      providers: [{ id: 'p1', name: 'p1', baseUrl: 'https://a.com/v1', protocol: 'openai-completions', keys: [] }],
    }));
    expect(errors).toEqual([]);
  });
});

describe('parseLlmConfig', () => {
  it('returns null and reports the reason on malformed JSON', () => {
    const reasons: string[] = [];
    expect(parseLlmConfig('{ not json', (m) => reasons.push(m))).toBeNull();
    expect(reasons[0]).toContain('JSON 解析失败');
  });

  it('returns null without throwing on a validation failure', () => {
    const reasons: string[] = [];
    expect(parseLlmConfig('{"version":9}', (m) => reasons.push(m))).toBeNull();
    expect(reasons[0]).toContain('校验失败');
  });

  it('round-trips a valid config', () => {
    const raw = JSON.stringify(makeConfig());
    expect(parseLlmConfig(raw)).toEqual(makeConfig());
  });
});

describe('maskKey', () => {
  it('keeps enough of the tail to tell same-host keys apart', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-123…cdef');
  });

  it('handles short keys without leaking them entirely', () => {
    expect(maskKey('short')).toBe('sho…rt');
    expect(maskKey('')).toBe('');
  });
});

describe('baseUrlOrigin', () => {
  it('ignores path so the same host maps to one provider', () => {
    expect(baseUrlOrigin('https://api.agnes-ai.cn/v1/chat/completions'))
      .toBe(baseUrlOrigin('https://api.agnes-ai.cn/v1'));
  });

  it('distinguishes hosts that only differ by subdomain', () => {
    expect(baseUrlOrigin('https://api.agnes-ai.cn/v1'))
      .not.toBe(baseUrlOrigin('https://apihub.agnes-ai.com/v1'));
  });

  it('falls back to the raw string when the URL is unparseable', () => {
    expect(baseUrlOrigin('not a url')).toBe('not a url');
  });
});

describe('resolvePreset', () => {
  it('layers provider then key overrides above the named preset', () => {
    const config = makeConfig({
      presets: { default: { concurrency: 10 }, pro: { concurrency: 50 } },
      providers: [{
        id: 'p1', name: 'p1',
        baseUrl: 'https://a.com/v1', protocol: 'openai-completions',
        defaultPreset: 'default',
        overrides: { concurrency: 20 },
        keys: [{ id: 'k1', key: 'x', preset: 'pro', overrides: { concurrency: 999 } }],
      }],
    });
    const preset = resolvePreset(config, config.providers[0]!, config.providers[0]!.keys[0]!);
    expect(preset.concurrency).toBe(999); // key override wins
  });

  it('falls back to DEFAULT_PRESET when the named preset is missing', () => {
    const config = makeConfig({ presets: {} });
    const preset = resolvePreset(config, config.providers[0]!, config.providers[0]!.keys[0]!);
    expect(preset.maxImageParts).toBe(DEFAULT_PRESET.maxImageParts);
  });

  it('resolves a key with an empty preset through its provider default', () => {
    // The settings page writes `preset: ''` for "inherit default". `??` treated
    // that as a real name and skipped the provider, so the key displayed the
    // provider's type while running the built-in limits.
    const config = makeConfig({ presets: { default: { concurrency: 10 }, fast: { concurrency: 60 } } });
    const provider = { ...config.providers[0]!, defaultPreset: 'fast' };
    const key = { ...provider.keys[0]!, preset: '' };
    expect(resolvePreset(config, provider, key).concurrency).toBe(60);
  });
});

describe('resolvePresetId', () => {
  const config = (): LlmConfig =>
    makeConfig({ presets: { default: { concurrency: 10 }, fast: { concurrency: 60 } } });

  it("prefers the key's own type when it exists", () => {
    const c = config();
    const provider = { ...c.providers[0]!, defaultPreset: 'fast' };
    expect(resolvePresetId(c, provider, { ...provider.keys[0]!, preset: 'default' })).toBe('default');
  });

  it('treats an empty key type as inherit, not as a preset named ""', () => {
    const c = config();
    const provider = { ...c.providers[0]!, defaultPreset: 'fast' };
    expect(resolvePresetId(c, provider, { ...provider.keys[0]!, preset: '' })).toBe('fast');
  });

  it('falls through a deleted key type to the provider default', () => {
    const c = config();
    const provider = { ...c.providers[0]!, defaultPreset: 'fast' };
    expect(resolvePresetId(c, provider, { ...provider.keys[0]!, preset: 'deleted' })).toBe('fast');
  });

  it('falls through a deleted provider default to the built-in default', () => {
    const c = config();
    const provider = { ...c.providers[0]!, defaultPreset: 'deleted' };
    expect(resolvePresetId(c, provider, provider.keys[0]!)).toBe(DEFAULT_PRESET_ID);
  });

  it('falls back to the built-in default when nothing is set', () => {
    const c = config();
    expect(resolvePresetId(c, c.providers[0]!)).toBe(DEFAULT_PRESET_ID);
  });
});

describe('emptyLlmConfig — built-in default preset', () => {
  it('seeds the reserved default row so the fallback is editable', () => {
    const config = emptyLlmConfig();
    // Every unset key already resolves to DEFAULT_PRESET_ID, so without a row
    // the effective limits were real but invisible and unchangeable.
    expect(config.presets[DEFAULT_PRESET_ID]).toBeDefined();
    expect(config.presets[DEFAULT_PRESET_ID]?.firstByteSeconds).toBe(DEFAULT_PRESET.firstByteSeconds);
    expect(config.presets[DEFAULT_PRESET_ID]?.rateLimitSeconds).toBe(DEFAULT_PRESET.rateLimitSeconds);
  });

  it('resolves an unset key to the seeded row', () => {
    // emptyLlmConfig() has no providers, so give it one via makeConfig while
    // keeping the seeded presets.
    const base = emptyLlmConfig();
    const config = makeConfig({ presets: base.presets });
    const preset = resolvePreset(config, config.providers[0]!, config.providers[0]!.keys[0]!);
    expect(preset.concurrency).toBe(DEFAULT_PRESET.concurrency);
    expect(preset.rateLimitSeconds).toBe(DEFAULT_PRESET.rateLimitSeconds);
  });

  it('an unset key on a config with no default row still resolves (legacy configs)', () => {
    // Before seeding existed this silently used DEFAULT_PRESET with no row to
    // edit. The resolution must keep working either way.
    const config = makeConfig({ presets: {} });
    const preset = resolvePreset(config, config.providers[0]!, config.providers[0]!.keys[0]!);
    expect(preset.concurrency).toBe(DEFAULT_PRESET.concurrency);
  });

  it('each call returns a fresh object so a mutating caller cannot poison the next', () => {
    const a = emptyLlmConfig();
    const b = emptyLlmConfig();
    expect(a).not.toBe(b);
    delete (a.presets as Record<string, unknown>)[DEFAULT_PRESET_ID];
    expect(b.presets[DEFAULT_PRESET_ID]).toBeDefined();
  });
});

describe('test config sandbox', () => {
  it('never resolves the config path inside the real config dir', () => {
    // `CONFIG_DIR` is fixed at import, so a test that sets CRAFT_CONFIG_DIR later
    // cannot isolate itself. `paths.ts` redirects any test process to a temp dir;
    // without that guard one `bun test` run wrote a fixture over the user's live
    // llm-config.json and deleted a real provider.
    expect(LLM_CONFIG_PATH.startsWith(tmpdir())).toBe(true);
    expect(LLM_CONFIG_PATH.includes(`${'.craft-agent'}${sep}llm-config.json`)).toBe(false);
  });
});

describe('saveLlmConfig', () => {
  it('refuses to write an invalid config and returns the errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-config-test-'));
    try {
      const prev = process.env.CRAFT_CONFIG_DIR;
      process.env.CRAFT_CONFIG_DIR = dir;
      const bad = makeConfig();
      // Break it in a way validation catches.
      (bad as unknown as Record<string, unknown>).version = 99;
      const result = saveLlmConfig(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('version');
      // Nothing was written.
      expect(existsSync(join(dir, 'llm-config.json'))).toBe(false);
      if (prev === undefined) delete process.env.CRAFT_CONFIG_DIR;
      else process.env.CRAFT_CONFIG_DIR = prev;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

