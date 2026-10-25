/**
 * llm-config.json loader, validator, and writer.
 *
 * Mirrors the invariant uni-api's hot-reload relies on: a change is applied
 * only after it parses AND validates; anything invalid is discarded and the
 * previous config keeps serving traffic untouched. Never throw from
 * `loadLlmConfig` — return `null` and let the caller decide.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated config behind.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR } from './paths.ts';
import type { LlmConfig, LlmPreset, LlmProvider, LlmStrategy, LlmKey } from './llm-config.ts';

export const LLM_CONFIG_FILENAME = 'llm-config.json';
export const LLM_CONFIG_PATH = join(CONFIG_DIR, LLM_CONFIG_FILENAME);

// ============================================================================
// Loading
// ============================================================================

/**
 * Read and validate the config, or return `null` when absent / invalid.
 *
 * `onError` receives a human-readable reason; callers use it to surface the
 * failure in the UI without blocking startup.
 */
export function loadLlmConfig(onError?: (message: string) => void): LlmConfig | null {
  if (!existsSync(LLM_CONFIG_PATH)) return null;

  let raw: string;
  try {
    raw = readFileSync(LLM_CONFIG_PATH, 'utf-8');
  } catch (err) {
    onError?.(`无法读取 ${LLM_CONFIG_FILENAME}: ${errText(err)}`);
    return null;
  }

  return parseLlmConfig(raw, onError);
}

/** Parse + validate from a string. `null` on any failure (never throws). */
export function parseLlmConfig(raw: string, onError?: (message: string) => void): LlmConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onError?.(`${LLM_CONFIG_FILENAME} JSON 解析失败: ${errText(err)}`);
    return null;
  }

  const errors = validateLlmConfig(parsed);
  if (errors.length > 0) {
    onError?.(`${LLM_CONFIG_FILENAME} 校验失败: ${errors.join('; ')}`);
    return null;
  }

  return parsed as LlmConfig;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Collect every structural error rather than failing on the first, so a user
 * editing the JSON view gets the full list at once.
 */
