/**
 * Planner — turns a strategy group into an ordered upstream plan.
 *
 * This is the piece that sits between config and the key pool. A strategy
 * names providers and a selection algorithm; the planner resolves that against
 * live breaker / limiter state and produces the ordered list of providers to
 * try, plus the retry budget to spend across them.
 *
 * Two invariants drive the design:
 *
 * 1. **A plan is a snapshot.** It is built once per inbound request and never
 *    re-read from config mid-flight, so a config reload cannot change which
 *    providers an in-flight request is cycling through. uni-api calls this the
 *    "planned snapshot" semantic.
 * 2. **The plan is ordered, not a set.** Retry order matters: `failover_only`
 *    must try the first provider and only fall through on a retryable failure,
 *    while `round_robin` starts where the pool left off. Returning an unordered
 *    set would silently turn failover into load-balancing.
 */

import type {
  LlmConfig,
  LlmProvider,
  LlmStrategy,
} from './llm-config.ts';
import { windowAllows } from './model-window.ts';

/** Where a provider sits in the plan, plus why it is there. */
export interface PlannedProvider {
  provider: LlmProvider;
  /** Weight from the strategy member; 1 when unset. */
  weight: number;
  /** False when the strategy explicitly excludes it at plan time. */
  enabled: boolean;
}

export interface RetryPolicy {
  /** Max transient retries on the SAME key before it is cooled and switched. */
  maxAttempts: number;
  /** Status codes eligible for a retry. */
  onStatusCodes: number[];
  /** Backoff between same-key transient retries (ms). */
  backoffMs: number;
}

export interface Plan {
  strategyId: string;
  /** Ordered providers to try. */
  providers: PlannedProvider[];
  retry: RetryPolicy;
  /** Resolved model aliases for this request. */
  modelAliases: Record<string, string>;
  /** The strategy this plan was built from, for alias resolution downstream. */
  strategy: LlmStrategy;
  /** Sticky binding scope, when enabled. */
  stickyScope: 'session' | 'session+model';
  stickyEnabled: boolean;
}

export interface PlanOptions {
  config: LlmConfig;
  strategy: LlmStrategy;
  /** Public model name being requested, used to resolve aliases. */
  publicModel: string;
  /** Providers whose keys are all cooling / rate limited. */
  unavailableProviders?: ReadonlySet<string>;
  /**
   * Clock for availability windows. Injected rather than read inside, so a test
   * can place "now" outside a window without waiting for the wall clock.
   */
  now?: number;
}

/** Hard ceiling on attempts regardless of config, so a typo cannot loop forever. */
export const MAX_ATTEMPTS_CEILING = 10;

const DEFAULT_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Resolve the public model name to the upstream model id for a provider.
 *
 * Strategy `modelAliases` win over provider `models`, because the alias table
 * is what the operator edits per strategy and a provider-level mapping is the
 * fallback for models not otherwise named.
 */
export function resolveUpstreamModel(
  strategy: LlmStrategy,
  provider: LlmProvider,
  publicModel: string,
): string {
  const alias = strategy.modelAliases?.[publicModel];
  if (alias) return alias;

  // Provider `models` is upstream id -> public name; reverse it.
  const entries = Object.entries(provider.models ?? {});
  for (const [upstreamId, publicName] of entries) {
    if (publicName === publicModel) return upstreamId;
  }
  // A public name may itself be a valid upstream id (identity mapping).
  return publicModel;
}

export function resolveRetryPolicy(strategy: LlmStrategy): RetryPolicy {
  const retry = strategy.retry ?? {};
  const requested = Math.max(1, Math.floor(retry.maxAttempts ?? 3));
  return {
    // Clamp: an unbounded maxAttempts turns a config typo into a hang.
    maxAttempts: Math.min(requested, MAX_ATTEMPTS_CEILING),
    onStatusCodes: retry.onStatusCodes?.length
      ? [...retry.onStatusCodes]
      : [...DEFAULT_RETRY_STATUS_CODES],
    backoffMs: Math.max(0, Math.floor(retry.backoffMs ?? 500)),
  };
}

