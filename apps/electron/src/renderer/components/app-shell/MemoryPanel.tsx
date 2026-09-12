import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Brain, Trash2, Plus, Search, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

interface MemoryPanelProps {
  workspaceRootPath?: string
  sessionId?: string
  className?: string
}

interface MemoryEntry {
  id: string
  type: 'fact' | 'preference' | 'workflow' | 'reminder' | 'context'
  content: string
  tags: string[]
  confidence: number
  createdAt: string
  sourceSessionId: string
}

interface MemoryStats {
  totalEntries: number
  entriesByType: Record<string, number>
  totalExtractions: number
  lastExtractionAt?: string
}

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  preference: 'bg-green-500/10 text-green-500 border-green-500/20',
  workflow: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  reminder: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  context: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
}

const TYPE_LABELS: Record<string, string> = {
  fact: 'Fact',
  preference: 'Preference',
  workflow: 'Workflow',
  reminder: 'Reminder',
  context: 'Context',
}

export function MemoryPanel({ workspaceRootPath, sessionId, className }: MemoryPanelProps) {
  const { t } = useTranslation()
  const [memories, setMemories] = React.useState<MemoryEntry[]>([])
  const [stats, setStats] = React.useState<MemoryStats | null>(null)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(false)
  const [isExtracting, setIsExtracting] = React.useState(false)
  const [newMemory, setNewMemory] = React.useState('')
  const [newMemoryType, setNewMemoryType] = React.useState<'fact' | 'preference' | 'workflow' | 'reminder' | 'context'>('fact')
  const [showAddForm, setShowAddForm] = React.useState(false)

  const loadMemories = React.useCallback(async () => {
    if (!workspaceRootPath) return
    setIsLoading(true)
    try {
      const result = await (window as any).electronAPI?.getMemoryStats?.(workspaceRootPath)
      if (result) {
        setStats(result.stats)
        setMemories(result.entries || [])
      }
    } catch (error) {
      console.error('Failed to load memories:', error)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceRootPath])

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
    try {
      await (window as any).electronAPI?.addMemory?.(workspaceRootPath, {
        content: newMemory.trim(),
        type: newMemoryType,
        tags: [],
        confidence: 1.0,
      })
      setNewMemory('')
      setShowAddForm(false)
      loadMemories()
    } catch (error) {
      console.error('Failed to add memory:', error)
    }
  }

  const handleDeleteMemory = async (id: string) => {
    if (!workspaceRootPath) return
    try {
      await (window as any).electronAPI?.deleteMemory?.(workspaceRootPath, id)
      loadMemories()
    } catch (error) {
      console.error('Failed to delete memory:', error)
    }
  }

  const handleExtractMemories = async () => {
    if (!sessionId) return
    setIsExtracting(true)
    try {
      await (window as any).electronAPI?.extractSessionMemories?.(sessionId)
      loadMemories()
    } catch (error) {
      console.error('Failed to extract memories:', error)
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
          <Brain className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">{t('memory.title')}</span>
          {stats && (
            <Badge variant="secondary" className="text-xs">
              {stats.totalEntries} {t('memory.entries')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={loadMemories}
            disabled={isLoading}
          >
            <RefreshCw className={cn('h-3 w-3', isLoading && 'animate-spin')} />
          </Button>
          {sessionId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={handleExtractMemories}
              disabled={isExtracting}
              title={t('memory.extract')}
            >
              <Plus className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={t('memory.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 pl-8 text-xs"
        />
      </div>

      {showAddForm && (
        <div className="space-y-2">
          <select
            value={newMemoryType}
            onChange={(e) => setNewMemoryType(e.target.value as any)}
            className="w-full h-8 px-2 text-xs rounded-md border border-border bg-background"
          >
            <option value="fact">{TYPE_LABELS.fact}</option>
            <option value="preference">{TYPE_LABELS.preference}</option>
            <option value="workflow">{TYPE_LABELS.workflow}</option>
            <option value="reminder">{TYPE_LABELS.reminder}</option>
            <option value="context">{TYPE_LABELS.context}</option>
          </select>
          <Input
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
            placeholder={t('memory.addPlaceholder')}
            className="h-8 text-xs"
            onKeyDown={(e) => e.key === 'Enter' && handleAddMemory()}
          />
          <div className="flex gap-1">
            <Button size="sm" className="h-7 text-xs" onClick={handleAddMemory}>
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

      {!showAddForm && (
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

      <div className="space-y-1.5 max-h-48 overflow-y-auto">
        {filteredMemories.length === 0 ? (
          <div className="text-center py-4 text-xs text-muted-foreground">
            {searchQuery ? t('memory.noResults') : t('memory.empty')}
          </div>
        ) : (
          filteredMemories.map((memory) => (
            <div
              key={memory.id}
              className="group flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 text-xs"
            >
              <Badge
                variant="outline"
                className={cn('shrink-0 text-[10px] px-1.5 py-0', TYPE_COLORS[memory.type])}
              >
                {TYPE_LABELS[memory.type]}
              </Badge>
              <span className="flex-1 leading-relaxed break-words">{memory.content}</span>
              <button
                onClick={() => handleDeleteMemory(memory.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                title={t('common.delete')}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>

      {stats?.lastExtractionAt && (
        <div className="text-[10px] text-muted-foreground text-center">
          {t('memory.extractions')}: {stats.totalExtractions} · {stats.lastExtractionAt}
        </div>
      )}
    </div>
  )
}
