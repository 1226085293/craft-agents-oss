/**
 * Pure browser-safe memory helpers.
 *
 * These functions have NO node dependencies (no fs/path/interprocess), so
 * they can be re-exported through `./browser.ts` and bundled into the
 * Electron renderer (vite) without pulling the server-side IO modules
 * (store.ts / session-store.ts → node:fs) into client code.
 *
 * Single source of truth: the implementations LIVE here; `injector.ts`
 * re-exports them so the server-side API surface stays unchanged.
 */
import { memoryConfig } from './types.ts';

/**
 *  recency multiplier based on lastInjectedAt ?? createdAt (§5.3):
 * <2d→1.0 (anti self-reinforcement), 2–7d→1.5, 7–30d→1.2, 30–90d→1.0,
 * 90–180d→0.6, >180d→0.4 (cold is derived: UI badge + 0.4×, never evicted).
 */
export function recencyMultiplier(lastInjectedAt: string | null | undefined, createdAt: string): number {
  const base = lastInjectedAt ?? createdAt;
  const days = (Date.now() - new Date(base).getTime()) / (1000 * 60 * 60 * 24);
  if (days < 2) return 1.0;
  if (days < 7) return 1.5;
  if (days < 30) return 1.2;
  if (days < 90) return 1.0;
  if (days < 180) return 0.6;
  return 0.4;
}

/** echo of cold flag for UI/debug: >coldDays since last active. */
export function isColdMemory(lastInjectedAt: string | null | undefined, createdAt: string): boolean {
  const base = lastInjectedAt ?? createdAt;
  const days = (Date.now() - new Date(base).getTime()) / (1000 * 60 * 60 * 24);
  return days > memoryConfig.decay.coldDays;
}