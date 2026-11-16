/**
 * The plugin status light — one pure mapping behind the plugin detail page's
 * status light, plus the config-section helpers used by the same page.
 *
 * Tones (theme tokens, never raw colors):
 *   bad  — red (--destructive). Something blocks or broke: a manifest/IO
 *          error, the process gave up after its retry budget (failed),
 *          required config is still blank, or a dependency is
 *          missing/mismatched.
 *   warn — amber (--info). In a transition or alive but not complete:
 *          starting, up but unresponsive (degraded), running but not ready
 *          (未授权), or the plugin's own control service rejected the token.
 *   off  — gray (--muted-foreground). Stopped or the user switched it off —
 *          "not running", never "it broke".
 *   ok   — green (--success). Running and ready.
 *
 * Priority (T-8): 红 > 黄 > 灰 > 绿 — hard failures and missing facts
 * report red first, even when the plugin is stopped or the user disabled it
 * (缺了先报红). Within the amber tier the order is deterministic:
 * starting → degraded → not-ready → unauthorized.
 *
 * The input is deliberately structural (not the full DTO): a caller passes the
 * facts it holds and the mapping skips the rest, so an absent optional field
 * never turns into a failure reading.
 */

import type { ListenerStatusDto } from '../protocol/dto.ts'

export type PluginStatusTone = 'ok' | 'warn' | 'bad' | 'off'

export interface PluginStatusInput {
  enabled: boolean
  /** Process state; `state` may be missing (not reported yet) → gray. */
  status: Pick<ListenerStatusDto, 'state' | 'lastError'>
  /** Manifest / IO problems (missing manifest.json, bad JSON, …). */
  errors: string[]
  /** Required config keys the user has not filled in yet. */
  missingConfig: string[]
  /** Probed dependency states; absent (or empty) on the probe-free list view. */
  dependencies?: Array<{ state: 'ok' | 'missing' | 'mismatch' | 'unknown' | 'not_required' }>
  /**
   * On-disk readiness (manifest declares a runtime && no blocking
   * dependency). false while the process runs = started but 未授权 / not
   * ready. Absent is treated as ready, so older payloads keep reading
   * green when running.
   */
  ready?: boolean
  /** The plugin's own control service rejected the token (401 / unauthorized). */
  unauthorized?: boolean
}

export interface PluginStatusReading {
  tone: PluginStatusTone
  /** Human sentence for tooltips and aria-labels (color is never the only cue). */
  label: string
  /** Machine-readable cause, stable for tests and the UI. */
  reason:
    | 'config-error'
    | 'failed'
    | 'missing-config'
    | 'missing-deps'
    | 'starting'
    | 'needs-auth'
    | 'degraded'
    | 'not-ready'
    | 'unauthorized'
    | 'disabled'
    | 'stopped'
    | 'running'
}

const BLOCKING = new Set(['missing', 'mismatch'])

/**
 * Map the plugin's facts onto one light. Priority is deliberate (T-8):
 *
 *   red:    manifest/IO errors, failed process, required config still
 *           blank, blocking dependency — 缺了先报红, even when the plugin
 *           is stopped or the user disabled it
 *   yellow: starting → degraded → not-ready (running + ready=false) →
 *           unauthorized (control service rejected the token)
 *   gray:   disabled, stopped, or no state reported yet
 *   green:  running and ready
 *
 * Note the departure from the earlier "disabled wins first" draft: T-8
 * requires a hard failure to keep reading red even after the user switched
 * the plugin off — the break is the fact that needs attention.
 */
export function pluginStatusReading(input: PluginStatusInput): PluginStatusReading {
  const { enabled, status, errors, missingConfig, dependencies, ready, unauthorized } = input
  const state = status.state
  const blocking = (dependencies ?? []).filter((dep) => BLOCKING.has(dep.state)).length

  // Red — hard failures and missing facts report first.
  if (errors.length > 0) {
    return { tone: 'bad', label: `配置错误：${errors[0]}`, reason: 'config-error' }
  }
  if (state === 'failed') {
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
  if (blocking > 0) {
    return { tone: 'bad', label: `${blocking} 项依赖未满足`, reason: 'missing-deps' }
  }

  // Yellow — transitions and "alive but not done" (deterministic order).
  if (state === 'starting') {
    return { tone: 'warn', label: '启动中', reason: 'starting' }
  }
  if (state === 'degraded') {
    return { tone: 'warn', label: '已启动，但未上报健康', reason: 'degraded' }
  }
  if (state === 'running' && ready === false) {
    return { tone: 'warn', label: '未就绪', reason: 'not-ready' }
  }
  if (unauthorized === true) {
    return { tone: 'warn', label: '未授权', reason: 'unauthorized' }
  }

  // Gray — off, or up-but-not-running (including a missing state report).
  if (!enabled) {
    return { tone: 'off', label: '已停用', reason: 'disabled' }
  }
  if (state === 'stopped' || state == null) {
    return { tone: 'off', label: '未启动', reason: 'stopped' }
  }

  // Green — running and ready (absent ready counts as ready).
  return { tone: 'ok', label: '运行中', reason: 'running' }
}

/**
 * Did the plugin's own control service reject Craft's token? The control
 * service is optional and plugin-owned (listener-reported dependencies); a
 * 401 / unauthorized answer means the plugin is up but 未授权 — the light
 * reads amber, not green. Accepts the DTO's `controlDeps` object (the
 * `reason` field is present when the fetch failed) or null/undefined.
 */
export function controlDepsUnauthorized(controlDeps?: { reason?: string } | null): boolean {
  const reason = controlDeps?.reason
  if (!reason) return false
  return /401|unauthorized/i.test(reason)
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

