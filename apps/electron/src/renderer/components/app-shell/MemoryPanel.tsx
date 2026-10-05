import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { DateRange } from 'react-day-picker'
import { cn } from '@/lib/utils'
import {
  Brain, Trash2, Plus, Search, RotateCcw, Pencil, Check, X, Sparkles,
  Loader2, CalendarDays, FilterX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'

interface MemoryPanelProps {
  workspaceRootPath?: string
  sessionId?: string
  scope?: 'global' | 'session'
  className?: string
}

type MemoryType = 'fact' | 'preference' | 'workflow' | 'reminder' | 'context'

interface MemoryEntry {
  id: string
  type: MemoryType
  content: string
  tags: string[]
  confidence: number
  createdAt: string
  sourceSessionId: string
}

interface TrashedMemory {
  entry: MemoryEntry
  deletedAt: string
  reason?: string
}

interface MemoryStats {
  totalEntries: number
  entriesByType: Record<string, number>
  totalExtractions: number
  lastExtractionAt?: string
}

type TimeRangeFilter = 'all' | 'day' | 'week' | 'month' | 'custom'
type SortOrder = 'newest' | 'oldest'

const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'workflow', 'reminder', 'context']

const DAY_MS = 24 * 60 * 60 * 1000

/** Format an ISO timestamp as a readable local time (raw fallback if unparseable). */
function formatLastExtractionTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Short local date label (YYYY-MM-DD) for the custom range button. */
function formatRangeDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  preference: 'bg-green-500/10 text-green-500 border-green-500/20',
  workflow: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  reminder: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  context: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
}

