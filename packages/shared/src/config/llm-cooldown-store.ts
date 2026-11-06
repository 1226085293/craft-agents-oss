/**
 * Persistent cooldown state for the LLM gateway.
 *
 * Cooldowns (rate-limit / quota / default failures) live in memory inside each
 * `KeyPool`'s `RateLimitState`, but they must survive an app restart: a key
 * that 429'd and was cooled for 30 days should not come back hot on the next
 * launch and immediately hammer the upstream again. This store snapshots the
 * cooldown map to disk, keyed by `${providerId}::${keyId}` (empty keyId = a
 * keyless provider), with an absolute expiry so stale entries self-invalidate
 * on load.
 *
 * Same data dir and resilience contract as `llm-usage-store`: writes are
 * best-effort and must never take down a request path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR } from './paths.ts';

export const COOLDOWN_FILENAME = 'llm-cooldowns.json';

function configDir(): string {
  return process.env.CRAFT_CONFIG_DIR || CONFIG_DIR;
}

function cooldownPath(): string {
  return join(configDir(), COOLDOWN_FILENAME);
}

/** Compose the persisted key for one provider key (`''` = keyless provider). */
export function cooldownKey(providerId: string, keyId: string): string {
  return `${providerId}::${keyId}`;
}

/**
 * Prefix for a `key + model` quota cooldown.
 *
 * The tuple is JSON-encoded because both key ids and model names may contain
 * `::`; the prefix keeps these entries out of the provider::key parser.
 */
export const MODEL_COOLDOWN_PREFIX = '@model:';

export function modelCooldownKey(
  providerId: string,
  keyId: string,
  model: string,
): string {
  return `${MODEL_COOLDOWN_PREFIX}${JSON.stringify([providerId, keyId, model])}`;
}

/** Parse a persisted `key + model` cooldown key; null for every other entry. */
export function parseModelCooldownKey(
  key: string,
): { providerId: string; keyId: string; model: string } | null {
  if (!key.startsWith(MODEL_COOLDOWN_PREFIX)) return null;
  try {
    const parsed = JSON.parse(key.slice(MODEL_COOLDOWN_PREFIX.length)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [providerId, keyId, model] = parsed;
    if (typeof providerId !== 'string' || typeof keyId !== 'string' || typeof model !== 'string') return null;
    return { providerId, keyId, model };
  } catch {
    return null;
  }
}

/** Read the full cooldown snapshot: persisted key -> epoch-seconds until expiry. */
export function loadCooldowns(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(cooldownPath(), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // Missing or corrupt file: start empty.
  }
  return {};
}

/** Atomically write the full cooldown snapshot. Never throws. */
export function saveCooldowns(map: Record<string, number>): void {
  try {
    if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
    const tmp = `${cooldownPath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    renameSync(tmp, cooldownPath());
  } catch {
    // Persistence is best-effort; a failed write must not fail the request.
  }
}
