/**
 * Spawn Session Tool (spawn_session)
 *
 * Shared callback type used by session-scoped tools.
 */

import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;
