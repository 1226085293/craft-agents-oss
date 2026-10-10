/**
 * MemoryDataPanel — §5.4 data-management surface (redesigned 2026-10-10):
 * - Audit tab: blocked/shadow trail (read-only)
 * - Vocabulary tab: chip-style editing (add/remove/toggle priority ★, instant save)
 * - Snapshots tab: backup list w/ timestamp, restore + delete
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Plus, X, Star } from 'lucide-react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface BlockedRecordView {
  candidateContent: string
  candidateType: string
  matchedGlobalId?: string
  matchedContent?: string
  verdict: string
  reason: string
  shadow: boolean
  blockedAt: string
  sourceSessionId?: string
}

interface MemoryDataPanelProps {
  workspaceRootPath: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const VERDICT_COLORS: Record<string, string> = {
  duplicate: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
  conflict: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  update: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  'unrelated-shadow': 'bg-slate-500/10 text-slate-400 border-foreground/10',
  'l1-fallback': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  sensitive: 'bg-red-500/10 text-red-500 border-red-500/20',
}

export function MemoryDataPanel({ workspaceRootPath, open, onOpenChange }: MemoryDataPanelProps) {
  const { t } = useTranslation()
  const [blocked, setBlocked] = React.useState<BlockedRecordView[]>([])
  const [backups, setBackups] = React.useState<Array<{ index: number; updatedAt: string; size: number }>>([])
  const [vocab, setVocab] = React.useState<string[]>([])
  const [prio, setPrio] = React.useState<string[]>([])
  const [newTag, setNewTag] = React.useState('')
  const [vocabQuery, setVocabQuery] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [restoring, setRestoring] = React.useState<number | null>(null)

  const loadData = React.useCallback(async () => {
    if (!workspaceRootPath) return
    try {
      const [blockedRes, backupRes, vocabRes] = await Promise.all([
        window.electronAPI.getMemoryBlocked(workspaceRootPath),
        window.electronAPI.listMemoryBackups(workspaceRootPath),
        window.electronAPI.getMemoryVocabulary(workspaceRootPath),
      ])
      setBlocked(blockedRes.blocked ?? [])
      setBackups(backupRes.backups ?? [])
      setVocab((vocabRes.tagVocabulary ?? []).slice())
      setPrio((vocabRes.priorityTags ?? []).slice())
      setSaveError(null)
    } catch {
      // ignore — panel is informational
    }
  }, [workspaceRootPath])

  React.useEffect(() => {
    if (open) void loadData()
  }, [open, loadData])

  const persist = async (nextVocab: string[], nextPrio: string[]) => {
    if (!workspaceRootPath) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await window.electronAPI.setMemoryVocabulary(workspaceRootPath, {
        tagVocabulary: nextVocab,
        priorityTags: nextPrio,
      })
      if (res && !res.ok) setSaveError(t('memory.saveFailed', { defaultValue: 'Save failed.' }))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const addTag = () => {
    const tag = newTag.trim().toLowerCase()
    if (!tag || vocab.includes(tag)) return
    const next = [...vocab, tag]
    setVocab(next)
    setNewTag('')
    void persist(next, prio)
  }

  const removeTag = (tag: string) => {
    const nextVocab = vocab.filter(x => x !== tag)
    const nextPrio = prio.filter(x => x !== tag)
    setVocab(nextVocab)
    setPrio(nextPrio)
    void persist(nextVocab, nextPrio)
  }

  const togglePrio = (tag: string) => {
    const nextPrio = prio.includes(tag) ? prio.filter(x => x !== tag) : [...prio, tag]
    setPrio(nextPrio)
    void persist(vocab, nextPrio)
  }

  // Vocabulary can grow large (hundreds of tags). Render chips lazily:
  // without a search query only the first batch is shown, with a count hint.
  const VOCAB_RENDER_LIMIT = 100
  const renderVocabChips = (query: string) => {
    const q = query.trim().toLowerCase()
    if (vocab.length === 0) {
      return <p className="p-1 text-xs text-muted-foreground">{t('memory.noTags', { defaultValue: 'No tags yet.' })}</p>
    }
    const filtered = q ? vocab.filter(tag => tag.includes(q)) : vocab
    const shown = q ? filtered : filtered.slice(0, VOCAB_RENDER_LIMIT)
    const chips = shown.map(tag => {
      const isPrio = prio.includes(tag)
      return (
        <Badge key={tag} variant="secondary" className={cn('gap-0.5 px-1.5 py-0 text-xs', isPrio && 'border-emerald-500/40 text-emerald-600')}>
          <button
            type="button"
            aria-label={t('memory.togglePriority', { defaultValue: 'Toggle priority' })}
            className={cn('flex h-4 w-4 items-center justify-center rounded-sm hover:bg-foreground/10', !isPrio && 'opacity-45 hover:opacity-100')}
            onClick={() => togglePrio(tag)}
          >
            <Star className={cn('h-3 w-3', isPrio && 'fill-current')} />
          </button>
          <span>{tag}</span>
          <button
            type="button"
            aria-label={t('memory.removeTag', { defaultValue: 'Remove tag' })}
            className="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => removeTag(tag)}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      )
    })
    if (!q && filtered.length > shown.length) {
      chips.push(
        <span key="__more" className="w-full pt-1 text-[11px] text-muted-foreground">
          {t('memory.vocabMore', { defaultValue: '…and {{count}} more (type to filter)', count: String(filtered.length - shown.length) })}
        </span>,
      )
    }
    return chips
  }

  const handleRestore = async (index: number) => {
    if (!workspaceRootPath || restoring !== null) return
    setRestoring(index)
    try {
      await window.electronAPI.restoreMemoryBackup(workspaceRootPath, index)
      await loadData()
    } finally {
      setRestoring(null)
    }
  }

  const handleDeleteBackup = async (index: number) => {
    if (!workspaceRootPath || restoring !== null) return
    setRestoring(index)
    try {
      const res = await window.electronAPI.deleteMemoryBackup(workspaceRootPath, index)
      if (res && !res.ok) console.warn('delete backup failed:', res.reason)
      await loadData()
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('memory.dataManagement', { defaultValue: 'Memory data management' })}</DialogTitle>
          <DialogDescription>
            {t('memory.dataManagementDesc', { defaultValue: 'Audit, vocabulary and snapshot recovery.' })}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="audit" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 justify-start">
            <TabsTrigger value="audit">{t('memory.tabAudit', { defaultValue: 'Audit' })} ({blocked.length})</TabsTrigger>
            <TabsTrigger value="vocab">{t('memory.tabVocab', { defaultValue: 'Vocabulary' })}</TabsTrigger>
            <TabsTrigger value="snapshots">{t('memory.tabSnapshots', { defaultValue: 'Snapshots' })}</TabsTrigger>
          </TabsList>

          {/* ── Audit: blocked & shadow trail ─────────────────────────── */}
          <TabsContent value="audit" className="min-h-0 flex-1">
            <ScrollArea className="max-h-56 rounded-md border border-foreground/10">
              {blocked.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">{t('memory.blockedEmpty', { defaultValue: 'No blocked records yet.' })}</p>
              ) : (
                <ul className="flex flex-col gap-1 p-2">
                  {blocked.map((record, i) => (
                    <li key={i} className="flex flex-col gap-0.5 rounded-md border border-foreground/5 bg-background/60 p-2">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={cn('px-1.5 py-0 text-xs', VERDICT_COLORS[record.verdict] ?? VERDICT_COLORS['unrelated-shadow'])}>
                          {record.verdict}
                        </Badge>
                        {record.shadow ? <Badge variant="outline" className="px-1.5 py-0 text-xs">shadow</Badge> : null}
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{new Date(record.blockedAt).toLocaleString()}</span>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{record.candidateContent}</p>
                      {record.reason ? <p className="text-xs text-muted-foreground/70">{record.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </TabsContent>

          {/* ── Vocabulary: chip editing with instant save ────────────── */}
          <TabsContent value="vocab">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-foreground/70">
                  {t('memory.vocabulary', { defaultValue: 'Controlled tag vocabulary' })}
                  <span className="ml-1.5 font-normal text-muted-foreground">{vocab.length}</span>
                </h4>
                {saving ? <span className="text-xs text-muted-foreground">{t('memory.saving', { defaultValue: 'Saving…' })}</span> : null}
              </div>

              <div className="max-h-40 overflow-y-auto rounded-md border border-foreground/10 p-2">
                {vocab.length === 0 ? (
                  <p className="p-1 text-xs text-muted-foreground">{t('memory.noTags', { defaultValue: 'No tags yet.' })}</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={vocabQuery}
                        onChange={e => setVocabQuery(e.target.value)}
                        placeholder={t('memory.vocabSearchPlaceholder', { defaultValue: 'Filter tags…' })}
                        className="h-6 flex-1 text-xs"
                        aria-label={t('memory.vocabSearchPlaceholder', { defaultValue: 'Filter tags…' })}
                      />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {renderVocabChips(vocabQuery)}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addTag() }}
                  placeholder={t('memory.vocabAddPlaceholder', { defaultValue: 'Add tag, press Enter' })}
                  className="h-7 flex-1 text-xs"
                  aria-label={t('memory.vocabAddPlaceholder', { defaultValue: 'Add tag, press Enter' })}
                />
                <Button size="sm" className="h-7 shrink-0 gap-1 text-xs" onClick={addTag} disabled={saving}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('memory.addTag', { defaultValue: 'Add' })}
                </Button>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('memory.priorityHint', {
                  defaultValue: 'Star a tag to make it a priority tag (+5 score). Priority tags must be a subset of the vocabulary; changes save instantly.',
                })}
              </p>
              {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
            </div>
          </TabsContent>

          {/* ── Snapshots: backups w/ timestamp, restore + delete ─────── */}
          <TabsContent value="snapshots">
            {backups.length === 0 ? (
              <p className="p-1 text-xs text-muted-foreground">{t('memory.snapshotsEmpty', { defaultValue: 'No snapshots yet (created on each save).' })}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {backups.map(backup => (
                  <li key={backup.index} className="flex items-center gap-2 rounded-md border border-foreground/5 px-2 py-1.5">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs">memory.backup.{backup.index}.json</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {backup.updatedAt ? new Date(backup.updatedAt).toLocaleString() : '—'}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{(backup.size / 1024).toFixed(1)} KB</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-7 shrink-0 text-xs"
                      disabled={restoring !== null}
                      onClick={async () => {
                        if (!window.confirm(t('memory.restoreSnapshotConfirm', { defaultValue: 'Restore this snapshot? The current memory.json is rotated into a new backup first.' }))) return
                        await handleRestore(backup.index)
                      }}
                    >
                      {restoring === backup.index ? '…' : t('memory.restore', { defaultValue: 'Restore' })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 text-xs text-destructive hover:text-destructive"
                      disabled={restoring !== null}
                      onClick={async () => {
                        if (!window.confirm(t('memory.deleteSnapshotConfirm', { defaultValue: 'Delete this snapshot backup file?' }))) return
                        await handleDeleteBackup(backup.index)
                      }}
                    >
                      {restoring === backup.index ? '…' : t('memory.deleteSnapshot', { defaultValue: 'Delete' })}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close', { defaultValue: 'Close' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
