/**
 * StrategySelector — the composer's routing picker.
 *
 * Replaces the model/connection picker: a caller picks *which strategy group*
 * handles the request, and the gateway decides the provider and model. That is
 * the whole point of having a gateway — the composer should not be choosing
 * upstreams, it should be choosing a routing policy.
 *
 * The label shows `策略组名 · 下一个请求将使用的模型`. The model half is a
 * prediction, not a record: the router takes the session's own model when the
 * group can serve it *right now* and otherwise the first model whose
 * availability window is open, so the label can be computed before the request
 * is sent. It used to read `lastModels` — the model the gateway called last —
 * which is history: a finished title generation on `hy3` made the chip say
 * `hy3` while the conversation request went to `hy4-preview` (2026-10-29).
 * The popover's rows still show each group's `lastModel` — there, history is
 * the useful thing.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, ChevronRight, ChevronsUpDown, Cpu } from 'lucide-react'

import { THINKING_LEVELS, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** One strategy as the composer sees it. */
export interface StrategyOption {
  id: string
  /** Display name; falls back to the id for strategies written before it existed. */
  name?: string
  /** Last upstream model this strategy routed to, when there has been traffic. */
  lastModel?: string
  /**
   * Public models the strategy can actually serve. Empty means the group is
   * configured but unusable (no enabled member, or members map no models) —
   * the label says so instead of silently showing a dash.
   */
  models?: string[]
  /**
   * The subset of `models` usable right now (availability windows applied).
   * Absent means an older main process that does not compute it.
   */
  openModels?: string[]
  /** Disabled strategies are hidden from the picker entirely. */
  enabled?: boolean
  /** False when configured but unable to serve (no models / no providers). */
  usable?: boolean
  /** Why it is unusable; shown in the warning tooltip. */
  reason?: string
}

export interface StrategySelectorProps {
  strategies: StrategyOption[]
  value: string
  /**
   * The session's own model, i.e. what a request would ask the group for.
   * Deliberately *not* the gateway's last routed model: that is history and
   * made the label disagree with the next request.
   */
  sessionModel?: string
  /**
   * The model the session is actually on right now, used by the callers that
   * size things against live traffic (context ring). Only a fallback here.
   */
  currentModel?: string
  onChange: (strategyId: string) => void
  /** Gateway not running / no strategies configured — disable and explain. */
  unavailable?: string | null
  /** Thinking level lives at the bottom of this popover (old model-picker shape). */
  thinkingLevel?: ThinkingLevel
  onThinkingChange?: (level: ThinkingLevel) => void
  thinkingDisabled?: boolean
  /**
   * The session's strategy is gone/disabled/unusable: the trigger turns red and
   * the composer blocks sending. The string is the reason to show.
   */
  blockedReason?: string | null
  className?: string
}