/**
 * Build the plan for one inbound request.
 *
 * Throws only when the strategy names a provider id that does not exist —
 * that is a config error and must surface loudly rather than silently
 * degrade to "try everything".
 */
export function planRequest(options: PlanOptions): Plan {
  const { config, strategy, publicModel, unavailableProviders = new Set() } = options;

  const members: Array<{ provider: LlmProvider; weight: number }> = [];
  // Members skipped because this model is outside its availability window. They
  // are not failures — the point of a window is that the member is absent, not
  // that it errors — so they are counted separately for the refusal message.
  let outsideWindow = 0;
  const now = options.now ?? Date.now();
  for (const member of strategy.members) {
    const provider = config.providers.find((p) => p.id === member.provider);
    if (!provider) {
      throw new Error(
        `Strategy "${strategy.id}" references unknown provider "${member.provider}"`,
      );
    }
    if (provider.enabled === false) continue;
    // A model pinned to specific providers must not fall back to a member that
    // merely speaks the same upstream name — that is the whole point of
    // modelling two same-named models as two units.
    const pinned = strategy.modelProviders?.[publicModel];
    if (pinned && !pinned.includes(member.provider)) continue;
    if (!windowAllows(provider.timeWindows?.[publicModel], now)) {
      outsideWindow += 1;
      continue;
    }
    members.push({ provider, weight: member.weight ?? 1 });
  }

  if (members.length === 0) {
    throw new Error(
      outsideWindow > 0
        ? `Strategy "${strategy.id}" has no providers available for "${publicModel}" right now (outside its time window)`
        : `Strategy "${strategy.id}" has no enabled providers`,
    );
  }

  const ordered = members
    .map(({ provider, weight }): PlannedProvider => ({ provider, weight, enabled: true }))
    .filter((p) => !unavailableProviders.has(p.provider.id));

  if (ordered.length === 0) {
    throw new Error(
      `Strategy "${strategy.id}" has no usable providers right now (all cooling or disabled)`,
    );
  }

  return {
    strategyId: strategy.id,
    providers: ordered,
    retry: resolveRetryPolicy(strategy),
    modelAliases: { ...(strategy.modelAliases ?? {}) },
    strategy,
    stickyEnabled: strategy.stickySession?.enabled ?? false,
    stickyScope: strategy.stickySession?.scope ?? 'session',
  };
}

/**
 * Resolve which strategy a client key may use.
 *
 * The client key is the inbound credential; a request without a valid one is
 * rejected before any planning happens. A key may name several strategies, so
 * the request's model is matched against the first strategy whose members can
 * serve it.
 */
export function resolveStrategyForClientKey(
  config: LlmConfig,
  clientKey: string,
  publicModel: string,
): LlmStrategy | null {
  const entry = config.clientKeys.find((c) => c.key === clientKey);
  if (!entry) return null;

  for (const strategyId of entry.strategies) {
    const strategy = config.strategies.find((s) => s.id === strategyId);
    if (!strategy) continue;
    if (strategyMembersServeModel(config, strategy, publicModel)) return strategy;
  }
  // Fall back to the first permitted strategy even if model matching is
  // inconclusive: refusing to route would break models that appear only via
  // aliases the matcher cannot see.
  for (const strategyId of entry.strategies) {
    const strategy = config.strategies.find((s) => s.id === strategyId);
    if (strategy) return strategy;
  }
  return null;
}

function strategyMembersServeModel(
  config: LlmConfig,
  strategy: LlmStrategy,
  publicModel: string,
): boolean {
  if (strategy.modelAliases && publicModel in strategy.modelAliases) return true;
  for (const member of strategy.members) {
    const provider = config.providers.find((p) => p.id === member.provider);
    if (!provider) continue;
    const names = Object.values(provider.models ?? {});
    if (names.includes(publicModel)) return true;
  }
  return false;
}
