/**
 * DomainWikiView — one memory domain's wiki in three faces:
 * 图 (radial knowledge graph) / 实体 (typed entity list) / 原文 (markdown).
 *
 * Consumed by:
 *   - agent detail (the agent's own personal domain)
 *   - project detail (the project's shared domain — read-only)
 *
 * It previously lived only in the 设置/记忆 page; that page now hosts the
 * global switch, the 记忆整理 strategy group, the dreaming schedule, and the
 * embedding model config, while the domain views moved next to the things
 * they document.
 *
 * Domain files are read-only here: they are produced by the memory pipeline
 * (dreaming + curation), not hand-edited in the UI.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Lock, UserRound } from 'lucide-react'

import { Info_Markdown } from '@/components/info/Info_Markdown'
import { cn } from '@/lib/utils'

import { parseWiki, KIND_HUES, kindLabel, type WikiModel } from '@/pages/settings/memory-wiki'
import { MemoryWikiGraph } from '@/pages/settings/MemoryWikiGraph'

type DomainContent = {
  exists: boolean
  content: string
  truncated: boolean
  loading: boolean
}

type ViewTab = 'graph' | 'entities' | 'raw'

interface DomainWikiViewProps {
  workspaceId: string
  /** Domain slug (personal = sanitized agent id; project = the project's own slug). */
  slug: string
  /** Personal domains get a person badge; project domains a lock (read-only). */
  kind?: 'personal' | 'project'
  className?: string
}

export function DomainWikiView({ workspaceId, slug, kind, className }: DomainWikiViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const [content, setContent] = React.useState<DomainContent | null>(null)
  const [viewTab, setViewTab] = React.useState<ViewTab>('graph')
  const [selectedEntity, setSelectedEntity] = React.useState<string | null>(null)

  // One domain's registry row (path + kind) — the content read is keyed by slug.
  const [domainPath, setDomainPath] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    let cancelled = false
    setViewTab('graph')
    setSelectedEntity(null)
    setContent(null)
    void window.electronAPI
      .memoryDomains(workspaceId)
      .then((table) => {
        if (cancelled) return
        setDomainPath(table.domains.find((d) => d.slug === slug)?.path)
      })
      .catch(() => undefined)
    void window.electronAPI
      .memoryDomainsRead(workspaceId, slug)
      .then((result) => {
        if (cancelled) return
        setContent({ exists: result.exists, content: result.content, truncated: result.truncated, loading: false })
      })
      .catch(() => {
        if (!cancelled) setContent({ exists: false, content: '', truncated: false, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, slug])

  const wiki: WikiModel | null = content?.exists && content.content ? parseWiki(content.content, slug) : null
  const selected = wiki?.entities.find((e) => e.id === selectedEntity) ?? null
  const selectedSection = selected && wiki ? wiki.sections.find((s) => s.id === selected.sectionId) : null

  if (content?.loading) {
    return (
      <div className={cn('px-1 py-3 text-[12px] text-muted-foreground', className)}>
        {t('settings.memory.loading', { defaultValue: '读取中…' })}
      </div>
    )
  }

  if (!content || !content.exists) {
    return (
      <div className={cn('px-1 py-2', className)}>
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/50 px-3 py-3 text-[12px] text-muted-foreground">
          {kind === 'project' ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <UserRound className="h-3.5 w-3.5" aria-hidden />}
          {t('settings.memory.empty', { defaultValue: '这个域还没有记忆积累（文件尚未生成）' })}
          {domainPath ? (
            <span className="ml-auto max-w-[45%] truncate font-mono text-[10px]">{domainPath}</span>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('px-1 py-1', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <FileText className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate font-mono text-[10px]">{domainPath ?? slug}</span>
        </div>
        <div className="flex shrink-0 rounded-md border border-border/50 bg-background p-0.5">
          {(['graph', 'entities', 'raw'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setViewTab(tab)
                setSelectedEntity(null)
              }}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                viewTab === tab ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              {tab === 'graph'
                ? t('settings.memory.tabGraph', { defaultValue: '图' })
                : tab === 'entities'
                  ? t('settings.memory.tabEntities', { defaultValue: '实体' })
                  : t('settings.memory.tabRaw', { defaultValue: '原文' })}
            </button>
          ))}
        </div>
      </div>

      {viewTab === 'graph' && wiki ? (
        <>
          <MemoryWikiGraph
            model={wiki}
            domainSlug={slug}
            selectedEntityId={selectedEntity}
            onSelectEntity={setSelectedEntity}
          />
          {selected ? (
            <div className="mt-2 rounded-lg border border-border/50 bg-background/70 px-3 py-2">
              <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {selectedSection ? (
                  <>
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: `hsl(${selectedSection.hue} 45% 50%)` }}
                    />
                    {selectedSection.title}
                  </>
                ) : null}
                <span
                  className="rounded-full px-1.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: `hsl(${KIND_HUES[selected.kind]} 50% 45% / 0.15)`,
                    color: `hsl(${KIND_HUES[selected.kind]} 50% 38%)`,
                  }}
                >
                  {kindLabel(selected.kind)}
                </span>
              </div>
              <p className="text-[12px] leading-relaxed text-foreground/85">{selected.text}</p>
            </div>
          ) : null}
        </>
      ) : null}

      {viewTab === 'entities' && wiki ? (
        <div className="space-y-3 px-1 py-1">
          {wiki.sections
            .filter((s) => s.entities.length > 0)
            .map((section) => (
              <div key={section.id}>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: `hsl(${section.hue} 45% 50%)` }} />
                  {section.title}
                  <span className="text-[10px] text-muted-foreground/60">{section.entities.length}</span>
                </div>
                <ul className="space-y-1 pl-3.5">
                  {section.entities.map((entity) => (
                    <li key={entity.id} className="flex items-start gap-2 text-[12px] leading-snug">
                      <span
                        className="mt-px shrink-0 rounded-full px-1.5 text-[10px] font-medium"
                        style={{
                          backgroundColor: `hsl(${KIND_HUES[entity.kind]} 50% 45% / 0.15)`,
                          color: `hsl(${KIND_HUES[entity.kind]} 50% 38%)`,
                        }}
                      >
                        {kindLabel(entity.kind)}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-foreground/80">{entity.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {wiki.entities.length === 0 && (
            <p className="px-1 py-2 text-[12px] text-muted-foreground">
              {t('settings.memory.noEntities', {
                defaultValue: '没有结构化的条目（正文以段落为主）——看「原文」',
              })}
            </p>
          )}
        </div>
      ) : null}

      {viewTab === 'raw' && (
        <Info_Markdown mode="full" maxHeight={320}>
          {content.content}
        </Info_Markdown>
      )}

      {content.truncated && (
        <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          {t('settings.memory.truncated', { defaultValue: '内容超过 200KB，仅显示开头部分' })}
        </div>
      )}
    </div>
  )
}
