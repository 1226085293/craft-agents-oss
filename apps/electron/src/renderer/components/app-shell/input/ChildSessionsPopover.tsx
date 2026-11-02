/**
 * ChildSessionsPopover — sessions this one is subscribed to.
 *
 * Deliberately separate from BackgroundTasksPopover even though both read the
 * same per-session entry list. A subscription is not work the agent launched:
 * it has no command, no output file, and no elapsed-time semantics that matter.
 * Its row means "a session you are following", clicking the name OPENS that
 * session, and stop means stop that session AND drop the subscription —
 * otherwise a stopped child would keep firing finished-turn messages into this
 * conversation with nothing left to show for it.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Loader2, MessagesSquare, Square } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { backgroundTasksAtomFamily, splitBackgroundEntries, type BackgroundTask } from '@/atoms/sessions'

export interface ChildSessionsPopoverProps {
  sessionId: string
  /** Open the child session. */
  onOpenSession: (task: BackgroundTask) => void
  /** Stop the child session and unsubscribe. Row spins until it resolves. */
  onStopSession?: (task: BackgroundTask) => void | Promise<void>
  className?: string
}

export function ChildSessionsPopover({
  sessionId,
  onOpenSession,
  onStopSession,
  className,
}: ChildSessionsPopoverProps) {
  const { t } = useTranslation()
  const entries = useAtomValue(backgroundTasksAtomFamily(sessionId))
  const { childSessions } = React.useMemo(() => splitBackgroundEntries(entries), [entries])

  const [stopping, setStopping] = React.useState<Set<string>>(() => new Set())
  const stoppingRef = React.useRef<Set<string>>(new Set())

  const handleStop = React.useCallback(async (task: BackgroundTask) => {
    if (stoppingRef.current.has(task.id)) return
    stoppingRef.current.add(task.id)
    setStopping((prev) => new Set(prev).add(task.id))
    try {
      await onStopSession?.(task)
    } catch {
      // Keep the row available for a retry.
    } finally {
      stoppingRef.current.delete(task.id)
      setStopping((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }, [onStopSession])

  if (childSessions.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('chat.childSessionsTitle', '子会话')}
          className={cn(
            'flex h-[30px] items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-medium',
            'border border-border/70 bg-background/60 text-muted-foreground',
            'shadow-minimal transition-colors select-none',
            'hover:bg-foreground/5 hover:text-foreground hover:border-border',
            'data-[state=open]:bg-foreground/5 data-[state=open]:text-foreground',
            className,
          )}
        >
          <MessagesSquare className="h-3.5 w-3.5" />
          <span>{t('chat.childSessionsTitle')}</span>
          <span className="tabular-nums">{childSessions.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[380px] p-0">
        <div className="border-b border-border/60 px-3 py-2 text-xs font-medium text-muted-foreground">
          {t('chat.childSessionsTitle', '子会话')}
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          {childSessions.map((session) => {
            const isStopping = stopping.has(session.id) || session.stopping === true
            return (
              <div
                key={session.id}
                className="group flex items-center gap-2 px-2 py-1.5 hover:bg-foreground/5"
              >
                <MessagesSquare className="h-3.5 w-3.5 text-muted-foreground" />
                {/* Name opens the child session — not an output viewer. */}
                <button
                  type="button"
                  onClick={() => onOpenSession(session)}
                  title={session.intent || session.id}
                  className="min-w-0 flex-1 truncate text-left text-xs text-foreground/90 hover:underline"
                >
                  {session.intent || session.id}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStop(session)}
                  disabled={isStopping}
                  title={t('chat.stopChildSession', '停止并取消订阅')}
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
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
