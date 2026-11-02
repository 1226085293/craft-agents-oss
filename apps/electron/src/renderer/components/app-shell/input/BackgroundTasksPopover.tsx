/**
 * BackgroundTasksPopover — the composer's background-task list.
 *
 * Replaces the always-visible chip row (ActiveTasksBar + TaskActionMenu):
 * those chips occupied composer space permanently and each one opened its own
 * dropdown, which does not scale past two or three tasks. Here a single toolbar
 * button appears ONLY when there is something to show, and the whole list lives
 * in one popover.
 *
 * Interaction contract (2026-10-30 user-specified):
 * - Clicking a task NAME jumps to its output — deliberately not a separate
 *   "view output" button, to keep the row to one action per intent.
 * - STOP is the only visible button. It stops the command; while the stop is
 *   settling the button spins. A stop that has not landed after 5s is escalated
 *   to a forced kill by the backend.
 * - A row disappears only once its result has been DELIVERED to the model, so a
 *   row that is done-but-undelivered keeps showing (as "awaiting delivery")
 *   instead of vanishing and leaving the user wondering.
 *
 * Child sessions are NOT here — they live in ChildSessionsPopover, because a
 * subscription has no command and its "stop" means something different.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2, Square, Terminal, XCircle } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { backgroundTasksAtomFamily, splitBackgroundEntries, type BackgroundTask } from '@/atoms/sessions'

export interface BackgroundTasksPopoverProps {
  sessionId: string
  /** Stop one task. The row spins until this resolves. */
  onStopTask?: (taskId: string) => void | Promise<void>
  /** Jump to a task's output (terminal overlay). */
  onShowOutput?: (task: BackgroundTask) => void
  className?: string
}

/**
 * Elapsed time for a row.
 *
 * Derived from `startTime` rather than `elapsedSeconds`: only agent/proxy tasks
 * receive task_progress ticks, so a backgrounded shell would always show 0s.
 * A terminal task freezes at its completion time instead of continuing to grow.
 */
function formatElapsed(task: BackgroundTask, now: number): string {
  const end = task.completedAt ?? now
  const seconds = Math.max(0, Math.round((end - task.startTime) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m${rest.toString().padStart(2, '0')}s`
}

/** Status → icon. Running shows a spinner; terminal states stay distinguishable. */
function StatusIcon({ task }: { task: BackgroundTask }) {
  switch (task.status) {
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-destructive" />
    case 'stopped':
      return <Square className="h-3 w-3 opacity-60" />
    case 'orphaned':
    case 'stale':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
    default:
      return <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
  }
}

export function BackgroundTasksPopover({
  sessionId,
  onStopTask,
  onShowOutput,
  className,
}: BackgroundTasksPopoverProps) {
  const { t } = useTranslation()
  // Hydration happens one level up (FreeFormInput): this component returns null
  // when the list is empty, so a hook here would never run to fill it.
  const entries = useAtomValue(backgroundTasksAtomFamily(sessionId))
  const { tasks } = React.useMemo(() => splitBackgroundEntries(entries), [entries])

  const [stopping, setStopping] = React.useState<Set<string>>(() => new Set())
  const stoppingRef = React.useRef<Set<string>>(new Set())
  // Elapsed must tick locally: handed-off shells never emit task_progress, so
  // `elapsedSeconds` stays 0 and every row read "0s" no matter how long it ran.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const handleStop = React.useCallback(async (taskId: string) => {
    // Ref is updated synchronously so two clicks in one React batch cannot both
    // pass the guard before the disabled state re-renders.
    if (stoppingRef.current.has(taskId)) return
    stoppingRef.current.add(taskId)
    setStopping((prev) => new Set(prev).add(taskId))
    try {
      await onStopTask?.(taskId)
    } catch {
      // Keep the row available for a retry.
    } finally {
      stoppingRef.current.delete(taskId)
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }, [onStopTask])

  // No tasks → no button at all. The button is a status indicator, not a
  // permanent composer option.
  if (tasks.length === 0) return null

  const runningCount = tasks.filter((task) => task.status === 'running').length

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('chat.backgroundTasksTitle', '后台任务')}
          className={cn(
            'flex h-[30px] items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-medium',
            'border border-border/70 bg-background/60 text-muted-foreground',
            'shadow-minimal transition-colors select-none',
            'hover:bg-foreground/5 hover:text-foreground hover:border-border',
            'data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground',
            runningCount > 0 && 'text-foreground',
            className,
          )}
        >
          <Terminal className="h-3.5 w-3.5" />
          <span>{t('chat.backgroundTasksTitle')}</span>
          <span className="tabular-nums">{tasks.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[420px] p-0">
        <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
          {t('chat.backgroundTasksTitle', '后台任务')}
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          {tasks.map((task) => {
            const isStopping = stopping.has(task.id) || task.stopping === true
            const isTerminal =
              task.status === 'completed'
              || task.status === 'failed'
              || task.status === 'stopped'
              || task.status === 'orphaned'
            // While a stop is settling, show the button (spinning) even if the
            // terminal status has already landed — otherwise the fast kill flips
            // `status` to `stopped` and the button vanishes before the spinner
            // can ever render.
            const showStopButton = !isTerminal || isStopping
            return (
              <div
                key={task.id}
                className="group flex items-center gap-2 px-2 py-1.5 hover:bg-foreground/5"
              >
                <StatusIcon task={task} />
                {/* Name IS the "view output" affordance — one action per intent. */}
                <button
                  type="button"
                  onClick={() => onShowOutput?.(task)}
                  title={task.intent || task.id}
                  className="min-w-0 flex-1 truncate text-left text-xs text-foreground/90 hover:underline"
                >
                  {task.intent || task.id}
                </button>
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                  {formatElapsed(task, now)}
                </span>
                {showStopButton && (
                  <button
                    type="button"
                    onClick={() => void handleStop(task.id)}
                    disabled={isStopping}
                    title={t('chat.stopTask', '停止任务')}
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                      isStopping && 'cursor-wait opacity-70',
                    )}
                  >
                    {isStopping
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Square className="h-3 w-3" />}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