export function StrategySelector({
  strategies,
  value,
  sessionModel,
  currentModel,
  onChange,
  unavailable = null,
  thinkingLevel,
  onThinkingChange,
  thinkingDisabled = false,
  blockedReason = null,
  className,
}: StrategySelectorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [thinkingOpen, setThinkingOpen] = React.useState(false)

  // Disabled groups never appear; unusable ones stay (greyed) at the bottom so
  // the reason is discoverable instead of the group silently vanishing.
  const visible = strategies
    .filter((s) => s.enabled !== false)
    .sort((a, b) => Number(b.usable !== false) - Number(a.usable !== false))
  const current = strategies.find((s) => s.id === value)
  const currentThinking = THINKING_LEVELS.find((l) => l.id === thinkingLevel)
  const disabled = !!unavailable || strategies.length === 0

  /**
   * The label's two halves: 策略组名 · 下一个请求将使用的模型。
   */
  const strategyLabel =
    current?.name ??
    current?.id ??
    (blockedReason && value
      ? value
      : unavailable ??
        (strategies.length === 0
          ? t('chat.strategy.noGroups', '还没有策略组')
          : t('chat.strategy.none', '未选择策略组')))
  // `models` missing means an older main process (pre-status-field), not an
  // invalid group — only an explicit empty array is "no usable models".
  const strategyDisabled = !!current && current.enabled === false
  const invalid = !!current && Array.isArray(current.models) && current.models.length === 0
  // The next request's model, not the last one. A dash only survives when the
  // group is unusable — otherwise there is always an answer.
  const modelLabel = strategyDisabled
    ? t('chat.strategy.disabled', '已禁用')
    : invalid
      ? t('chat.strategy.noModels', '无可用模型')
      : nextStrategyModel(current?.models, sessionModel ?? currentModel, current?.openModels) ??
        t('chat.strategy.unavailableNow', '当前无可用模型')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={
            blockedReason ?? unavailable ?? `${strategyLabel} · ${modelLabel}`
          }
          aria-label={t('chat.strategy.pick', '选择策略组')}
          className={cn(
            'inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[13px] transition-colors select-none',
            'hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60',
            open && 'bg-foreground/5',
            (unavailable || blockedReason) && 'text-destructive',
            className,
          )}
        >
          <Cpu className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate font-medium">{strategyLabel}</span>
          <span className="shrink-0 opacity-40">-</span>
          <span className="truncate text-muted-foreground">{modelLabel}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        {/* The strategy list scrolls on its own so the thinking submenu can
            escape the popover without being clipped. */}
        <div className="max-h-[min(45vh,300px)] overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            没有可用的策略组。到「设置 → LLM 网关 → 策略组」创建或启用一个。
          </p>
        ) : (
          <div className="flex flex-col">
            {visible.map((s) => {
              const usable = s.usable !== false
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!usable}
                  title={usable ? undefined : (s.reason ?? t('chat.strategy.noModels', '不可用'))}
                  className={cn(
                    'flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] transition-colors',
                    usable && 'hover:bg-foreground/5',
                    !usable && 'cursor-not-allowed opacity-50',
                    s.id === value && usable && 'bg-foreground/5',
                  )}
                  onClick={() => {
                    if (!usable) return
                    onChange(s.id)
                    setOpen(false)
                  }}
                >
                  {/* The name sits at the row's left edge: no reserved slot for
                      the check, which used to indent every unselected group. */}
                  <span className="min-w-0 flex-1 truncate">{s.name ?? s.id}</span>
                  {!usable ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label={s.reason} />
                  ) : s.lastModel ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {s.lastModel}
                    </span>
                  ) : null}
                  {s.id === value && usable ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              )
            })}
          </div>
        )}
        </div>

        {THINKING_LEVELS.length > 0 ? (
          <>
            <div className="my-1 h-px bg-border" />
            <div
              className="relative"
              onMouseEnter={() => setThinkingOpen(true)}
              onMouseLeave={() => setThinkingOpen(false)}
            >
              <button
                type="button"
                disabled={thinkingDisabled}
                onClick={() => setThinkingOpen((v) => !v)}
                aria-label={t('chat.thinking.level', '思考等级')}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] transition-colors',
                  'hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50',
                  thinkingOpen && 'bg-foreground/5',
                )}
              >
                <span className="shrink-0 text-muted-foreground">
                  {t('chat.thinking.level', '思考等级')}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate">{t(currentThinking?.nameKey ?? 'thinking.medium', '—')}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
                </span>
              </button>

              {thinkingOpen ? (
                <div className="absolute bottom-0 right-full z-[1000] pr-1">
                  <div className="w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
                    {THINKING_LEVELS.map((level) => {
                      const selected = thinkingLevel === level.id
                      return (
                        <button
                          key={level.id}
                          type="button"
                          disabled={thinkingDisabled}
                          onClick={() => onThinkingChange?.(level.id)}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors',
                            'hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50',
                            selected && 'bg-foreground/5',
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">{t(level.nameKey, level.id)}</span>
                            <span className="block whitespace-normal text-[11px] leading-snug text-muted-foreground">
                              {t(level.descriptionKey, '')}
                            </span>
                          </span>
                          <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Build the composer's bottom-right label from a strategy and its live model. */
/**
 * The model the *next* request will use.
 *
 * Mirrors `pickStrategyModel` in `@craft-agent/shared/config` (strategy
 * availability): the session's own model wins when it can be served *now*,
 * otherwise the first model whose window is open, in declared order. Returns
 * `null` when nothing in the group is open — the caller says so instead of
 * naming a model that is guaranteed to fail.
 *
 * `openModels` is absent on older main processes; then availability is unknown
 * and the whole list counts as open, which is the pre-window behaviour.
 */
export function nextStrategyModel(
  models: readonly string[] | undefined,
  sessionModel: string | undefined,
  openModels?: readonly string[],
): string | null {
  if (!models?.length) return '—'
  const open = openModels ?? models
  if (sessionModel && open.includes(sessionModel)) return sessionModel
  return open[0] ?? null
}
