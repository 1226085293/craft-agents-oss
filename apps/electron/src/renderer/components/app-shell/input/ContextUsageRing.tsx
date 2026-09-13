import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { formatTokenCount } from './model-picker-helpers'

/** Usage (0–1 of the context window) at which the ring turns amber / red. */
const WARN_AT = 0.6
const DANGER_AT = 0.75

/**
 * Last-resort context window. The agent normally reports one, and known models
 * are resolvable via the registry, but custom / `pi/`-prefixed ids are not —
 * without a fallback the ring would silently render nothing.
 */
const FALLBACK_CONTEXT_WINDOW = 200_000

export interface ContextUsageRingProps {
  /** Tokens currently in the context, as reported by the agent. */
  inputTokens?: number | null
  /** Context window reported by the agent (preferred over the model default). */
  contextWindow?: number | null
  /** Fallback window derived from the selected model. */
  fallbackContextWindow?: number | null
  isCompacting?: boolean
  /** Blocks the click-to-compact affordance (e.g. while a turn is running). */
  disabled?: boolean
  onCompact?: () => void
  className?: string
}

/**
 * Circular context-usage indicator for the composer.
 *
 * Visible as soon as token data is available so users can see how much of the
 * context window is used, and click to compact manually before the agent hits
 * its automatic compaction threshold.
 */
export function ContextUsageRing({
  inputTokens,
  contextWindow,
  fallbackContextWindow,
  isCompacting = false,
  disabled = false,
  onCompact,
  className,
}: ContextUsageRingProps) {
  const { t } = useTranslation()

  const effectiveWindow = contextWindow || fallbackContextWindow || FALLBACK_CONTEXT_WINDOW
  // Missing usage data renders an empty ring rather than nothing, so the control
  // is discoverable and its tooltip can explain the current state.
  const ratio = React.useMemo(() => {
    if (!effectiveWindow || effectiveWindow <= 0) return 0
    return Math.min(1, Math.max(0, (inputTokens ?? 0) / effectiveWindow))
  }, [inputTokens, effectiveWindow])

  const percent = Math.round(ratio * 100)
  // NOTE: this theme only defines background/foreground/accent/info/success/
  // destructive — there is no `--primary`, so using it would resolve to nothing.
  const stroke = ratio >= DANGER_AT
    ? 'var(--destructive)'
    : ratio >= WARN_AT
      ? 'var(--info)'
      : 'var(--accent)'

  const radius = 9
  const circumference = 2 * Math.PI * radius

  const hint = isCompacting || disabled ? t('chat.contextBusyHint') : t('chat.contextCompactHint')

  const ring = (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      className="-rotate-90 shrink-0"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="3"
        stroke="currentColor"
        className="text-foreground/20"
      />
      {/* Colour must come from inline style: CSS custom properties are not
          resolved when used in an SVG presentation attribute (`stroke="var(--x)"`),
          which made the progress arc invisible while the track still rendered. */}
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        style={{
          stroke,
          strokeDasharray: `${ratio * circumference} ${circumference}`,
          transition: 'stroke-dasharray 0.3s ease-out, stroke 0.3s ease-out',
        }}
      />
    </svg>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onCompact ? (
          <button
            type="button"
            onClick={onCompact}
            disabled={disabled || isCompacting}
            aria-label={t('chat.contextUsage')}
            className={cn(
              'inline-flex items-center gap-1 h-7 px-0.5 rounded-[6px] hover:bg-foreground/5 transition-colors',
              'disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent',
              className,
            )}
          >
            {ring}
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </button>
        ) : (
          <span className={cn('inline-flex items-center gap-1 h-7 px-0.5', className)}>{ring}</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        {t('chat.contextUsed', { percent })}
        {` · ${formatTokenCount(inputTokens ?? 0)} — ${hint}`}
      </TooltipContent>
    </Tooltip>
  )
}
