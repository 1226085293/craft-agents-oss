/**
 * Planner tests.
 *
 * The plan is what a whole request cycles through, so the tests pin the two
 * properties that break silently in production:
 *
 * - a plan is a snapshot — re-planning mid-flight would let a config reload
 *   swap the upstream under an in-flight retry ladder;
 * - ordering is meaningful — `failover_only` must never silently load-balance.
 */

import { describe, it, expect } from 'bun:test';

import {
  planRequest,
  resolveRetryPolicy,
  resolveStrategyForClientKey,
  resolveUpstreamModel,
  MAX_ATTEMPTS_CEILING,
} from '../llm-planner.ts';
import type { LlmConfig, LlmProvider, LlmStrategy } from '../llm-config.ts';
import type { ModelWindow } from '../model-window.ts';

function provider(id: string, over: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1/chat/completions`,
    protocol: 'anthropic-messages',
    keys: [{ id: `${id}-k1`, key: 'sk-test' }],
    ...over,
  };
}

function strategy(id: string, over: Partial<LlmStrategy> = {}): LlmStrategy {
  return {
    id,
    type: 'round_robin',
    members: [{ provider: 'p1' }, { provider: 'p2' }],
    ...over,
  };
}

function config(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    version: 1,
    presets: {},
    providers: [provider('p1'), provider('p2')],
    strategies: [strategy('auto')],
    clientKeys: [],
    ...over,
  };
}

describe('planRequest', () => {
  it('orders providers by declared membership', () => {
    const plan = planRequest({
      config: config(),
      strategy: strategy('auto'),
      publicModel: 'auto',
    });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1', 'p2']);
    expect(plan.strategyId).toBe('auto');
  });

  it('skips disabled providers', () => {
    const cfg = config({
      providers: [provider('p1'), provider('p2', { enabled: false })],
    });
    const plan = planRequest({ config: cfg, strategy: strategy('auto'), publicModel: 'm' });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1']);
  });

  it('pins a model to the providers it was chosen for', () => {
    // Two providers speak `gpt-4`; the operator picked only p2's copy. The other
    // member must not be a fallback just because the upstream name matches.
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['p2'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p2']);
  });

  it('a model pinned to several providers keeps them all, in order', () => {
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['p2', 'p1'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1', 'p2']);
  });

  it('an unpinned model still uses every member', () => {
    // Strategies written before `modelProviders` existed must keep working.
    const strat = strategy('auto', { modelProviders: { other: ['p1'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1', 'p2']);
  });

  it('pinning outranks the whole member list, so a fully-pinned-out model refuses', () => {
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['missing'] } });
    expect(() => planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' })).toThrow(
      /no enabled providers/,
    );
  });

  // Circuit breaking was removed (2026-10-23); ordering is by declared
  // membership only, so the old "circuit-open provider goes last" case is gone.

  it('drops providers whose keys are all cooling', () => {
    const plan = planRequest({
      config: config(),
      strategy: strategy('auto'),
      publicModel: 'auto',
      unavailableProviders: new Set(['p1']),
    });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p2']);
  });

  it('failover_only keeps the declared order as a strict priority ladder', () => {
    const cfg = config({
      strategies: [
        strategy('fo', { type: 'failover_only', members: [{ provider: 'p1' }, { provider: 'p2' }] }),
      ],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1', 'p2']);
  });

  it('is a snapshot: a later config change does not alter the plan', () => {
    const cfg = config();
    const plan = planRequest({ config: cfg, strategy: strategy('auto'), publicModel: 'auto' });
    const before = plan.providers.map((p) => p.provider.id);

    // Simulate a hot reload landing while the request is in flight.
    cfg.providers.push(provider('p3'));
    cfg.strategies[0]!.members.push({ provider: 'p3' });

    expect(plan.providers.map((p) => p.provider.id)).toEqual(before);
    expect(before).toEqual(['p1', 'p2']);
  });

  it('throws on an unknown provider id instead of degrading', () => {
    const cfg = config({
      strategies: [strategy('bad', { members: [{ provider: 'nope' }] })],
    });
    expect(() =>
      planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' }),
    ).toThrow(/unknown provider "nope"/);
  });

  it('throws when every provider is unusable', () => {
    expect(() =>
      planRequest({
        config: config(),
        strategy: strategy('auto'),
        publicModel: 'auto',
        unavailableProviders: new Set(['p1', 'p2']),
      }),
    ).toThrow(/no usable providers/);
  });

  it('carries the weight through from the strategy member', () => {
    const cfg = config({
      strategies: [strategy('w', { type: 'weighted', members: [{ provider: 'p1', weight: 3 }, { provider: 'p2' }] })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(plan.providers.map((p) => p.weight)).toEqual([3, 1]);
  });

  it('resolves model aliases per provider', () => {
    const cfg = config({
      strategies: [strategy('auto', { modelAliases: { auto: 'deepseek-v4' } })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto' });
    expect(plan.modelAliases.auto).toBe('deepseek-v4');
  });
});

describe('planRequest — model time windows', () => {
  // 2026-10-21 12:00 Asia/Shanghai.
  const NOON_SH = Date.UTC(2026, 9, 21, 4, 0, 0);
  const closed: ModelWindow = { tz: 'Asia/Shanghai', spans: [{ start: '09:00', end: '10:00' }] };

  it('drops a member whose window excludes this model right now', () => {
    const cfg = config({
      providers: [provider('p1', { timeWindows: { auto: closed } }), provider('p2')],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto', now: NOON_SH });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p2']);
  });

  it('keeps a member whose window covers this model', () => {
    const open: ModelWindow = { tz: 'Asia/Shanghai', spans: [{ start: '11:00', end: '14:00' }] };
    const cfg = config({ providers: [provider('p1', { timeWindows: { auto: open } }), provider('p2')] });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto', now: NOON_SH });
    expect(plan.providers.map((p) => p.provider.id).sort()).toEqual(['p1', 'p2']);
  });

  it('a window on one model does not affect another', () => {
    const cfg = config({
      providers: [provider('p1', { timeWindows: { auto: closed } })],
      strategies: [strategy('auto', { members: [{ provider: 'p1' }] })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'other', now: NOON_SH });
    expect(plan.providers.map((p) => p.provider.id)).toEqual(['p1']);
  });

  it('refuses with a window-specific reason when every member is outside', () => {
    // The caller turns this into a local refusal — no upstream request, and no
    // provider blamed for a window the user configured on purpose.
    const cfg = config({
      providers: [provider('p1', { timeWindows: { auto: closed } }), provider('p2', { timeWindows: { auto: closed } })],
    });
    expect(() =>
      planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto', now: NOON_SH }),
    ).toThrow(/outside its time window/);
  });
});

describe('resolveRetryPolicy', () => {
  it('uses the strategy values', () => {
    const policy = resolveRetryPolicy(
      strategy('auto', {
        retry: { maxAttempts: 5, onStatusCodes: [429], backoffMs: 250 },
      }),
    );
    expect(policy).toEqual({
      maxAttempts: 5,
      onStatusCodes: [429],
      backoffMs: 250,
    });
  });

  it('clamps a hostile maxAttempts to the ceiling', () => {
    const policy = resolveRetryPolicy(strategy('auto', { retry: { maxAttempts: 9999 } }));
    expect(policy.maxAttempts).toBe(MAX_ATTEMPTS_CEILING);
  });

  it('clamps a zero or negative maxAttempts to at least one attempt', () => {
    expect(resolveRetryPolicy(strategy('a', { retry: { maxAttempts: 0 } })).maxAttempts).toBe(1);
    expect(resolveRetryPolicy(strategy('a', { retry: { maxAttempts: -5 } })).maxAttempts).toBe(1);
  });

  it('falls back to the transient status set when none is configured', () => {
    expect(resolveRetryPolicy(strategy('a')).onStatusCodes).toEqual([429, 500, 502, 503, 504]);
  });

  // `switchProvider` was removed with the circuit-breaker cleanup: the gateway
  // always advances to the next planned provider, so there is no per-strategy
  // toggle left to default.
});

describe('resolveUpstreamModel', () => {
  const prov = provider('p1', { models: { 'up-1': 'public-1' } });

  it('prefers the strategy alias', () => {
    expect(
      resolveUpstreamModel(strategy('a', { modelAliases: { pub: 'up-alias' } }), prov, 'pub'),
    ).toBe('up-alias');
  });

  it('reverses the provider mapping when no alias exists', () => {
    expect(resolveUpstreamModel(strategy('a'), prov, 'public-1')).toBe('up-1');
  });

  it('passes the name through as identity', () => {
    expect(resolveUpstreamModel(strategy('a'), prov, 'untracked')).toBe('untracked');
  });
});

describe('resolveStrategyForClientKey', () => {
  it('rejects an unknown client key', () => {
    expect(
      resolveStrategyForClientKey(config({ clientKeys: [{ key: 'sk-a', strategies: ['auto'] }] }), 'sk-nope', 'm'),
    ).toBeNull();
  });

  it('picks the strategy that can serve the model', () => {
    const cfg = config({
      providers: [
        provider('p1', { models: { 'up-a': 'model-a' } }),
        provider('p2'),
      ],
      strategies: [
        strategy('other', { members: [{ provider: 'p2' }] }),
        strategy('a', { members: [{ provider: 'p1' }] }),
      ],
      clientKeys: [{ key: 'sk-a', strategies: ['other', 'a'] }],
    });
    const picked = resolveStrategyForClientKey(cfg, 'sk-a', 'model-a');
    expect(picked?.id).toBe('a');
  });

  it('falls back to the first permitted strategy', () => {
    const cfg = config({ clientKeys: [{ key: 'sk-a', strategies: ['auto'] }] });
    expect(resolveStrategyForClientKey(cfg, 'sk-a', 'unknown-model')?.id).toBe('auto');
  });

  it('skips a strategy id that no longer exists', () => {
    const cfg = config({ clientKeys: [{ key: 'sk-a', strategies: ['gone', 'auto'] }] });
    expect(resolveStrategyForClientKey(cfg, 'sk-a', 'm')?.id).toBe('auto');
  });
});
