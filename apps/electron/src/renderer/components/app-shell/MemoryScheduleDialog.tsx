import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, AlertCircle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { describeCron, computeNextRuns } from '../automations/utils'

export interface MemoryScheduleState {
  enabled: boolean
  cron: string
}

interface MemoryScheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  schedule: MemoryScheduleState
  onSave: (schedule: MemoryScheduleState) => Promise<void>
}

type ScheduleMode = 'off' | 'daily' | 'weekly' | 'every30' | 'custom'

/** Preset options; the cron values drive both the schedule and the preview. */
const PRESETS: Array<{ mode: Exclude<ScheduleMode, 'off' | 'custom'>; cron: string }> = [
  { mode: 'daily', cron: '0 3 * * *' },
  { mode: 'weekly', cron: '0 3 * * 0' },
  { mode: 'every30', cron: '*/30 * * * *' },
]

function modeFromSchedule(schedule: MemoryScheduleState): ScheduleMode {
  if (!schedule.enabled) return 'off'
  const match = PRESETS.find(preset => preset.cron === schedule.cron.trim())
  return match ? match.mode : 'custom'
}

export function MemoryScheduleDialog({ open, onOpenChange, schedule, onSave }: MemoryScheduleDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = React.useState<ScheduleMode>(() => modeFromSchedule(schedule))
  const [customCron, setCustomCron] = React.useState(schedule.cron)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  // Re-initialize from the latest schedule each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setMode(modeFromSchedule(schedule))
      setCustomCron(schedule.cron)
      setSaveError(null)
    }
  }, [open, schedule])

  const effectiveCron = mode === 'custom' ? customCron.trim() : (PRESETS.find(preset => preset.mode === mode)?.cron ?? '')
  const isEnabled = mode !== 'off'

  const preview = React.useMemo(() => {
    if (!isEnabled) return null
    const runs = computeNextRuns(effectiveCron)
    return {
      description: describeCron(effectiveCron),
      valid: runs.length > 0,
      nextRuns: runs,
    }
  }, [isEnabled, effectiveCron])

  const handleSave = async () => {
    if (!isEnabled) {
      setIsSaving(true)
      setSaveError(null)
      try {
        await onSave({ enabled: false, cron: schedule.cron })
        onOpenChange(false)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsSaving(false)
      }
      return
    }
    if (!preview?.valid) return
    setIsSaving(true)
    setSaveError(null)
    try {
      await onSave({ enabled: true, cron: effectiveCron })
      onOpenChange(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  const optionLabel = (modeOption: ScheduleMode): string => {
    switch (modeOption) {
      case 'off': return t('memory.scheduleOff')
      case 'daily': return t('memory.scheduleDaily')
      case 'weekly': return t('memory.scheduleWeekly')
      case 'every30': return t('memory.scheduleEvery30')
      case 'custom': return t('memory.scheduleCustom')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px] gap-0 p-0">
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4 text-accent" />
            {t('memory.scheduleTitle')}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
            {t('memory.scheduleDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          {/* Mode options */}
          <div role="radiogroup" aria-label={t('memory.scheduleTitle')} className="space-y-1.5">
            {(['off', 'daily', 'weekly', 'every30', 'custom'] as ScheduleMode[]).map(modeOption => {
              const selected = mode === modeOption
              return (
                <button
                  key={modeOption}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setMode(modeOption)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-accent/50 bg-accent/5'
                      : 'border-foreground/8 bg-background hover:border-foreground/15',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                      selected ? 'border-accent bg-accent' : 'border-foreground/25',
                    )}
                  >
                    {selected && <Check className="h-2.5 w-2.5 text-accent-foreground" strokeWidth={3} />}
                  </span>
                  <span className="text-xs font-medium">{optionLabel(modeOption)}</span>
                  {modeOption !== 'off' && modeOption !== 'custom' && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {describeCron(PRESETS.find(p => p.mode === modeOption)!.cron)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Custom cron editor */}
          {mode === 'custom' && (
            <div className="space-y-2">
              <Input
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder={t('memory.scheduleCronPlaceholder')}
                className={cn(
                  'h-9 font-mono text-xs',
                  customCron.trim() && preview && !preview.valid && 'border-destructive/50 focus-visible:ring-destructive/30',
                )}
                aria-label={t('memory.scheduleCronPlaceholder')}
                autoFocus
              />
              {customCron.trim() && preview && !preview.valid && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {t('memory.scheduleInvalidCron')}
                </p>
              )}
            </div>
          )}

          {/* Summary card */}
          {mode !== 'off' && (
            <div className="space-y-2 rounded-lg border border-border/50 bg-background p-3 shadow-minimal">
              <div className="flex items-start gap-2">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs font-medium">{preview?.description ?? effectiveCron}</p>
                  {preview?.valid && preview.nextRuns.length > 0 && (
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular-nums">
                      <span>{t('memory.scheduleNextRun')}:</span>
                      {preview.nextRuns.slice(0, 2).map((date, index) => (
                        <span key={index}>
                          {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' })}{' '}
                          {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/50 px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={handleSave}
            disabled={isSaving || (isEnabled && !preview?.valid)}
          >
            {t('common.save')}
          </Button>
          {saveError && (
            <p className="mr-auto text-xs text-destructive">{saveError}</p>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
