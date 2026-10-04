import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Brain, Trash2, Plus, Search, RefreshCw, RotateCcw, Pencil, Check, X, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

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

const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'workflow', 'reminder', 'context']

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

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  preference: 'bg-green-500/10 text-green-500 border-green-500/20',
  workflow: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  reminder: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  context: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
}

export function MemoryPanel({ workspaceRootPath, sessionId, scope = sessionId ? 'session' : 'global', className }: MemoryPanelProps) {
  const { t } = useTranslation()
  const [memories, setMemories] = React.useState<MemoryEntry[]>([])
  const [stats, setStats] = React.useState<MemoryStats | null>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(false)
  const [isExtracting, setIsExtracting] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null)
  const [newMemory, setNewMemory] = React.useState('')
  const [newMemoryType, setNewMemoryType] = React.useState<MemoryType>('fact')
  const [showAddForm, setShowAddForm] = React.useState(false)
  const [showTrash, setShowTrash] = React.useState(false)
  const [trash, setTrash] = React.useState<TrashedMemory[]>([])
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editContent, setEditContent] = React.useState('')
  const [editType, setEditType] = React.useState<MemoryType>('fact')
  const [isConsolidating, setIsConsolidating] = React.useState(false)
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

  React.useEffect(() => {
    loadMemories()
  }, [loadMemories])

  const filteredMemories = React.useMemo(() => {
    if (!searchQuery) return memories
    const query = searchQuery.toLowerCase()
    return memories.filter(m =>
      m.content.toLowerCase().includes(query) ||
      m.tags.some(tag => tag.toLowerCase().includes(query))
    )
  }, [memories, searchQuery])

  const handleAddMemory = async () => {
    if (!newMemory.trim() || !workspaceRootPath) return
    setIsSaving(true)
    setError(null)
    try {
      const add = scope === 'session' && sessionId
        ? window.electronAPI.addSessionMemory(workspaceRootPath, sessionId, {
          content: newMemory.trim(),
          type: newMemoryType,
          tags: [],
          confidence: 1.0,
        })
        : window.electronAPI.addMemory(workspaceRootPath, {
        content: newMemory.trim(),
        type: newMemoryType,
        tags: [],
        confidence: 1.0,
      })
      await add
      setNewMemory('')
      setShowAddForm(false)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
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
    if (scope === 'session' && sessionId) {
      await window.electronAPI.updateSessionMemory(workspaceRootPath, sessionId, editingId, { content: editContent.trim(), type: editType })
    } else {
      await window.electronAPI.updateMemory(workspaceRootPath, editingId, { content: editContent.trim(), type: editType })
    }
    setEditingId(null)
    await loadMemories()
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
    setError(null)
    setSuccessMessage(null)
    try {
      const result = await window.electronAPI.consolidateMemories(workspaceRootPath)
      setSuccessMessage(t('memory.consolidationResult', { promoted: result.promoted, trashed: result.trashed }))
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsConsolidating(false)
    }
  }

  const handleExtractMemories = async () => {
    if (!sessionId) return
    setIsExtracting(true)
    setError(null)
    try {
      await window.electronAPI.extractSessionMemories(sessionId)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExtracting(false)
    }
  }

  if (!workspaceRootPath) {
    return (
      <div className={cn('p-3 text-sm text-muted-foreground', className)}>
        {t('memory.notAvailable')}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-3 p-3', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium">{scope === 'session' ? t('memory.sessionTitle') : t('memory.globalTitle')}</span>
          {stats && (
            <Badge variant="secondary" className="text-xs">
              {stats.totalEntries} {t('memory.entries')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {scope === 'global' && (
            <>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleConsolidate} disabled={isConsolidating}>
                <Sparkles className={cn('h-3 w-3 mr-1', isConsolidating && 'animate-spin')} />{t('memory.consolidate')}
              </Button>
              <Button variant={showTrash ? 'secondary' : 'ghost'} size="sm" className="h-7 text-xs" onClick={() => setShowTrash(value => !value)}>
                <Trash2 className="h-3 w-3 mr-1" />{showTrash ? t('memory.activeMemories') : t('memory.trash', { count: trash.length })}
              </Button>
              {showTrash && trash.length > 0 && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={async () => { await window.electronAPI.clearMemoryTrash(workspaceRootPath!); await loadMemories() }}>
                  {t('memory.emptyTrash')}
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={loadMemories}
            disabled={isLoading}
            title={t('common.refresh')}
          >
            <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
          </Button>
          {sessionId && scope === 'session' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleExtractMemories}
              disabled={isExtracting}
              title={t('memory.extract')}
            >
              <Plus className={cn('h-3 w-3', isExtracting && 'animate-spin')} />
            </Button>
          )}
        </div>
      </div>

      {(scope === 'global' || memories.length > 0) && <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={t('memory.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 pl-8 text-xs"
        />
      </div>}

      {showAddForm && (
        <div className="space-y-2">
          <select
            value={newMemoryType}
            onChange={(e) => setNewMemoryType(e.target.value as MemoryType)}
            className="w-full h-8 px-2 text-xs rounded-md border border-border bg-background"
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
          />
          <div className="flex gap-1">
            <Button size="sm" className="h-7 text-xs" onClick={handleAddMemory} disabled={isSaving}>
              {t('common.add')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => { setShowAddForm(false); setNewMemory('') }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {scope === 'global' && !showTrash && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={scheduleEnabled} onChange={event => { void saveSchedule(event.target.checked) }} />
            {t('memory.schedule')}
          </label>
          {scheduleEnabled && (
            <select value={scheduleCron} onChange={event => { void saveSchedule(true, event.target.value) }} className="h-7 rounded-md border border-border bg-background px-2">
              <option value="0 3 * * *">{t('memory.scheduleDaily')}</option>
              <option value="0 3 * * 0">{t('memory.scheduleWeekly')}</option>
            </select>
          )}
        </div>
      )}

      {!showAddForm && !showTrash && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t('memory.add')}
        </Button>
      )}

      {scope === 'global' && !showTrash && selectedIds.length > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span>{t('memory.selected', { count: selectedIds.length })}</span>
          <Button variant="destructive" size="sm" className="h-7" onClick={handleBulkDelete}><Trash2 className="h-3 w-3 mr-1" />{t('common.delete')}</Button>
        </div>
      )}

      {error && (
        <div role="alert" className="text-xs text-destructive">{error}</div>
      )}
      {successMessage && (
        <div role="status" className="text-xs text-muted-foreground">{successMessage}</div>
      )}

      <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto">
        {showTrash ? (
          trash.length === 0 ? <div className="text-center py-4 text-xs text-muted-foreground">{t('memory.trashEmpty')}</div> : trash.map(({ entry }) => (
            <div key={entry.id} className="flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 text-xs">
              <Badge variant="outline" className={cn('shrink-0 text-[10px] px-1.5 py-0', TYPE_COLORS[entry.type])}>{typeLabel(entry.type)}</Badge>
              <span className="flex-1 leading-relaxed break-words">{entry.content}</span>
              <Button variant="ghost" size="sm" className="h-6" onClick={async () => { await window.electronAPI.restoreMemory(workspaceRootPath!, entry.id); await loadMemories() }} title={t('memory.restore')}><RotateCcw className="h-3 w-3" /></Button>
            </div>
          ))
        ) : filteredMemories.length === 0 ? (
          <div className="text-center py-4 text-xs text-muted-foreground">
            {searchQuery ? t('memory.noResults') : t('memory.empty')}
          </div>
        ) : (
          filteredMemories.map((memory) => (
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
              className={cn('group flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', selectedIds.includes(memory.id) && 'bg-muted/60')}
            >
              <Badge
                variant="outline"
                className={cn('shrink-0 text-[10px] px-1.5 py-0', TYPE_COLORS[memory.type])}
              >
                {typeLabel(memory.type)}
              </Badge>
              {editingId === memory.id ? (
                <div className="flex flex-1 flex-col gap-1">
                  <Input autoFocus value={editContent} onChange={event => setEditContent(event.target.value)} className="h-7 text-xs" onKeyDown={event => event.key === 'Enter' && handleSaveEdit()} />
                  <select value={editType} onChange={event => setEditType(event.target.value as MemoryType)} className="h-7 rounded-md border border-border bg-background px-2 text-xs">
                    {MEMORY_TYPES.map(type => <option key={type} value={type}>{typeLabel(type)}</option>)}
                  </select>
                </div>
              ) : <div className="flex-1 leading-relaxed break-words"><span>{memory.content}</span><div className="mt-1 text-[10px] text-muted-foreground">{formatLastExtractionTime(memory.createdAt)}</div></div>}
              {editingId === memory.id ? (
                <>
                  <button onClick={handleSaveEdit} title={t('common.save')}><Check className="h-3 w-3" /></button>
                  <button onClick={() => setEditingId(null)} title={t('common.cancel')}><X className="h-3 w-3" /></button>
                </>
              ) : <button onClick={event => { event.stopPropagation(); setEditingId(memory.id); setEditContent(memory.content); setEditType(memory.type) }} className="opacity-0 group-hover:opacity-100 text-muted-foreground" title={t('common.edit')}><Pencil className="h-3 w-3" /></button>}
              <button
                onClick={(event) => { event.stopPropagation(); handleDeleteMemory(memory.id) }}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                title={t('common.delete')}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>

      {stats && (
        <div className="shrink-0 text-[10px] text-muted-foreground text-center border-t border-border/40 pt-1.5">
          {t('memory.extractions')}: {stats.totalExtractions}
          {stats.lastExtractionAt ? ` · ${formatLastExtractionTime(stats.lastExtractionAt)}` : ''}
        </div>
      )}
    </div>
  )
}
