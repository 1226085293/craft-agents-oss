/**
 * Events navigator column.
 *
 * Rows carry metadata only — the body is fetched when a row is opened, so a
 * mailbox full of 300KB emails still scrolls at list speed.
 *
 * Visual conventions follow EntityRow (the app-wide session/source rows):
 * `bg-foreground/3` + left accent rule for selection, `hover:bg-foreground/2`,
 * `text-sm` title, `text-[12px]` metadata. The filters use `SimpleDropdown`
 * rather than native `<select>`: a native select renders its popup with the OS
 * light theme regardless of the app theme, which shows up as a white slab in
 * dark mode.
 */

import * as React from 'react'
import { Search, Inbox, ChevronDown, Check } from 'lucide-react'
import { SimpleDropdown, SimpleDropdownItem } from '@craft-agent/ui'
import type { EventMetaDto } from '@craft-agent/shared/protocol/dto'

export interface EventsListPanelProps {
  workspaceId: string
  selectedEventId: string | null
  onSelectEvent: (eventId: string) => void
  className?: string
}

/**
 * Reception status is one dropdown, not two independent toggles: "有接收方"
 * (has configured recipients) and "未被接收" (not delivered yet) are the two
 * non-default choices of the same question the user asks about a row.
 */
type ReceptionFilter = '' | 'has-recipients' | 'undelivered'

interface FilterState {
  source: string
  type: string
  reception: ReceptionFilter
}

const EMPTY_FILTERS: FilterState = { source: '', type: '', reception: '' }

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Dropdown filter styled like the rest of the filter row. */
function FilterMenu({
  value,
  placeholder,
  allLabel,
  options,
  onChange,
}: {
  value: string
  placeholder: string
  /** Text of the "clear" option; defaults to the placeholder (e.g. 全部来源). */
  allLabel?: string
  options: string[]
  onChange: (next: string) => void
}): React.ReactElement {
  const active = Boolean(value)
  return (
    <SimpleDropdown
      align="start"
      trigger={
        <button
          type="button"
          className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs rounded-md border transition-colors ${
            active
              ? 'bg-foreground/10 text-foreground border-foreground/20'
              : 'bg-muted/40 text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5'
          }`}
        >
          <span className="truncate max-w-[8.5rem]">{value || placeholder}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      }
    >
      <SimpleDropdownItem onClick={() => onChange('')}>
        <span className="flex items-center gap-1.5">
          <Check className={`h-3 w-3 ${value ? 'opacity-0' : 'opacity-100'}`} />
          {allLabel ?? placeholder}
        </span>
      </SimpleDropdownItem>
      {options.map((option) => (
        <SimpleDropdownItem key={option} onClick={() => onChange(option)}>
          <span className="flex items-center gap-1.5">
            <Check className={`h-3 w-3 ${value === option ? 'opacity-100' : 'opacity-0'}`} />
            <span className="truncate">{option}</span>
          </span>
        </SimpleDropdownItem>
      ))}
    </SimpleDropdown>
  )
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
        ...(filters.reception === 'has-recipients' ? { hasRecipients: true } : {}),
        ...(filters.reception === 'undelivered' ? { delivered: false } : {}),
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

  const sources = React.useMemo(() => Array.from(new Set(events.map((e) => e.source))).sort(), [events])
  const types = React.useMemo(() => Array.from(new Set(events.map((e) => e.type))).sort(), [events])

  const RECEPTION_OPTIONS: { value: ReceptionFilter; label: string }[] = [
    { value: 'has-recipients', label: '有接收方' },
    { value: 'undelivered', label: '未被接收' },
  ]

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-2.5 space-y-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索事件…"
            className="w-full h-8 pl-8 pr-2 text-sm bg-muted/40 rounded-md border border-transparent focus:border-foreground/20 focus:outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterMenu
            value={filters.source}
            placeholder="全部来源"
            options={sources}
            onChange={(next) => setFilters((prev) => ({ ...prev, source: next }))}
          />
          <FilterMenu
            value={filters.type}
            placeholder="全部类型"
            options={types}
            onChange={(next) => setFilters((prev) => ({ ...prev, type: next }))}
          />
          <FilterMenu
            value={RECEPTION_OPTIONS.find((o) => o.value === filters.reception)?.label ?? ''}
            placeholder="接收状态"
            allLabel="全部"
            options={RECEPTION_OPTIONS.map((o) => o.label)}
            onChange={(next) =>
              setFilters((prev) => ({
                ...prev,
                reception: (RECEPTION_OPTIONS.find((o) => o.label === next)?.value ?? '') as ReceptionFilter,
              }))
            }
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}

        {!error && events.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Inbox className="h-7 w-7 opacity-70" />
            <p className="text-sm">还没有事件</p>
            <p className="text-xs opacity-70">在「事件监听」里把接收地址交给你的脚本</p>
          </div>
        )}

        {events.map((event) => {
          const selected = event.id === selectedEventId
          return (
            <button
              key={event.id}
              type="button"
              onClick={() => onSelectEvent(event.id)}
              className={`relative w-full text-left px-3 pr-4 py-2.5 mx-1 rounded-[8px] transition-colors ${
                // Same grammar as EntityRow: faint foreground wash + a left
                // accent rule; the accent never fills the whole row.
                selected
                  ? 'bg-foreground/3 shadow-[inset_2px_0_0_0_hsl(var(--accent))]'
                  : 'hover:bg-foreground/2'
              }`}
              style={{ width: 'calc(100% - 8px)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] leading-4 px-1.5 rounded bg-muted text-muted-foreground shrink-0">
                  {event.type}
                </span>
                <span className="text-[12px] text-muted-foreground truncate">{event.source}</span>
                <span className="ml-auto text-[12px] text-muted-foreground/80 shrink-0 tabular-nums">
                  {formatTime(event.receivedAt)}
                </span>
                <span
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    event.delivered ? 'bg-accent' : 'bg-foreground/20'
                  }`}
                  aria-label={event.delivered ? '已接收' : '未接收'}
                  title={event.delivered ? '已接收' : '未被接收'}
                />
              </div>
              <div className="text-sm leading-5 truncate">{event.title}</div>
              {event.summary && (
                <div className="text-[12px] leading-4 text-foreground/55 truncate mt-0.5">
                  {event.summary}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