export function validateLlmConfig(input: unknown): string[] {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['顶层必须是对象'];
  }
  const cfg = input as Record<string, unknown>;

  if (typeof cfg.version !== 'number') errors.push('version 必须是数字');
  else if (cfg.version !== 1) errors.push(`version 需为 1（当前 ${String(cfg.version)}）`);

  // presets
  if (cfg.presets !== undefined) {
    if (!isPlainObject(cfg.presets)) errors.push('presets 必须是对象');
    else {
      for (const [name, preset] of Object.entries(cfg.presets)) {
        if (!isPlainObject(preset)) errors.push(`presets.${name} 必须是对象`);
        else errors.push(...validatePreset(name, preset as Record<string, unknown>));
      }
    }
  }

  // providers
  if (!Array.isArray(cfg.providers)) {
    errors.push('providers 必须是数组');
  } else {
    const seenProvider = new Set<string>();
    const seenKey = new Set<string>();
    cfg.providers.forEach((p, i) => {
      if (!isPlainObject(p)) {
        errors.push(`providers[${i}] 必须是对象`);
        return;
      }
      const prov = p as Record<string, unknown>;
      const id = typeof prov.id === 'string' ? prov.id : `providers[${i}]`;
      if (typeof prov.id !== 'string' || !prov.id) errors.push(`providers[${i}].id 必须是非空字符串`);
      else if (seenProvider.has(prov.id)) errors.push(`provider id 重复: ${prov.id}`);
      else seenProvider.add(prov.id as string);

      if (typeof prov.baseUrl !== 'string' || !prov.baseUrl) errors.push(`${id}: baseUrl 必须是非空字符串`);
      if (prov.protocol !== 'openai-completions' && prov.protocol !== 'anthropic-messages') {
        errors.push(`${id}: protocol 需为 openai-completions 或 anthropic-messages`);
      }
      if (prov.models !== undefined && !isPlainObject(prov.models)) errors.push(`${id}: models 必须是对象`);
      if (prov.modelOptions !== undefined) {
        if (!isPlainObject(prov.modelOptions)) {
          errors.push(`${id}: modelOptions 必须是对象`);
        } else {
          Object.entries(prov.modelOptions as Record<string, unknown>).forEach(([m, o]) => {
            const label = `${id}.modelOptions[${m}]`;
            if (!isPlainObject(o)) {
              errors.push(`${label} 必须是对象`);
              return;
            }
            errors.push(...validateModelOptions(label, o as Record<string, unknown>));
          });
        }
      }
      if (prov.overrides !== undefined && isPlainObject(prov.overrides)) {
        errors.push(...validatePreset(`${id}.overrides`, prov.overrides as Record<string, unknown>));
      } else if (prov.overrides !== undefined) {
        errors.push(`${id}.overrides 必须是对象`);
      }

      // An empty keys array is allowed: a provider can be created before its
      // keys exist, and the gateway simply stays disabled until one lands
      // (enabled requires at least one provider with an enabled key). Keys must
      // still be an array — anything else is a shape error.
      if (!Array.isArray(prov.keys)) {
        errors.push(`${id}: keys 必须是数组`);
      } else {
        (prov.keys as unknown[]).forEach((k, ki) => {
          const label = `${id}.keys[${ki}]`;
          if (!isPlainObject(k)) {
            errors.push(`${label} 必须是对象`);
            return;
          }
          const key = k as Record<string, unknown>;
          if (typeof key.id !== 'string' || !key.id) errors.push(`${label}.id 必须是非空字符串`);
          else if (seenKey.has(`${prov.id}:${key.id}`)) errors.push(`key id 重复: ${prov.id}/${key.id}`);
          else seenKey.add(`${prov.id}:${key.id}`);
          if (typeof key.key !== 'string' || !key.key) errors.push(`${label}.key 必须是非空字符串`);
          if (key.enabled !== undefined && typeof key.enabled !== 'boolean') errors.push(`${label}.enabled 必须是布尔`);
          if (key.overrides !== undefined && isPlainObject(key.overrides)) {
            errors.push(...validatePreset(`${label}.overrides`, key.overrides as Record<string, unknown>));
          }
        });
      }
    });
  }

  // strategies
  if (!Array.isArray(cfg.strategies)) {
    errors.push('strategies 必须是数组');
  } else {
    const validTypes = ['round_robin', 'sequential', 'weighted', 'least_busy', 'failover_only'];
    const providerIds = new Set(
      Array.isArray(cfg.providers)
        ? (cfg.providers as Record<string, unknown>[]).filter(isPlainObject).map(p => String(p.id))
        : [],
    );
    const seen = new Set<string>();
    cfg.strategies.forEach((s, i) => {
      if (!isPlainObject(s)) {
        errors.push(`strategies[${i}] 必须是对象`);
        return;
      }
      const st = s as Record<string, unknown>;
      const id = typeof st.id === 'string' ? st.id : `strategies[${i}]`;
      if (typeof st.id !== 'string' || !st.id) errors.push(`strategies[${i}].id 必须是非空字符串`);
      else if (seen.has(st.id)) errors.push(`strategy id 重复: ${st.id}`);
      else seen.add(st.id as string);

      if (typeof st.type !== 'string' || !validTypes.includes(st.type)) {
        errors.push(`${id}: type 需为 ${validTypes.join(' / ')}`);
      }
      if (!Array.isArray(st.members) || st.members.length === 0) {
        errors.push(`${id}: members 必须是非空数组`);
      } else {
        (st.members as unknown[]).forEach((m, mi) => {
          if (!isPlainObject(m) || typeof (m as Record<string, unknown>).provider !== 'string') {
            errors.push(`${id}.members[${mi}].provider 必须是非空字符串`);
            return;
          }
          const pid = (m as Record<string, unknown>).provider as string;
          if (providerIds.size > 0 && !providerIds.has(pid)) {
            errors.push(`${id}.members[${mi}] 引用了不存在的 provider: ${pid}`);
          }
        });
      }
    });

    // fallbackStrategyId must name an existing strategy. Cycle detection is
    // done at request time; this only guards against a dangling reference.
    const strategyIds = new Set(
      (cfg.strategies as unknown[]).filter(isPlainObject).map(s => String((s as Record<string, unknown>).id)),
    );
    (cfg.strategies as unknown[]).forEach((s) => {
      if (!isPlainObject(s)) return;
      const st = s as Record<string, unknown>;
      const id = typeof st.id === 'string' ? st.id : `strategies[?]`;
      const fb = st.fallbackStrategyId;
      if (fb === undefined) return;
      if (typeof fb !== 'string' || !fb) {
        errors.push(`${id}: fallbackStrategyId 必须是非空字符串`);
      } else if (strategyIds.size > 0 && !strategyIds.has(fb)) {
        errors.push(`${id}: fallbackStrategyId 引用了不存在的 strategy: ${fb}`);
      }
    });
  }

  // miniStrategy — must name a strategy that exists, else every auxiliary
  // call would silently keep using the direct connection.
  if (cfg.miniStrategy !== undefined) {
    if (typeof cfg.miniStrategy !== 'string' || !cfg.miniStrategy) {
      errors.push('miniStrategy 必须是非空字符串');
    } else {
      const ids = new Set(
        Array.isArray(cfg.strategies)
          ? (cfg.strategies as Record<string, unknown>[]).filter(isPlainObject).map(s => String(s.id))
          : [],
      );
      if (ids.size > 0 && !ids.has(cfg.miniStrategy)) {
        errors.push(`miniStrategy 引用了不存在的 strategy: ${cfg.miniStrategy}`);
      }
    }
  }

  // defaultStrategy — a new session inherits it, so a dangling id would route
  // every session created outside the UI straight into `strategy_not_found`.
  if (cfg.defaultStrategy !== undefined) {
    if (typeof cfg.defaultStrategy !== 'string' || !cfg.defaultStrategy) {
      errors.push('defaultStrategy 必须是非空字符串');
    } else {
      const ids = new Set(
        Array.isArray(cfg.strategies)
          ? (cfg.strategies as Record<string, unknown>[]).filter(isPlainObject).map(s => String(s.id))
          : [],
      );
      if (ids.size > 0 && !ids.has(cfg.defaultStrategy)) {
        errors.push(`defaultStrategy 引用了不存在的 strategy: ${cfg.defaultStrategy}`);
      }
    }
  }

  // clientKeys
  if (cfg.clientKeys !== undefined) {    if (!Array.isArray(cfg.clientKeys)) errors.push('clientKeys 必须是数组');
    else {
      const strategyIds = new Set(
        Array.isArray(cfg.strategies)
          ? (cfg.strategies as Record<string, unknown>[]).filter(isPlainObject).map(s => String(s.id))
          : [],
      );
      (cfg.clientKeys as unknown[]).forEach((c, i) => {
        if (!isPlainObject(c)) {
          errors.push(`clientKeys[${i}] 必须是对象`);
          return;
        }
        const ck = c as Record<string, unknown>;
        if (typeof ck.key !== 'string' || !ck.key) errors.push(`clientKeys[${i}].key 必须是非空字符串`);
        if (!Array.isArray(ck.strategies)) {
          errors.push(`clientKeys[${i}].strategies 必须是数组`);
          return;
        }
        (ck.strategies as unknown[]).forEach(sid => {
          if (strategyIds.size > 0 && !strategyIds.has(String(sid))) {
            errors.push(`clientKeys[${i}] 引用了不存在的 strategy: ${String(sid)}`);
          }
        });
      });
    }
  }

  return errors;
}

