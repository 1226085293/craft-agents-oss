/**
 * Which model a strategy group routes with, and which of its models can serve
 * right now.
 *
 * This is one rule with three readers, and they used to drift apart:
 *
 * - the session router (`resolveStrategyRoute`), which decides the model a
 *   request is sent with,
 * - the gateway's status projection, which the composer's picker reads,
 * - the composer's own label, which predicts the *next* request's model.
 *
 * Drift is not cosmetic. 2026-10-29 (`261029-snug-raven`): the group declared
 * `hy4-preview` (23:00–08:00) then `hy3` (all day); the router took the first
 * model without looking at the clock, so every request between 08:00 and 23:00
 * died with `no healthy account` while half the group was wide open — and the
 * composer, reading the last *successful* route, showed `hy3`, a model the next
 * request was never going to use.
 *
 * Pure and clock-free like `model-window.ts`: `now` is always passed in.
 */

import { windowAllows, type ModelWindow } from './model-window.ts'

/** A group member, as far as availability is concerned. */
export interface AvailabilityMember {
  provider: string
  /** The model this member serves. Absent means "whatever the provider maps". */
  model?: string
  enabled?: boolean
}

/** The parts of a strategy that decide availability. */
export interface AvailabilityStrategy {
  members?: ReadonlyArray<AvailabilityMember>
  /**
   * Legacy pinning: a public model restricted to specific providers. Only
   * consulted for members that do not name their own model, exactly as the
   * planner does.
   */
  modelProviders?: Record<string, string[]>
}

/** The parts of a provider that decide availability. */
export interface AvailabilityProvider {
  id: string
  enabled?: boolean
  /** Per-model availability windows, keyed by the public model name. */
  timeWindows?: Record<string, ModelWindow>
}

/**
 * Whether at least one member of `strategy` can serve `model` right now.
 *
 * A member that names another model is a fallback route for *that* model, so
 * the window consulted is the member's own model — never the requested one.
 * That distinction is what makes `hy4-preview` falling through to `hy3` a
 * routing decision instead of a client-side error.
 */
export function modelHasOpenRoute(
  strategy: AvailabilityStrategy,
  providers: ReadonlyArray<AvailabilityProvider>,
  model: string,
  now: number,
): boolean {
  return (strategy.members ?? []).some((member) => {
    if (member.enabled === false) return false
    if (member.model && member.model !== model) return false
    const provider = providers.find((p) => p.id === member.provider)
    if (!provider || provider.enabled === false) return false
    // Legacy pin, same rule the planner applies: a generic member excluded by
    // `modelProviders` is not a route for this model either, and counting it
    // here would make the router pick a model the planner then throws away.
    const pinned = strategy.modelProviders?.[model]
    if (!member.model && pinned && !pinned.includes(member.provider)) return false
    return windowAllows(provider.timeWindows?.[model], now)
  })
}

/**
 * The `models` that can be served right now, in declared order.
 *
 * An empty result with a non-empty `models` means "configured, but every model
 * is outside its availability window" — the state the composer must show as
 * unavailable instead of naming a model that will fail.
 */
export function openStrategyModels(
  strategy: AvailabilityStrategy,
  models: readonly string[],
  providers: ReadonlyArray<AvailabilityProvider>,
  now: number,
): string[] {
  return models.filter((model) => modelHasOpenRoute(strategy, providers, model, now))
}

/**
 * The model a route should use.
 *
 * The session's own model wins *when it is open* — an explicit pick is honoured
 * whenever it can actually be served. Otherwise the first open model in the
 * declared order, which is the order the user arranged the group in.
 *
 * With no availability information (no providers, no members) the declared
 * order is all there is, and that is what an older config gets.
 */
export function pickStrategyModel(
  strategy: AvailabilityStrategy,
  models: readonly string[],
  providers: ReadonlyArray<AvailabilityProvider> | undefined,
  resolvedModel: string | undefined,
  now: number,
): string {
  if (providers && providers.length > 0 && strategy.members?.length) {
    const open = openStrategyModels(strategy, models, providers, now)
    if (resolvedModel && open.includes(resolvedModel)) return resolvedModel
    // `open` is never empty when nothing has a window: an absent window allows.
    if (open.length > 0) return open[0]!
  }
  if (resolvedModel && models.includes(resolvedModel)) return resolvedModel
  return models[0]!
}
