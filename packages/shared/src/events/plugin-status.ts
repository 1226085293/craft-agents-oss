/**
 * The plugin status light — one pure mapping shared by the plugin list (left
 * column) and the plugin detail page, so both columns can never disagree.
 *
 * Tones:
 *   off  — the user switched the plugin off. "I turned this off", never "it broke".
 *   bad  — red. Something blocks or broke: a manifest/IO error, the process
 *          gave up after its retry budget (failed), required config is still
 *          blank, or a dependency is missing/mismatched.
 *   warn — amber. In a transition or a soft anomaly: starting, up but
 *          unresponsive (degraded), enabled yet not running.
 *   ok   — green. Enabled and running with a healthy report.
 *
 * The input is deliberately structural (not the full DTO) so the list panel —
 * which loads without dependency probes — can compute the tones it knows, and
 * the detail panel — which has the probed dependency states — can compute the
 * full set. Same function, same wording, more facts available.
 */

import type { ListenerStatusDto } from '../protocol/dto.ts'

export type PluginStatusTone = 'ok' | 'warn' | 'bad' | 'off'

export interface PluginStatusInput {
  enabled: boolean
  status: Pick<ListenerStatusDto, 'state' | 'lastError'>
  /** Manifest / IO problems (missing manifest.json, bad JSON, …). */
  errors: string[]
  /** Required config keys the user has not filled in yet. */
  missingConfig: string[]
  /** Probed dependency states; absent (or empty) on the probe-free list view. */
  dependencies?: Array<{ state: 'ok' | 'missing' | 'mismatch' | 'unknown' | 'not_required' }>
}

export interface PluginStatusReading {
  tone: PluginStatusTone
  /** Human sentence for tooltips and aria-labels (color is never the only cue). */
  label: string
  /** Machine-readable cause, stable for tests and the UI. */
  reason:
    | 'disabled'
    | 'config-error'
    | 'failed'
    | 'missing-config'
    | 'missing-deps'
    | 'starting'
    | 'degraded'
    | 'stopped'
    | 'running'
}

const BLOCKING = new Set(['missing', 'mismatch'])

/**
 * Map the plugin's facts onto one light. Priority is deliberate:
 *
 *   disabled > hard errors (manifest, failed process) > required config >
 *   blocking dependencies > soft anomalies (starting/degraded/stopped) > running
 *
 * "Disabled" wins first because a plugin the user switched off must read as
 * gray no matter what its last runtime state was — an old amber from before
 * the switch would imply "still broken, go look".
 */
export function pluginStatusReading(input: PluginStatusInput): PluginStatusReading {
  const { enabled, status, errors, missingConfig, dependencies } = input

  if (!enabled) {
    return { tone: 'off', label: '已停用', reason: 'disabled' }
  }
  if (errors.length > 0) {
    return { tone: 'bad', label: `配置错误：${errors[0]}`, reason: 'config-error' }
  }
  if (status.state === 'failed') {
    return {
      tone: 'bad',
      label: status.lastError ? `启动失败：${status.lastError}` : '启动失败',
      reason: 'failed',
    }
  }
  if (missingConfig.length > 0) {
    return {
      tone: 'bad',
      label: `还缺 ${missingConfig.length} 项必选配置`,
      reason: 'missing-config',
    }
  }
  const blocking = (dependencies ?? []).filter((dep) => BLOCKING.has(dep.state)).length
  if (blocking > 0) {
    return { tone: 'bad', label: `${blocking} 项依赖未满足`, reason: 'missing-deps' }
  }
  if (status.state === 'starting') {
    return { tone: 'warn', label: '启动中', reason: 'starting' }
  }
  if (status.state === 'degraded') {
    return { tone: 'warn', label: '已启动，但未上报健康', reason: 'degraded' }
  }
  if (status.state === 'stopped') {
    return { tone: 'warn', label: '已启用，未运行', reason: 'stopped' }
  }
  return { tone: 'ok', label: '运行中', reason: 'running' }
}

// ---------------------------------------------------------------------------
// Config section — required values and the default open/closed state
// ---------------------------------------------------------------------------

export interface ListenerConfigSchemaLike {
  properties?: Record<string, { type?: 'string' | 'number' | 'boolean'; [key: string]: unknown }>
  required?: string[]
}

/**
 * Which required config keys still hold a blank value.
 *
 * Mirrors the server-side rule (undefined / null / empty string = missing),
 * so the detail page's "expand and highlight" decision and the save-time
 * validation agree with what the plugin process will actually see.
 */
export function missingRequiredConfigValues(
  schema: ListenerConfigSchemaLike | undefined,
  values: Record<string, unknown>,
): string[] {
  const required = schema?.required ?? []
  return required.filter((key) => {
    const value = values[key]
    if (value === undefined || value === null) return true
    return String(value).trim() === ''
  })
}

/**
 * The config block opens by default only when a required value is still blank
 * — that is the one case where hiding it would strand the user. When every
 * required value is filled, it stays collapsed: configuration a plugin already
 * has working is noise on first look.
 */
export function configSectionInitiallyOpen(
  schema: ListenerConfigSchemaLike | undefined,
  values: Record<string, unknown>,
): boolean {
  return missingRequiredConfigValues(schema, values).length > 0
}

/**
 * Clean a config update coming from a plugin's own HTML config UI.
 *
 * The plugin document runs in a sandboxed iframe and posts back plain values;
 * the host coerces them against the declared schema before anything reaches
 * the save path, so an HTML form can never write a key or a type the manifest
 * did not declare (and no object/array payload can smuggle in).
 */
export function sanitizePluginConfigUpdate(
  update: unknown,
  schema: ListenerConfigSchemaLike | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (typeof update !== 'object' || update === null) return out
  const props = schema?.properties ?? {}
  const hasSchema = Object.keys(props).length > 0
  for (const [key, raw] of Object.entries(update)) {
    const prop = props[key]
    if (!prop) {
      // Unknown key: only accepted when the schema declares no properties at
      // all (a plugin UI ahead of its manifest) — and then only primitives.
      if (hasSchema) continue
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        out[key] = raw
      }
      continue
    }
    if (prop.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) out[key] = n
    } else if (prop.type === 'boolean') {
      if (typeof raw === 'boolean') out[key] = raw
      else if (raw === 'true' || raw === 1 || raw === '1') out[key] = true
      else if (raw === 'false' || raw === 0 || raw === '0') out[key] = false
    } else {
      // string: accept real strings and primitive coercions, nothing else.
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        out[key] = String(raw)
      }
    }
  }
  return out
}
