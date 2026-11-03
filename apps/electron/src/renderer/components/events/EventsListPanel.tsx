/**
 * Events navigator column.
 *
 * Rows carry metadata only — the body is fetched when a row is opened, so a
 * mailbox full of 300KB emails still scrolls at list speed.
 */

import * as React from 'react'
import { Search, Inbox, CircleDot, Circle } from 'lucide-react'
import type { EventMetaDto } from '@craft-agent/shared/protocol/dto'

export interface EventsListPanelProps {
  workspaceId: string
  selectedEventId: string | null
  onSelectEvent: (eventId: string) => void
  className?: string
}

interface FilterState {
  source: string
  type: string
  hasRecipients: boolean
  undeliveredOnly: boolean
}

const EMPTY_FILTERS: FilterState = { source: '', type: '', hasRecipients: false, undeliveredOnly: false }

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function EventsListPanel({
  workspaceId,
  selectedEventId,
  onSelectEvent,
  className,
}: EventsListPanelProps): React.ReactElement {
  const [events, setEvents] = React.useState<EventMetaDto[]>([])
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<FilterState>(EMPTY_FILTERS)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Debounce the query so typing does not fire one FTS call per keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      const rows = await window.electronAPI.listEvents(workspaceId, {
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(filters.source ? { source: filters.source } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.hasRecipients ? { hasRecipients: true } : {}),
        ...(filters.undeliveredOnly ? { delivered: false } : {}),
        limit: 200,
      })
      setEvents(Array.isArray(rows) ? rows : [])
    } catch (err) {
      console.error('[EventsListPanel] load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId, debouncedSearch, filters])

  React.useEffect(() => {
    void load()
  }, [load])

  // New events arrive as a broadcast; prepend when they pass the current filter
  // rather than refetching the page.
  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventsChanged((wsId, event) => {
      if (wsId !== workspaceId) return
      if (filters.source && event.source !== filters.source) return
      setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [event, ...prev].slice(0, 200)))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, filters.source])

  // Derived filter options from what is actually stored.
  const sources = React.useMemo(
    () => Array.from(new Set(events.map((e) => e.source))).sort(),
    [events],
  )
  const types = React.useMemo(
    () => Array.from(new Set(events.map((e) => e.type))).sort(),
    [events],
  )

  const toggle = (key: 'hasRecipients' | 'undeliveredOnly') =>
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-2 space-y-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索事件…"
            className="w-full h-8 pl-7 pr-2 text-sm bg-muted/50 rounded-md border border-transparent focus:border-border focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={filters.source}
            onChange={(e) => setFilters((prev) => ({ ...prev, source: e.target.value }))}
            className="h-7 text-xs bg-muted/50 rounded-md border border-transparent px-1.5 focus:outline-none"
          >
            <option value="">全部来源</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>

          <select
            value={filters.type}
            onChange={(e) => setFilters((prev) => ({ ...prev, type: e.target.value }))}
            className="h-7 text-xs bg-muted/50 rounded-md border border-transparent px-1.5 focus:outline-none"
          >
            <option value="">全部类型</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => toggle('hasRecipients')}
            className={`h-7 px-2 text-xs rounded-md border transition-colors ${
              filters.hasRecipients
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            有接收方
          </button>

          <button
            type="button"
            onClick={() => toggle('undeliveredOnly')}
            className={`h-7 px-2 text-xs rounded-md border transition-colors ${
              filters.undeliveredOnly
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            未被接收
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}

        {!error && events.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Inbox className="h-6 w-6" />
            <p className="text-xs">还没有事件</p>
            <p className="text-[11px] opacity-70">在「事件监听」里把接收地址交给你的脚本</p>
          </div>
        )}

        {events.map((event) => {
          const selected = event.id === selectedEventId
          return (
            <button
              key={event.id}
              type="button"
              onClick={() => onSelectEvent(event.id)}
              className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors ${
                selected ? 'bg-accent' : 'hover:bg-accent/50'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[10px] px-1 py-px rounded bg-muted text-muted-foreground shrink-0">
                  {event.type}
                </span>
                <span className="text-[10px] text-muted-foreground truncate">{event.source}</span>
                <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                  {formatTime(event.receivedAt)}
                </span>
                {event.delivered ? (
                  <CircleDot className="h-2.5 w-2.5 text-primary shrink-0" aria-label="已接收" />
                ) : (
                  <Circle className="h-2.5 w-2.5 text-muted-foreground/40 shrink-0" aria-label="未接收" />
                )}
              </div>
              <div className="text-sm truncate">{event.title}</div>
              {event.summary && (
                <div className="text-xs text-muted-foreground truncate">{event.summary}</div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
