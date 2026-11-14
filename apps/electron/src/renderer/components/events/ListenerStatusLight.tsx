/**
 * The plugin status light — the detail page's reading of a plugin
 * (pluginStatusReading, shared), drawn in its title bar and on the process log
 * tab. The plugin list deliberately draws no light: a card carries the name,
 * version, description, enabled chip and manifest errors instead.
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
  // The detail view carries the probed dependency states, so this reading is
  // the full one; the mapping still skips any fact a payload does not carry,
  // which is why those inputs stay optional.
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