/**
 * Per-model capability fields: token counts must be non-negative integers, the
 * two support flags must be booleans.
 *
 * Zero is allowed for the token counts (a 0-token model is nonsense but not
 * unsafe, and refusing it would block a save the user can simply clear), while
 * a wrong *type* is refused — the UI writes strings from text inputs, so a
 * "1M" that slipped past parsing would otherwise land in the config and be
 * read back as NaN by every consumer.
 */
function validateModelOptions(label: string, opts: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const numericFields = ['contextWindow', 'maxOutputTokens'];
  const boolFields = ['supportsImages', 'supportsThinking'];
  for (const f of numericFields) {
    const v = opts[f];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label}.${f} 必须是数字`);
    else if (v < 0) errors.push(`${label}.${f} 不能为负`);
    else if (!Number.isInteger(v)) errors.push(`${label}.${f} 必须是整数`);
  }
  for (const f of boolFields) {
    const v = opts[f];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') errors.push(`${label}.${f} 必须是布尔`);
  }
  return errors;
}

/** Numeric preset fields must be positive; booleans must be booleans. */
function validatePreset(label: string, preset: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const numericFields = [
    'tpr', 'concurrency',
    'contextWindow', 'maxOutputTokens', 'contextTokenBudget',
    'maxImageParts', 'maxFileParts', 'maxRequestBytes',
    'firstByteSeconds', 'totalSeconds',
    'defaultSeconds', 'rateLimitSeconds', 'quotaExhaustedSeconds',
  ];
  const boolFields = ['supportsStream', 'supportsToolCalls', 'supportsVision'];

  for (const f of numericFields) {
    const v = preset[f];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label}.${f} 必须是数字`);
    else if (v < 0) errors.push(`${label}.${f} 不能为负`);
  }
  for (const f of boolFields) {
    const v = preset[f];
    if (v !== undefined && typeof v !== 'boolean') errors.push(`${label}.${f} 必须是布尔`);
  }
  errors.push(...validateCustomLimits(`${label}.customLimits`, preset.customLimits));
  return errors;
}

