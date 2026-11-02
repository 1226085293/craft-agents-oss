/**
 * Planner tests.
 *
 * The plan is what a whole request cycles through, so the tests pin the two
 * properties that break silently in production:
 *
 * - a plan is a snapshot — re-planning mid-flight would let a config reload
 *   swap the upstream under an in-flight retry ladder;
 * - ordering is meaningful — `failover_only` must never silently load-balance,
 *   and a strategy that names three models on one provider must produce three
 *   ordered units rather than one.
 */

import { describe, it, expect } from 'bun:test';

import {
  candidateUnits,
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

const unitProviders = (plan: ReturnType<typeof planRequest>) =>
  plan.units.map((u) => u.provider.id);

describe('planRequest', () => {
  it('orders units by declared membership', () => {
    const plan = planRequest({
      config: config(),
      strategy: strategy('auto'),
      publicModel: 'auto',
    });
    expect(unitProviders(plan)).toEqual(['p1', 'p2']);
    expect(plan.strategyId).toBe('auto');
  });

  it('skips disabled providers', () => {
    const cfg = config({
      providers: [provider('p1'), provider('p2', { enabled: false })],
    });
    const plan = planRequest({ config: cfg, strategy: strategy('auto'), publicModel: 'm' });
    expect(unitProviders(plan)).toEqual(['p1']);
  });

  it('pins a model to the providers it was chosen for', () => {
    // Two providers speak `gpt-4`; the operator picked only p2's copy. The other
    // member must not be a fallback just because the upstream name matches.
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['p2'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(unitProviders(plan)).toEqual(['p2']);
  });

  it('a model pinned to several providers keeps them all, in order', () => {
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['p2', 'p1'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(unitProviders(plan)).toEqual(['p1', 'p2']);
  });

  it('an unpinned model still uses every member', () => {
    // Strategies written before `modelProviders` existed must keep working.
    const strat = strategy('auto', { modelProviders: { other: ['p1'] } });
    const plan = planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' });
    expect(unitProviders(plan)).toEqual(['p1', 'p2']);
  });

  it('pinning outranks the whole member list, so a fully-pinned-out model refuses', () => {
    const strat = strategy('auto', { modelProviders: { 'gpt-4': ['missing'] } });
    expect(() => planRequest({ config: config(), strategy: strat, publicModel: 'gpt-4' })).toThrow(
      /cannot serve "gpt-4"/,
    );
  });

  // Circuit breaking was removed (2026-10-23); ordering is by declared
  // membership only, so the old "circuit-open provider goes last" case is gone.

  it('drops units whose keys are all cooling', () => {
    const plan = planRequest({
      config: config(),
      strategy: strategy('auto'),
      publicModel: 'auto',
      unavailableUnits: new Set(['p1::auto']),
    });
    expect(unitProviders(plan)).toEqual(['p2']);
  });

  it('failover_only keeps the declared order as a strict priority ladder', () => {
    const cfg = config({
      strategies: [
        strategy('fo', { type: 'failover_only', members: [{ provider: 'p1' }, { provider: 'p2' }] }),
      ],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(unitProviders(plan)).toEqual(['p1', 'p2']);
  });

  it('is a snapshot: a later config change does not alter the plan', () => {
    const cfg = config();
    const plan = planRequest({ config: cfg, strategy: strategy('auto'), publicModel: 'auto' });
    const before = unitProviders(plan);

    // Simulate a hot reload landing while the request is in flight.
    cfg.providers.push(provider('p3'));
    cfg.strategies[0]!.members.push({ provider: 'p3' });

    expect(unitProviders(plan)).toEqual(before);
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

  it('throws when every unit is unusable', () => {
    expect(() =>
      planRequest({
        config: config(),
        strategy: strategy('auto'),
        publicModel: 'auto',
        unavailableUnits: new Set(['p1::auto', 'p2::auto']),
      }),
    ).toThrow(/no usable unit/);
  });

  it('carries the weight through from the strategy member', () => {
    const cfg = config({
      strategies: [strategy('w', { type: 'weighted', members: [{ provider: 'p1', weight: 3 }, { provider: 'p2' }] })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(plan.units.map((u) => u.weight)).toEqual([3, 1]);
  });

  it('resolves the upstream model per unit', () => {
    const cfg = config({
      strategies: [strategy('auto', { modelAliases: { auto: 'deepseek-v4' } })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto' });
    expect(plan.units.map((u) => u.upstreamModel)).toEqual(['deepseek-v4', 'deepseek-v4']);
  });
});

describe('planRequest — switching units', () => {
  /**
   * The incident this models: one provider exposing three models. Before
   * units existed the plan held one provider, so a 404 on the first model
   * cooled the only key and refused the other two for a minute
   * (261027-long-bronze).
   */
  const threeModelStrategy = (): LlmStrategy => ({
    id: 'wb',
    type: 'round_robin',
    members: [
      { provider: 'wb', model: 'flash' },
      { provider: 'wb', model: 'hy4' },
      { provider: 'wb', model: 'hy3' },
    ],
    modelAliases: { flash: 'flash', hy4: 'hy4', hy3: 'hy3' },
  });

  const threeModelConfig = (): LlmConfig => ({
    version: 1,
    presets: {},
    providers: [
      provider('wb', { models: { flash: 'flash', hy4: 'hy4', hy3: 'hy3' }, keys: [] }),
    ],
    strategies: [threeModelStrategy()],
    clientKeys: [],
  });

  it('expands one provider into three ordered units, requested model first', () => {
    const cfg = threeModelConfig();
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'flash' });
    // The requested model is the first attempt; the rest of the group follows.
    expect(plan.units.map((u) => u.id)).toEqual(['wb::flash', 'wb::hy4', 'wb::hy3']);
  });

  it('a unit is addressable by (provider, model)', () => {
    const cfg = threeModelConfig();
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'hy4' });
    expect(plan.units[0]!.id).toBe('wb::hy4');
    expect(plan.units[0]!.upstreamModel).toBe('hy4');
  });

  it('tries the requested model first, then the rest of the group in declared order', () => {
    const cfg = threeModelConfig();
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'hy3' });
    expect(plan.units.map((u) => u.id)).toEqual(['wb::hy3', 'wb::flash', 'wb::hy4']);
    expect(plan.units[0]!.publicModel).toBe('hy3');
  });

  it('uses a member upstreamModel override over the strategy alias', () => {
    const cfg: LlmConfig = {
      version: 1,
      presets: {},
      providers: [provider('a', { models: { 'a-1': 'A1' } }), provider('b', { models: { 'b-1': 'A1' } })],
      strategies: [
        {
          id: 'mix',
          type: 'round_robin',
          members: [
            { provider: 'a', model: 'A1', upstreamModel: 'a-1' },
            { provider: 'b', model: 'A1', upstreamModel: 'b-1' },
          ],
          modelAliases: { A1: 'A1' },
        },
      ],
      clientKeys: [],
    };
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'A1' });
    expect(plan.units.map((u) => `${u.provider.id}:${u.upstreamModel}`)).toEqual(['a:a-1', 'b:b-1']);
  });

  it('dedupes two members naming the same route, keeping the first position', () => {
    const cfg = config({
      strategies: [
        strategy('dup', {
          members: [
            { provider: 'p1', model: 'm' },
            { provider: 'p2', model: 'm' },
            { provider: 'p1', model: 'm' },
          ],
        }),
      ],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(plan.units.map((u) => u.id)).toEqual(['p1::m', 'p2::m']);
  });

  it('skips a member disabled on its own', () => {
    const cfg = config({
      strategies: [
        strategy('off', {
          members: [
            { provider: 'p1', model: 'm', enabled: false },
            { provider: 'p2', model: 'm' },
          ],
        }),
      ],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'm' });
    expect(plan.units.map((u) => u.provider.id)).toEqual(['p2']);
  });

  it('refuses a model the group does not declare at all', () => {
    // A group serves the models it declares; a typo must be reported, not
    // quietly answered by an unrelated model in the same group.
    const cfg = config({
      strategies: [strategy('pinned', { members: [{ provider: 'p1', model: 'other' }] })],
    });
    expect(() =>
      planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'wanted' }),
    ).toThrow(/no member serves "wanted"/);
  });

  it('serves a declared model the group has no member for, from the group', () => {
    // `flash` is advertised by the alias map; the request must ride a member of
    // the same group rather than ending the turn.
    const cfg = config({
      providers: [provider('p1', { keys: [] })],
      strategies: [strategy('pool', {
        members: [{ provider: 'p1', model: 'hy3' }],
        modelAliases: { 'hy4-preview': 'hy4-preview', hy3: 'hy3' },
      })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'hy4-preview' });
    expect(plan.units.map((u) => u.id)).toEqual(['p1::hy3']);
  });

  it('candidateUnits reports skip reasons for the availability probe', () => {
    const cfg = threeModelConfig();
    const candidates = candidateUnits(cfg, cfg.strategies[0]!, 'flash');
    // flash first, then the two other models as fallback routes.
    expect(candidates.units).toHaveLength(3);
    expect(candidates.otherModel).toBe(2);
    expect(candidates.totalMembers).toBe(3);
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
    expect(unitProviders(plan)).toEqual(['p2']);
  });

  it('keeps a member whose window covers this model', () => {
    const open: ModelWindow = { tz: 'Asia/Shanghai', spans: [{ start: '11:00', end: '14:00' }] };
    const cfg = config({ providers: [provider('p1', { timeWindows: { auto: open } }), provider('p2')] });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto', now: NOON_SH });
    expect(unitProviders(plan).sort()).toEqual(['p1', 'p2']);
  });

  it('a window on one model does not affect another', () => {
    const cfg = config({
      providers: [provider('p1', { timeWindows: { auto: closed } })],
      strategies: [strategy('auto', { members: [{ provider: 'p1' }] })],
    });
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'other', now: NOON_SH });
    expect(unitProviders(plan)).toEqual(['p1']);
  });

  it('refuses with a window-specific reason when every member is outside', () => {
    // The caller turns this into a local refusal — no upstream request, and no
    // provider blamed for a window the user configured on purpose.
    const cfg = config({
      providers: [provider('p1', { timeWindows: { auto: closed } }), provider('p2', { timeWindows: { auto: closed } })],
    });
    expect(() =>
      planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'auto', now: NOON_SH }),
    ).toThrow(/outside its availability window/);
  });
});

describe('planRequest — cross-model fallback', () => {
  // 2026-10-21 17:00 Asia/Shanghai: hy4 is closed, hy3 is open all day.
  const EVENING_SH = Date.UTC(2026, 9, 21, 9, 0, 0)
  const hy4Window: ModelWindow = {
    tz: 'Asia/Shanghai',
    spans: [{ start: '23:00', end: '08:00' }],
    to: '2026-10-31 23:59',
  }

  const groupConfig = (timeWindows: Record<string, ModelWindow>) => config({
    providers: [provider('wb', { timeWindows, keys: [] })],
    strategies: [strategy('wb', {
      members: [
        { provider: 'wb', model: 'hy4' },
        { provider: 'wb', model: 'hy3' },
      ],
      modelAliases: { hy4: 'hy4', hy3: 'hy3' },
    })],
  })

  it('falls back to another model when the requested one is outside its window', () => {
    const cfg = groupConfig({ hy4: hy4Window })
    const plan = planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'hy4', now: EVENING_SH })
    expect(plan.units.map((u) => u.id)).toEqual(['wb::hy3'])
  })

  it('keeps the requested model first while it is inside its window', () => {
    const cfg = groupConfig({ hy4: hy4Window })
    // 2026-10-21 23:30 Asia/Shanghai — hy4 is open now.
    const plan = planRequest({
      config: cfg,
      strategy: cfg.strategies[0]!,
      publicModel: 'hy4',
      now: Date.UTC(2026, 9, 21, 15, 30, 0),
    })
    expect(plan.units.map((u) => u.id)).toEqual(['wb::hy4', 'wb::hy3'])
  })

  it('refuses only when every model in the group is closed', () => {
    const cfg = groupConfig({ hy4: hy4Window, hy3: hy4Window })
    expect(() =>
      planRequest({ config: cfg, strategy: cfg.strategies[0]!, publicModel: 'hy4', now: EVENING_SH }),
    ).toThrow(/every model is outside its availability window/)
  })
})

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
});

describe('resolveUpstreamModel', () => {
  const prov = provider('p1', { models: { 'up-1': 'public-1' } });

  it('prefers the strategy alias', () => {
    expect(
      resolveUpstreamModel(strategy('a', { modelAliases: { pub: 'up-alias' } }), prov, 'pub'),
    ).toBe('up-alias');
  });

  it('prefers a member override over the alias', () => {
    expect(
      resolveUpstreamModel(strategy('a', { modelAliases: { pub: 'up-alias' } }), prov, 'pub', {
        provider: 'p1',
        upstreamModel: 'member-up',
      }),
    ).toBe('member-up');
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

  it('matches a model named directly on a member', () => {
    const cfg = config({
      strategies: [strategy('pinned', { members: [{ provider: 'p1', model: 'unit-model' }] })],
      clientKeys: [{ key: 'sk-a', strategies: ['pinned'] }],
    });
    expect(resolveStrategyForClientKey(cfg, 'sk-a', 'unit-model')?.id).toBe('pinned');
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
