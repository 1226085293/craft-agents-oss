/**
 * Strategy group enumeration.
 *
 * The resolver needs "the first enabled group" as its last tier. That used to
 * be a literal field (`LlmConfig.defaultStrategy`); deriving it keeps working
 * for callers with no settings page while removing the duplicate source.
 */

import type { LlmConfig, LlmStrategy } from './llm-config.ts';

/**
 * Enabled strategy ids in declared order.
 *
 * A strategy counts as enabled unless it is explicitly disabled. Disabled ones
 * are excluded so the "first enabled" tier can never resolve to a group the
 * gateway would refuse to route.
 */
export function listEnabledStrategyIds(config: LlmConfig | null | undefined): string[] {
  if (!config?.strategies?.length) return [];
  return config.strategies
    .filter((strategy: LlmStrategy) => strategy && strategy.id && (strategy as { enabled?: boolean }).enabled !== false)
    .map((strategy) => strategy.id);
}
