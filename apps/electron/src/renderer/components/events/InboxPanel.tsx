/**
 * Inbox: the navigator column for events that arrived but no session has
 * finished acting on yet.
 *
 * This is the queue half of the event loop — the article's 「收件箱」 made
 * visible. Its emptiness means 「nothing is waiting on the agent」. A row
 * opens the same event detail as the event log, so the inbox is a filter
 * over the log, not a parallel data source.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import type { EventMetaDto } from '@craft-agent/shared/protocol/dto'

export interface InboxPanelProps {
  workspaceId: string
  /** Open the event's detail view (the log section's event detail). */
  onSelectEvent: (eventId: string) => void
  className?: string
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function InboxPanel({ workspaceId, onSelectEvent, className }: InboxPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [events, setEvents] = React.useState<EventMetaDto[]>([])
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      // `handled: false` is the queue itself: arrived, and no receiving run
      // has finished yet. The log keeps everything, this view keeps the debt.
      const rows = await window.electronAPI.listEvents(workspaceId, { handled: false, limit: 200 })
      setEvents(Array.isArray(rows) ? rows : [])
    } catch (error) {
      console.error('[InboxPanel] load failed:', error)
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  // New arrivals arrive as broadcasts; only unhandled ones belong to the queue.
  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventsChanged((wsId, event) => {
      if (wsId !== workspaceId) return
      if (event.handledAt) return
      setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [event, ...prev].slice(0, 200)))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId])

  const count = events.length

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">
          {t('events.inbox.pending', { defaultValue: '待处理' })}
        </span>
        {count > 0 && (
          <span className="ml-auto text-[12px] tabular-nums text-foreground/70 bg-foreground/5 rounded-full px-2 py-0.5">
            {count}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && events.length === 0 && (
          <div className="px-3 py-6 text-[13px] text-muted-foreground/60">{t('events.inbox.loading', { defaultValue: '加载中…' })}</div>
        )}

        {!loading && events.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Inbox className="h-7 w-7 opacity-70" />
            <p className="text-sm">{t('events.inbox.empty', { defaultValue: '收件箱为空' })}</p>
            <p className="text-xs opacity-70">{t('events.inbox.emptyHint', { defaultValue: '所有到达的事件都已被处理完毕' })}</p>
          </div>
        )}

        {events.map((event) => (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelectEvent(event.id)}
            className="relative w-full text-left px-3 pr-4 py-3 mx-1 rounded-[8px] transition-colors hover:bg-foreground/2"
            style={{ width: 'calc(100% - 8px)' }}
          >
            <div className="flex items-center gap-2.5">
              <div className="text-[14.5px] leading-6 text-foreground truncate min-w-0 flex-1">
                {event.title}
              </div>
              <span className="shrink-0 text-[12px] leading-5 tabular-nums text-muted-foreground/80">
                {formatTime(event.receivedAt)}
              </span>
            </div>
            {event.summary && (
              <div className="text-[12.5px] leading-5 text-foreground/60 truncate mt-1">{event.summary}</div>
            )}
            <div className="flex items-center gap-1.5 mt-1.5 text-[12px] leading-5">
              <span className="truncate text-foreground/55" title={`${event.source} · ${event.type}`}>
                {event.source}
              </span>
              <span className="opacity-50 shrink-0">·</span>
              <span className="truncate text-muted-foreground">{event.type}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