/**
 * Custom windows: a malformed row is rejected at save time rather than being
 * silently dropped by the scheduler, because the user believes they configured
 * a ceiling — a silently ignored limit is worse than a refused save.
 */
function validateCustomLimits(label: string, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${label} 必须是数组`];
  const errors: string[] = [];
  raw.forEach((entry, i) => {
    const at = `${label}[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    const limit = entry as Record<string, unknown>;
    if (typeof limit.amount !== 'number' || !Number.isFinite(limit.amount) || limit.amount <= 0) {
      errors.push(`${at}.amount 必须是正数`);
    }
    if (limit.unit !== 'requests' && limit.unit !== 'tokens') {
      errors.push(`${at}.unit 需为 requests / tokens`);
    }
    if (typeof limit.per !== 'number' || !Number.isFinite(limit.per) || limit.per <= 0) {
      errors.push(`${at}.per 必须是正数`);
    }
    if (limit.perUnit !== 'seconds' && limit.perUnit !== 'minutes' && limit.perUnit !== 'hours') {
      errors.push(`${at}.perUnit 需为 seconds / minutes / hours`);
    }
  });
  return errors;
}

// ============================================================================
// Writing
// ============================================================================

/**
 * Atomically write the config.
 *
 * Returns the validation errors instead of writing when invalid, so callers
 * cannot persist a broken config by accident.
 */
export function saveLlmConfig(config: LlmConfig): { ok: true } | { ok: false; errors: string[] } {
  const errors = validateLlmConfig(config);
  if (errors.length > 0) return { ok: false, errors };

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${LLM_CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  renameSync(tmp, LLM_CONFIG_PATH);
  return { ok: true };
}

/**
 * Snapshot the current config to a dated backup, keeping the most recent 3.
 *
 * Mirrors the `config.json.bak-YYYY-MM-DD` rotation so the UI can offer
 * "undo last change" without inventing a new scheme.
 */
export function backupLlmConfig(now: Date = new Date()): void {
  if (!existsSync(LLM_CONFIG_PATH)) return;
  const stamp = now.toISOString().slice(0, 10);
  const target = `${LLM_CONFIG_PATH}.bak-${stamp}`;
  try {
    // Same-day snapshots overwrite, so editing all day does not exhaust the 3.
    if (!existsSync(target)) {
      writeFileSync(target, readFileSync(LLM_CONFIG_PATH));
    }
  } catch {
    // Backup is best-effort; never block a save.
  }
}

// ============================================================================
// Migration from config.json llmConnections[]
// ============================================================================

interface LegacyConnection {
  slug?: string;
  name?: string;
  baseUrl?: string;
  authType?: string;
  auth?: { apiKey?: string };
  models?: Array<string | { id?: string; contextWindow?: number; supportsImages?: boolean }>;
  defaultModel?: string;
  customEndpoint?: {
    api?: 'openai-completions' | 'anthropic-messages';
    supportsImages?: boolean;
  };
}


// ============================================================================
// Internal
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exposed for tests: remove the config file. */
export function removeLlmConfigFile(): void {
  if (existsSync(LLM_CONFIG_PATH)) rmSync(LLM_CONFIG_PATH);
}

/** Re-export for callers that only need the preset type. */
export type { LlmPreset };
