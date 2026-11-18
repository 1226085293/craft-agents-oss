/**
 * H2 compile table: permission mode → which plugin actions are offered.
 *
 * The three rules, fixed in v7 and implemented here as one pure function so
 * there is exactly one place to read them:
 *
 * 1. **探索 (safe)** — read and reply only. Writes are withheld.
 * 2. **询问 (ask)** — everything, but `write` actions go through the
 *    confirmation gate before they run (the gate is a separate mechanism; this
 *    table decides what is *offered*, the gate decides what is *allowed*).
 * 3. **执行 (allow-all)** — everything.
 *
 * `reply` is available in every mode, and that is deliberate. Whether a channel
 * should answer at all is the judge's question, bounded by the daily limit. If
 * the mode gate also muted replies, an exploration-mode group bot would read a
 * request and say nothing — indistinguishable from a broken bot, and the person
 * has no way to learn why.
 */

import { resolveActionEffect, type PluginAction } from './manifest.ts';

export type ActionEffect = 'read' | 'write' | 'reply';
export type SessionMode = 'safe' | 'ask' | 'allow-all';

/** Which effect classes a mode may offer. */
const OFFERED_EFFECTS: Record<SessionMode, ReadonlySet<ActionEffect>> = {
  // 探索: look, and answer — never change.
  safe: new Set<ActionEffect>(['read', 'reply']),
  // 询问: offer writes too; the confirmation gate decides each one.
  ask: new Set<ActionEffect>(['read', 'write', 'reply']),
  // 执行: everything.
  'allow-all': new Set<ActionEffect>(['read', 'write', 'reply']),
};

/** True when this mode may offer this effect class at all. */
export function isEffectOffered(mode: SessionMode, effect: ActionEffect): boolean {
  return OFFERED_EFFECTS[mode].has(effect);
}

/**
 * Filter a plugin's actions down to what the mode may offer.
 *
 * Returns the actions that survive, so callers assemble tools from the result
 * rather than filtering ad hoc at each site — an ad-hoc filter is how one code
 * path keeps offering a write action the mode removed.
 */
export function filterActionsByMode<T extends Pick<PluginAction, 'effect' | 'repliesToOrigin'>>(
  actions: readonly T[],
  mode: SessionMode,
): T[] {
  return actions.filter((action) => isEffectOffered(mode, resolveActionEffect(action)));
}

/**
 * Does a `write` action need the confirmation gate in this mode?
 *
 * Only `ask`. Exploration never offers the action at all, so there is nothing
 * to confirm; execution has already decided.
 */
export function needsConfirmation(mode: SessionMode, effect: ActionEffect): boolean {
  return mode === 'ask' && effect === 'write';
}
