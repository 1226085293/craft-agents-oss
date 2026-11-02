/**
 * Planner — turns a strategy group into an ordered list of switching units.
 *
 * The unit is a route, not just a provider: `(provider, publicModel,
 * upstreamModel)`. A strategy whose members name a model expands to one unit
 * per declared route, so three models on one provider are three attempts
 * rather than one. Members that name no model keep the old meaning — "any
 * model this provider serves".
 *
 * A group is a pool, not a selector. The requested model's routes are tried
 * first; every other model the group declares follows, in the order the user
 * arranged the members. That is what makes `hy4-preview` falling through to
 * `hy3` a routing decision instead of a client-side error: before this, a
 * member naming another model was counted as "not about this request" and the
 * group refused the turn even though half of it was open.
 *
 * Two invariants drive the design:
 *
 * 1. **A plan is a snapshot.** It is built once per inbound request and never
 *    re-read from config mid-flight, so a config reload cannot change which
 *    units an in-flight request is cycling through (the "planned snapshot"
 *    semantic).
 * 2. **The plan is ordered, not a set.** Retry order matters and is the
 *    member order the user arranged in the strategy editor: a failure moves
 *    down the list. Key rotation inside a unit is the pool's job.
 */

import type {
  LlmConfig,
  LlmProvider,
  LlmStrategy,
  LlmStrategyMember,
} from './llm-config.ts';
import { windowAllows } from './model-window.ts';

/** Where one unit sits in the plan, plus why it is there. */
export interface PlannedUnit {
  /** Stable id: `${provider}::${publicModel}` — used for cooling and logs. */
  id: string;
  provider: LlmProvider;
  /** The model this unit serves; equals the requested one except on a fallback. */
  publicModel: string;
  /** What is actually sent upstream for this unit. */
  upstreamModel: string;
  /** Weight from the strategy member; 1 when unset. */
  weight: number;
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
  /** Ordered units to try. */
  units: PlannedUnit[];
  retry: RetryPolicy;
  /** The strategy this plan was built from, for alias resolution downstream. */
  strategy: LlmStrategy;
  /** Sticky binding scope, when enabled. */
  stickyScope: 'session' | 'session+model';
  stickyEnabled: boolean;
}

