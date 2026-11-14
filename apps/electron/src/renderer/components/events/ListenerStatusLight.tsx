/**
 * The plugin status light — one mapping (pluginStatusReading, shared) behind
 * both the plugin list cards and the detail page title bar, so the two
 * columns can never disagree about what is wrong with a plugin.
 *
 * Tone → theme token (no raw colors in components):
 *   ok   → --success (running + ready)
 *   warn → --info    (starting / unresponsive / unauthorized / running-but-not-ready)
 *   bad  → --destructive (manifest error, failed process, missing config or deps)
 *   off  → --muted-foreground (gray: the user switched it off — "I turned
 *           this off", never "it broke" — or enabled but simply not running)
 *
 * The dot is never the only cue: every instance carries a title + aria-label,
 * and the detail page prints the sentence next to the dot.
 */

import * as React from 'react'
import {
  controlDepsUnauthorized,
  pluginStatusReading,
  type PluginStatusTone,
} from '@craft-agent/shared/events/plugin-status'
import type { ListenerDto } from '@craft-agent/shared/protocol/dto'

const TONE_DOT: Record<PluginStatusTone, string> = {
  ok: 'bg-success',
  warn: 'bg-info',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/60',
}

const TONE_LABEL: Record<PluginStatusTone, string> = {
  ok: 'text-foreground/70',
  warn: 'text-muted-foreground',
  bad: 'text-destructive',
  off: 'text-muted-foreground/70',
}

export function ListenerStatusLight({
  listener,
  size = 'sm',
  showLabel = false,
  className = '',
}: {
  listener: ListenerDto
  size?: 'sm' | 'md'
  showLabel?: boolean
  className?: string
}): React.ReactElement {
  // The list view loads without dependency probes, so its dependencies array
  // is empty, `ready` reflects runtime-only, and controlDeps is absent — the
  // mapping simply skips facts that view does not carry. The detail view, which
  // has the probed states, computes the full reading from the same function.
  const reading = pluginStatusReading({
    enabled: listener.enabled,
    status: listener.status,
    errors: listener.errors,
    missingConfig: listener.missingConfig,
    dependencies: listener.dependencies,
    ready: listener.ready,
    unauthorized: controlDepsUnauthorized(listener.controlDeps),
  })
  const dot = `rounded-full shrink-0 ${size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2'} ${TONE_DOT[reading.tone]}`

  if (!showLabel) {
    return (
      <span
        className={`${dot} ${className}`}
        title={reading.label}
        aria-label={reading.label}
        role="status"
      />
    )
  }
  return (
    <span className={`inline-flex items-center gap-1.5 shrink-0 ${className}`}>
      <span className={dot} aria-hidden />
      <span className={`text-[11px] ${TONE_LABEL[reading.tone]}`}>{reading.label}</span>
    </span>
  )
}