export function MemoryPanel({ workspaceRootPath, sessionId, scope = sessionId ? 'session' : 'global', className }: MemoryPanelProps) {
  const { t } = useTranslation()

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  const [memories, setMemories] = React.useState<MemoryEntry[]>([])
  const [stats, setStats] = React.useState<MemoryStats | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null)

  // Filters / sort (global scope)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState<'all' | MemoryType>('all')
  const [timeRange, setTimeRange] = React.useState<TimeRangeFilter>('all')
  const [customRange, setCustomRange] = React.useState<DateRange | undefined>(undefined)
  const [sortOrder, setSortOrder] = React.useState<SortOrder>('newest')

  // Add / edit / trash
  const [newMemory, setNewMemory] = React.useState('')
  const [newMemoryType, setNewMemoryType] = React.useState<MemoryType>('fact')
  const [showAddForm, setShowAddForm] = React.useState(false)
  const [showTrash, setShowTrash] = React.useState(false)
  const [trash, setTrash] = React.useState<TrashedMemory[]>([])
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editContent, setEditContent] = React.useState('')
  const [editType, setEditType] = React.useState<MemoryType>('fact')

  // Consolidation
  const [isConsolidating, setIsConsolidating] = React.useState(false)
  const [consolidationProgress, setConsolidationProgress] = React.useState<{ done: number; total: number } | null>(null)

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = React.useState(false)
  const [scheduleCron, setScheduleCron] = React.useState('0 3 * * *')

  const typeLabel = React.useCallback((type: string) => t(`memory.type.${type}`, { defaultValue: type }), [t])

  const loadMemories = React.useCallback(async () => {
    if (!workspaceRootPath) return
    setIsLoading(true)
    setError(null)
    try {
      if (scope === 'session' && sessionId) {
        const result = await window.electronAPI.getSessionMemories(workspaceRootPath, sessionId)
        setMemories(result.entries || [])
        setStats(null)
      } else {
        const [result, trashItems, schedule] = await Promise.all([
          window.electronAPI.getMemoryStats(workspaceRootPath),
          window.electronAPI.getMemoryTrash(workspaceRootPath),
          window.electronAPI.getMemorySchedule(workspaceRootPath),
        ])
        if (result) {
          setStats(result.stats)
          setMemories(result.entries || [])
        }
        setTrash(trashItems || [])
        setScheduleEnabled(schedule.enabled)
        setScheduleCron(schedule.cron)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [workspaceRootPath, scope, sessionId])

  // Opening the panel IS the refresh: load on mount, no manual refresh button.
  React.useEffect(() => {
    loadMemories()
  }, [loadMemories])

  // Listen for consolidation progress pushed from the workspace server.
  React.useEffect(() => {
    if (scope !== 'global') return
    return window.electronAPI.onMemoryConsolidationProgress((progress) => {
      setConsolidationProgress({ done: progress.done, total: progress.total })
    })
  }, [scope])

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  const activeTimeRange = React.useMemo(() => {
    const now = Date.now()
    switch (timeRange) {
      case 'day': return { from: now - DAY_MS, to: now }
      case 'week': return { from: now - 7 * DAY_MS, to: now }
      case 'month': return { from: now - 30 * DAY_MS, to: now }
      case 'custom': {
        if (!customRange?.from) return null
        const from = customRange.from.getTime()
        // Inclusive: end-of-day when a to-date is picked.
        const to = customRange.to
          ? customRange.to.getTime() + DAY_MS - 1
          : now
        return { from, to }
      }
      default: return null
    }
  }, [timeRange, customRange])

  const filteredMemories = React.useMemo(() => {
    let list = memories
    const query = searchQuery.trim().toLowerCase()
    if (query) {
      list = list.filter(m =>
        m.content.toLowerCase().includes(query) ||
        m.tags.some(tag => tag.toLowerCase().includes(query))
      )
    }
    if (typeFilter !== 'all') {
      list = list.filter(m => m.type === typeFilter)
    }
    if (activeTimeRange) {
      list = list.filter(m => {
        const ts = new Date(m.createdAt).getTime()
        return ts >= activeTimeRange.from && ts <= activeTimeRange.to
      })
    }
    // Default: newest first.
    return [...list].sort((a, b) => {
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      return sortOrder === 'newest' ? diff : -diff
    })
  }, [memories, searchQuery, typeFilter, activeTimeRange, sortOrder])

  const hasActiveFilters = React.useMemo(
    () => Boolean(searchQuery.trim()) || typeFilter !== 'all' || timeRange !== 'all' || Boolean(customRange),
    [searchQuery, typeFilter, timeRange, customRange],
  )

  const clearFilters = React.useCallback(() => {
    setSearchQuery('')
    setTypeFilter('all')
    setTimeRange('all')
    setCustomRange(undefined)
  }, [])

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------
  const handleAddMemory = async () => {
    if (!newMemory.trim() || !workspaceRootPath) return
    setError(null)
    try {
      await window.electronAPI.addMemory(workspaceRootPath, {
        content: newMemory.trim(),
        type: newMemoryType,
        tags: [],
        confidence: 1.0,
      })
      setNewMemory('')
      setShowAddForm(false)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteMemory = async (id: string) => {
    if (!workspaceRootPath) return
    setError(null)
    try {
      if (scope === 'session' && sessionId) {
        await window.electronAPI.deleteSessionMemory(workspaceRootPath, sessionId, id)
      } else {
        await window.electronAPI.deleteMemory(workspaceRootPath, id)
      }
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleSelected = (id: string, additive: boolean) => {
    setSelectedIds(current => additive
      ? current.includes(id) ? current.filter(item => item !== id) : [...current, id]
      : [id])
  }

  const handleBulkDelete = async () => {
    if (!workspaceRootPath || scope !== 'global') return
    await window.electronAPI.deleteMemories(workspaceRootPath, selectedIds)
    setSelectedIds([])
    await loadMemories()
  }

  const handleSaveEdit = async () => {
    if (!workspaceRootPath || !editingId || !editContent.trim()) return
    setError(null)
    try {
      if (scope === 'session' && sessionId) {
        await window.electronAPI.updateSessionMemory(workspaceRootPath, sessionId, editingId, { content: editContent.trim(), type: editType })
      } else {
        await window.electronAPI.updateMemory(workspaceRootPath, editingId, { content: editContent.trim(), type: editType })
      }
      setEditingId(null)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const saveSchedule = async (enabled: boolean, cron = scheduleCron) => {
    if (!workspaceRootPath) return
    const previous = { enabled: scheduleEnabled, cron: scheduleCron }
    setScheduleEnabled(enabled)
    setScheduleCron(cron)
    try {
      await window.electronAPI.setMemorySchedule(workspaceRootPath, { enabled, cron })
      setError(null)
    } catch (err) {
      setScheduleEnabled(previous.enabled)
      setScheduleCron(previous.cron)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleConsolidate = async () => {
    if (!workspaceRootPath) return
    setIsConsolidating(true)
    setConsolidationProgress(null)
    setError(null)
    setSuccessMessage(null)
    try {
      const result = await window.electronAPI.consolidateMemories(workspaceRootPath)
      if (result.sessionsProcessed === 0) {
        setSuccessMessage(t('memory.nothingToConsolidate'))
      } else {
        setSuccessMessage(t('memory.consolidationResult', { promoted: result.promoted, trashed: result.trashed }))
      }
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsConsolidating(false)
    }
  }

  if (!workspaceRootPath) {
    return (
      <div className={cn('p-3 text-sm text-muted-foreground', className)}>
        {t('memory.notAvailable')}
      </div>
    )
  }

  const progressPercent = consolidationProgress && consolidationProgress.total > 0
    ? Math.round((consolidationProgress.done / consolidationProgress.total) * 100)
    : 0

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* ===================== Header ===================== */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Brain className="h-4 w-4 shrink-0 text-accent" />
          <h2 className="truncate text-sm font-semibold">
            {scope === 'session' ? t('memory.sessionTitle') : t('memory.globalTitle')}
          </h2>
          {stats && scope === 'global' && (
            <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
              {stats.totalEntries} {t('memory.entries')}
            </Badge>
          )}
          {scope === 'session' && memories.length > 0 && (
            <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
              {memories.length}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {scope === 'global' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 gap-1 text-xs', showTrash && 'bg-foreground/5')}
                onClick={() => setShowTrash(value => !value)}
                aria-label={showTrash ? t('memory.activeMemories') : t('memory.trash', { count: trash.length })}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {showTrash ? t('memory.activeMemories') : t('memory.trash', { count: trash.length })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleConsolidate}
                disabled={isConsolidating}
              >
                <Sparkles className={cn('h-3.5 w-3.5', isConsolidating && 'animate-spin')} />
                {t('memory.consolidate')}
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => setShowAddForm(value => !value)}
                disabled={isConsolidating}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('memory.add')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ===================== Search (session scope) ===================== */}
      {scope === 'session' && (
        <div className="shrink-0 px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label={t('memory.search')}
              placeholder={t('memory.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      )}

      {/* ===================== Filters (global, active memories) ===================== */}
      {scope === 'global' && !showTrash && (
        <div className="shrink-0 space-y-2 px-5 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[160px] flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t('memory.search')}
                placeholder={t('memory.search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as 'all' | MemoryType)}>
              <SelectTrigger aria-label={t('memory.filterByType')} className="h-8 w-[7.5rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('memory.filterAllTypes')}</SelectItem>
                {MEMORY_TYPES.map(type => (
                  <SelectItem key={type} value={type}>{typeLabel(type)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={timeRange} onValueChange={(value) => setTimeRange(value as TimeRangeFilter)}>
              <SelectTrigger aria-label={t('memory.filterByTime')} className="h-8 w-[7rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('memory.timeAll')}</SelectItem>
                <SelectItem value="day">{t('memory.timeLastDay')}</SelectItem>
                <SelectItem value="week">{t('memory.timeLastWeek')}</SelectItem>
                <SelectItem value="month">{t('memory.timeLastMonth')}</SelectItem>
                <SelectItem value="custom">{t('memory.timeCustom')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as SortOrder)}>
              <SelectTrigger aria-label={t('memory.sortBy')} className="h-8 w-[7rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">{t('memory.sortNewest')}</SelectItem>
                <SelectItem value="oldest">{t('memory.sortOldest')}</SelectItem>
              </SelectContent>
            </Select>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-xs text-muted-foreground"
                onClick={clearFilters}
              >
                <FilterX className="h-3.5 w-3.5" />
                {t('memory.clearFilters')}
              </Button>
            )}
          </div>

          {timeRange === 'custom' && (
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-normal">
                    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                    {customRange?.from
                      ? `${formatRangeDate(customRange.from)}${customRange.to ? ` ~ ${formatRangeDate(customRange.to)}` : ' ~ '}`
                      : t('memory.customRangePlaceholder')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start" sideOffset={6}>
                  <Calendar
                    mode="range"
                    selected={customRange}
                    onSelect={setCustomRange}
                    numberOfMonths={1}
                    defaultMonth={customRange?.from}
                    autoFocus
                  />
                </PopoverContent>
              </Popover>
              <span className="text-[11px] text-muted-foreground">
                {typeFilter === 'all' ? t('memory.filterAllTypes') : typeLabel(typeFilter)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ===================== Consolidation progress ===================== */}
      {isConsolidating && scope === 'global' && (
        <div className="mx-5 mb-3 shrink-0 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs font-medium text-accent">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('memory.consolidating')}
            </span>
            <span className="text-xs font-medium tabular-nums">
              {t('memory.consolidatingProgress', { done: consolidationProgress?.done ?? 0, total: consolidationProgress?.total ?? 0 })}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* ===================== Add form (global) ===================== */}
      {scope === 'global' && !showTrash && showAddForm && (
        <div className="mx-5 mb-3 shrink-0 rounded-lg border border-border/60 bg-background p-3 shadow-minimal">
          <div className="space-y-2">
            <select
              value={newMemoryType}
              onChange={(e) => setNewMemoryType(e.target.value as MemoryType)}
              className="h-8 w-full rounded-md border border-foreground/15 bg-background px-2 text-xs"
              aria-label={t('memory.filterByType')}
            >
              {MEMORY_TYPES.map(type => (
                <option key={type} value={type}>{typeLabel(type)}</option>
              ))}
            </select>
            <Input
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              placeholder={t('memory.addPlaceholder')}
              className="h-8 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && handleAddMemory()}
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => { setShowAddForm(false); setNewMemory('') }}
              >
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={handleAddMemory}>
                {t('common.add')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== Status messages ===================== */}
      {(error || successMessage) && (
        <div className="shrink-0 px-5 pb-2">
          {error && (
            <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}
          {successMessage && !error && (
            <div role="status" className="rounded-md border border-border/60 bg-foreground/3 px-2.5 py-1.5 text-xs text-muted-foreground">
              {successMessage}
            </div>
          )}
        </div>
      )}

      {/* ===================== Bulk delete bar (global) ===================== */}
      {scope === 'global' && !showTrash && selectedIds.length > 0 && (
        <div className="mx-5 mb-3 flex shrink-0 items-center justify-between rounded-lg border border-foreground/10 bg-foreground/3 px-3 py-2">
          <span className="text-xs">{t('memory.selected', { count: selectedIds.length })}</span>
          <Button variant="destructive" size="sm" className="h-7 gap-1 text-xs" onClick={handleBulkDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            {t('common.delete')}
          </Button>
        </div>
      )}

      {/* ===================== Schedule (global) ===================== */}
      {scope === 'global' && !showTrash && (
        <div className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={scheduleEnabled} onChange={event => { void saveSchedule(event.target.checked) }} />
            {t('memory.schedule')}
          </label>
          {scheduleEnabled && (
            <select value={scheduleCron} onChange={event => { void saveSchedule(true, event.target.value) }} className="h-7 rounded-md border border-foreground/15 bg-background px-2 text-xs">
              <option value="0 3 * * *">{t('memory.scheduleDaily')}</option>
              <option value="0 3 * * 0">{t('memory.scheduleWeekly')}</option>
            </select>
          )}
        </div>
      )}

      {/* ===================== List ===================== */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {isLoading && memories.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        ) : showTrash ? (
          trash.length === 0
            ? <MemoryEmptyState icon={<Trash2 className="h-5 w-5" />} label={t('memory.trashEmpty')} />
            : (
              <div className="space-y-1.5">
                {trash.map(({ entry }) => (
                  <div key={entry.id} className="flex items-start gap-2.5 rounded-lg border border-foreground/5 bg-background p-3 shadow-minimal transition-colors hover:border-foreground/15">
                    <Badge variant="outline" className={cn('shrink-0 text-[10px] px-1.5 py-0', TYPE_COLORS[entry.type])}>{typeLabel(entry.type)}</Badge>
                    <span className="min-w-0 flex-1 text-xs leading-relaxed break-words">{entry.content}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 text-muted-foreground"
                      onClick={async () => { await window.electronAPI.restoreMemory(workspaceRootPath!, entry.id); await loadMemories() }}
                      title={t('memory.restore')}
                      aria-label={t('memory.restore')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {trash.length > 0 && (
                  <div className="flex justify-end pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-muted-foreground"
                      onClick={async () => { await window.electronAPI.clearMemoryTrash(workspaceRootPath!); await loadMemories() }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('memory.emptyTrash')}
                    </Button>
                  </div>
                )}
              </div>
            )
        ) : filteredMemories.length === 0 ? (
          searchQuery || hasActiveFilters
            ? <MemoryEmptyState icon={<FilterX className="h-5 w-5" />} label={t('memory.noResults')} action={<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearFilters}>{t('memory.clearFilters')}</Button>} />
            : <MemoryEmptyState icon={<Brain className="h-5 w-5" />} label={t('memory.empty')} />
        ) : (
          <div className="space-y-1.5">
            {filteredMemories.map((memory) => (
              <div
                key={memory.id}
                role={scope === 'global' ? 'button' : undefined}
                tabIndex={scope === 'global' ? 0 : undefined}
                aria-pressed={scope === 'global' ? selectedIds.includes(memory.id) : undefined}
                onClick={(event) => scope === 'global' && toggleSelected(memory.id, event.ctrlKey || event.metaKey)}
                onKeyDown={(event) => {
                  if (scope === 'global' && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    toggleSelected(memory.id, event.ctrlKey || event.metaKey)
                  }
                }}
                className={cn(
                  'group flex items-start gap-2.5 rounded-lg border border-foreground/5 bg-background p-3 shadow-minimal transition-colors',
                  'hover:border-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selectedIds.includes(memory.id) && 'border-accent/40 bg-accent/5',
                )}
              >
                <Badge
                  variant="outline"
                  className={cn('mt-0.5 shrink-0 text-[10px] px-1.5 py-0', TYPE_COLORS[memory.type])}
                >
                  {typeLabel(memory.type)}
                </Badge>
                {editingId === memory.id ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Input autoFocus value={editContent} onChange={event => setEditContent(event.target.value)} className="h-7 text-xs" onKeyDown={event => event.key === 'Enter' && handleSaveEdit()} />
                    <select value={editType} onChange={event => setEditType(event.target.value as MemoryType)} className="h-7 rounded-md border border-foreground/15 bg-background px-2 text-xs">
                      {MEMORY_TYPES.map(type => <option key={type} value={type}>{typeLabel(type)}</option>)}
                    </select>
                    <div className="flex gap-1">
                      <Button size="sm" className="h-6 gap-1 text-xs" onClick={handleSaveEdit}><Check className="h-3 w-3" />{t('common.save')}</Button>
                      <Button size="sm" variant="ghost" className="h-6 gap-1 text-xs" onClick={() => setEditingId(null)}><X className="h-3 w-3" />{t('common.cancel')}</Button>
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] leading-relaxed break-words">{memory.content}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                      <span>{formatLastExtractionTime(memory.createdAt)}</span>
                      {memory.tags.length > 0 && (
                        <span className="truncate">#{memory.tags.slice(0, 3).join(' #')}{memory.tags.length > 3 ? '…' : ''}</span>
                      )}
                    </div>
                  </div>
                )}
                {editingId === memory.id ? null : (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                      onClick={(event) => { event.stopPropagation(); setEditingId(memory.id); setEditContent(memory.content); setEditType(memory.type) }}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id) }}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===================== Stats footer (global) ===================== */}
      {scope === 'global' && stats && (
        <div className="shrink-0 border-t border-border/40 px-5 py-2 text-center text-[10px] text-muted-foreground">
          {t('memory.extractions')}: {stats.totalExtractions}
          {stats.lastExtractionAt ? ` · ${formatLastExtractionTime(stats.lastExtractionAt)}` : ''}
        </div>
      )}
    </div>
  )
}

function MemoryEmptyState({ icon, label, action }: { icon: React.ReactNode; label: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground">
        {icon}
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {action}
    </div>
  )
}