export interface PlanOptions {
  config: LlmConfig;
  strategy: LlmStrategy;
  /** Public model name being requested, used to resolve units. */
  publicModel: string;
  /** Unit ids whose keys are all cooling / rate limited. */
  unavailableUnits?: ReadonlySet<string>;
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
 * The id a unit is cooled and logged under.
 *
 * Keyed on the *upstream* model, not the public name: two members may route
 * one public name to two different upstream ids on the same provider (A 家的
 * A1 vs B 家的 A1), and those are different routes with different health.
 * Using the public name would collapse them into one unit — the second one
 * silently disappearing from the plan.
 */
export function unitId(providerId: string, upstreamModel: string): string {
  return `${providerId}::${upstreamModel}`;
}

/**
 * Resolve the public model name to the upstream model id for one unit.
 *
 * Precedence: a member's explicit `upstreamModel` (why one public name can be a
 * different upstream id per provider), then the strategy alias (the operator's
 * per-group override), then the provider's own `models` mapping, then identity.
 */
export function resolveUpstreamModel(
  strategy: LlmStrategy,
  provider: LlmProvider,
  publicModel: string,
  member?: LlmStrategyMember,
): string {
  if (member?.upstreamModel) return member.upstreamModel;

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

export interface CandidateUnits {
  /** Units this strategy can offer for `publicModel`, in member order. */
  units: PlannedUnit[];
  totalMembers: number;
  /** Members skipped because that member's own model is outside its window. */
  outsideWindow: number;
  /**
   * Members naming a different model (fallback routes), or generic members a
   * `modelProviders` pin excludes. Diagnostic only: a fallback route that is
   * open is part of the plan, not a skip reason.
   */
  otherModel: number;
  /** Members disabled directly or through their provider. */
  disabled: number;
}

/**
 * Expand a strategy into candidate units for one public model.
 *
 * Shared by the planner (which then drops the unavailable ones) and by the
 * gateway's availability probe, so the two can never disagree about what a
 * strategy is able to serve.
 */
export function candidateUnits(
  config: LlmConfig,
  strategy: LlmStrategy,
  publicModel: string,
  now: number = Date.now(),
): CandidateUnits {
  const units: PlannedUnit[] = [];
  const seen = new Set<string>();
  let totalMembers = 0;
  let outsideWindow = 0;
  let otherModel = 0;
  let disabled = 0;

  // Whether the group declares the requested model at all. A group is a pool of
  // models: a declared model may be served by any member, in the order the user
  // arranged them, so a closed or failing first choice falls through instead of
  // ending the turn (`hy4-preview` → `hy3`, 2026-10-29).
  //
  // A request naming something the group never heard of is a configuration
  // mistake, though, and quietly answering with an unrelated model would hide
  // it — and would let a fallback group silently substitute a whole different
  // model family.
  const declared = new Set<string>([
    ...Object.keys(strategy.modelAliases ?? {}),
    ...strategy.members.map((m) => m.model).filter((m): m is string => Boolean(m)),
  ])
  const fallThrough = declared.has(publicModel)

  for (const member of strategy.members) {
    totalMembers += 1;
    const provider = config.providers.find((p) => p.id === member.provider);
    if (!provider) {
      throw new Error(
        `Strategy "${strategy.id}" references unknown provider "${member.provider}"`,
      );
    }
    if (provider.enabled === false || member.enabled === false) {
      disabled += 1;
      continue;
    }

    // A member naming another model is a fallback route for that model, so its
    // *own* window decides whether it may be used — the requested model's
    // window must not gate a different model's route.
    const isFallbackRoute = Boolean(member.model) && member.model !== publicModel
    if (isFallbackRoute) {
      otherModel += 1;
      if (!fallThrough) continue
    }
    const unitModel = member.model ?? publicModel;

    // Legacy pinning: a model pinned to specific providers must not fall back
    // to a member that merely speaks the same upstream name. Members that name
    // their model carry the same information more precisely, so the older
    // `modelProviders` rule is only consulted for generic members.
    const pinned = strategy.modelProviders?.[unitModel];
    if (!member.model && pinned && !pinned.includes(member.provider)) {
      otherModel += 1;
      continue;
    }
    if (!windowAllows(provider.timeWindows?.[unitModel], now)) {
      outsideWindow += 1;
      continue;
    }

    const upstreamModel = resolveUpstreamModel(strategy, provider, unitModel, member);
    const id = unitId(provider.id, upstreamModel);
    // Two members naming the same route are one unit: the first position wins,
    // which is the order the user arranged.
    if (seen.has(id)) continue;
    seen.add(id);
    units.push({
      id,
      provider,
      publicModel: unitModel,
      upstreamModel,
      weight: member.weight ?? 1,
    });
  }

  // The requested model's routes are tried first; the group's other models
  // follow in the order the user arranged them. Stable sort, so within each
  // group the declared order is preserved.
  const ordered = [
    ...units.filter((unit) => unit.publicModel === publicModel),
    ...units.filter((unit) => unit.publicModel !== publicModel),
  ]
  return { units: ordered, totalMembers, outsideWindow, otherModel, disabled };
}

/**
 * Build the plan for one inbound request.
 *
 * Throws when the strategy cannot serve the model at all (config error) or
 * when every candidate unit is cooling (a limit wall, answered by the caller).
 */
export function planRequest(options: PlanOptions): Plan {
  const { config, strategy, publicModel, unavailableUnits = new Set() } = options;
  const candidates = candidateUnits(config, strategy, publicModel, options.now);

  if (candidates.units.length === 0) {
    const reason = candidates.totalMembers === 0
      ? 'it has no members'
      : candidates.disabled === candidates.totalMembers
        ? 'every member is disabled'
        : candidates.otherModel === candidates.totalMembers
          ? `no member serves "${publicModel}"`
          : candidates.outsideWindow > 0
            ? 'every model is outside its availability window'
            : `no member serves "${publicModel}"`;
    throw new Error(`Strategy "${strategy.id}" cannot serve "${publicModel}": ${reason}`);
  }

  const units = candidates.units.filter((unit) => !unavailableUnits.has(unit.id));
  if (units.length === 0) {
    throw new Error(
      `Strategy "${strategy.id}" has no usable unit for "${publicModel}" right now (all cooling or disabled)`,
    );
  }

  return {
    strategyId: strategy.id,
    units,
    retry: resolveRetryPolicy(strategy),
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
    if (member.model === publicModel) return true;
    const provider = config.providers.find((p) => p.id === member.provider);
    if (!provider) continue;
    const names = Object.values(provider.models ?? {});
    if (names.includes(publicModel)) return true;
  }
  return false;
}
