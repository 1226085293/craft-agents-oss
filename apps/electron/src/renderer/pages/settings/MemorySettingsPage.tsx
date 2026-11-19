/**
 * MemorySettingsPage
 *
 * The memory-domain registry, the 记忆 wiki itself, and the dreaming (记忆整合)
 * schedule. Every domain's MEMORY.md is viewable here in three faces —
 * 图 (radial knowledge graph), 实体 (typed entity list), 原文 (markdown) —
 * so the wiki is finally something you can LOOK AT, not just a file.
 *
 * 做梦: the backend scheduler consolidates scattered session memories into
 * the domains on a cron. This page is its only UI: enable/toggle, cron +
 * timezone, run-now with live progress, and cancel.
 *
 * Domain files are read-only here (curated by the memory pipeline, not
 * hand-edited in the UI).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileText, Lock, UserRound, Zap, X } from 'lucide-react'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Info_Markdown } from '@/components/info/Info_Markdown'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'

import { SettingsCard, SettingsSection } from '@/components/settings'
import { parseWiki, KIND_HUES, kindLabel } from './memory-wiki'
import { MemoryWikiGraph } from './MemoryWikiGraph'

import type { MemoryDomainDef } from '@craft-agent/shared/memory'

type DomainContent = {
  exists: boolean
  content: string
  truncated: boolean
  loading: boolean
}

type ViewTab = 'graph' | 'entities' | 'raw'

interface DreamState {
  enabled: boolean
  cron: string
  timezone: string
}

interface DreamRun {
  active: boolean
  done: number
  total: number
  phase: 'running' | 'done' | 'cancelled' | 'error'
  promoted: number
  trashed: number
  message?: string
}

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'memory',
}

const DEFAULT_TZ = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'

export default function MemorySettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()

  const [domains, setDomains] = React.useState<MemoryDomainDef[]>([])
  const [agentNames, setAgentNames] = React.useState<Record<string, string[]>>({})
  const [openDomain, setOpenDomain] = React.useState<string | null>(null)
  const [contents, setContents] = React.useState<Record<string, DomainContent>>({})
  const [loadError, setLoadError] = React.useState(false)
  const [viewTab, setViewTab] = React.useState<ViewTab>('graph')
  const [selectedEntity, setSelectedEntity] = React.useState<string | null>(null)

  // 做梦 (dreaming) — schedule + live run state
  const [dream, setDream] = React.useState<DreamState | null>(null)
  const [dreamDirty, setDreamDirty] = React.useState(false)
  const [dreamSaving, setDreamSaving] = React.useState(false)
  const [run, setRun] = React.useState<DreamRun | null>(null)

  React.useEffect(() => {
    if (!workspace) return
    let cancelled = false
    ;(async () => {
      try {
        const [table, agents] = await Promise.all([
          window.electronAPI.memoryDomains(workspace.id),
          window.electronAPI.agentsList(workspace.id),
        ])
        if (cancelled) return
        // Reverse index: domain slug → the assistants writing to it.
        const byDomain: Record<string, string[]> = {}
        for (const agent of agents) {
          if (agent.memoryDomain) {
            ;(byDomain[agent.memoryDomain] ??= []).push(agent.name || agent.id)
          }
        }
        setDomains(table.domains)
        setAgentNames(byDomain)
        setLoadError(false)
      } catch {
        if (!cancelled) setLoadError(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace?.id])

  // Load the dreaming schedule (memory store is keyed by root path, not id).
  React.useEffect(() => {
    const rootPath = workspace?.rootPath
    if (!rootPath) return
    let cancelled = false
    void window.electronAPI
      .getMemorySchedule(rootPath)
      .then((s) => {
        if (cancelled) return
        setDream({ enabled: s.enabled, cron: s.cron, timezone: s.timezone || DEFAULT_TZ() })
      })
      .catch(() => undefined)
    void window.electronAPI
      .getConsolidationState(rootPath)
      .then((s) => {
        if (cancelled) return
        // Only surface LIVE runs; a stale last-run state would just render as
        // idle noise (「已整理 0/0」) on a page nobody is consolidating on.
        if (s.active) {
          setRun({ active: true, done: s.done, total: s.total, phase: 'running', promoted: 0, trashed: 0 })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspace?.id, workspace?.rootPath])

  // Live consolidation progress (workspace-wide broadcast).
  React.useEffect(() => {
    const off = window.electronAPI.onMemoryConsolidationProgress((p) => {
      setRun({
        active: p.phase === 'running',
        done: p.done,
        total: p.total,
        phase: p.phase,
        promoted: p.promoted,
        trashed: p.trashed,
        message: p.message,
      })
    })
    return off
  }, [])

  // Debounced schedule autosave (same discipline as the channel gate panel).
  React.useEffect(() => {
    if (!dreamDirty || !dream || !workspace) return
    const timer = setTimeout(() => {
      setDreamSaving(true)
      void window.electronAPI
        .setMemorySchedule(workspace.rootPath, {
          enabled: dream.enabled,
          cron: dream.cron.trim() || '0 3 * * *',
          timezone: dream.timezone || undefined,
        })
        .catch(() => undefined)
        .finally(() => {
          setDreamSaving(false)
          setDreamDirty(false)
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [dream, dreamDirty, workspace?.id, workspace?.rootPath])

  const toggleDomain = (slug: string): void => {
    const nextOpen = openDomain === slug ? null : slug
    setOpenDomain(nextOpen)
    setSelectedEntity(null)
    setViewTab('graph')
    if (nextOpen && !contents[slug]?.loading && contents[slug]?.content === undefined) {
      void loadContent(slug)
    }
  }

  const loadContent = async (slug: string): Promise<void> => {
    if (!workspace) return
    setContents((prev) => ({ ...prev, [slug]: { exists: false, content: '', truncated: false, loading: true } }))
    try {
      const result = await window.electronAPI.memoryDomainsRead(workspace.id, slug)
      setContents((prev) => ({ ...prev, [slug]: { exists: result.exists, content: result.content, truncated: result.truncated, loading: false } }))
    } catch {
      setContents((prev) => ({ ...prev, [slug]: { exists: false, content: '', truncated: false, loading: false } }))
    }
  }

  const runDreamNow = async (): Promise<void> => {
    if (!workspace) return
    const result = await window.electronAPI.consolidateMemories(workspace.rootPath).catch(() => null)
    if (result) {
      setRun({ active: true, done: 0, total: result.total, phase: 'running', promoted: 0, trashed: 0 })
    }
  }

  const cancelDream = async (): Promise<void> => {
    if (!workspace) return
    await window.electronAPI.cancelConsolidateMemories(workspace.rootPath).catch(() => undefined)
  }

  const patchDream = (patch: Partial<DreamState>): void => {
    setDream((prev) => (prev ? { ...prev, ...patch } : prev))
    setDreamDirty(true)
  }

  if (!workspace) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t('settings.memory.title', { defaultValue: '记忆' })} actions={<HeaderMenu route={routes.view.settings('memory')} />} />
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {t('settings.memory.noWorkspace', { defaultValue: '没有活动的工作区' })}
        </div>
      </div>
    )
  }

  const personal = domains.filter((d) => d.kind !== 'project')
  const shared = domains.filter((d) => d.kind === 'project')

  const renderDomainRow = (domain: MemoryDomainDef): React.ReactNode => {
    const isOpen = openDomain === domain.slug
    const content = contents[domain.slug]
    const owners = agentNames[domain.slug] ?? []
    const wiki = isOpen && content?.exists && content.content ? parseWiki(content.content, domain.slug) : null
    const selected = wiki?.entities.find((e) => e.id === selectedEntity)
    const selectedSection = selected ? wiki!.sections.find((s) => s.id === selected.sectionId) : null

    return (
      <div key={domain.slug}>
        <button
          type="button"
          onClick={() => toggleDomain(domain.slug)}
          className={cn(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
            'hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring',
            isOpen && 'bg-accent/40',
          )}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60">
            {domain.kind === 'project' ? (
              <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
            ) : (
              <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{domain.slug}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[10px] font-medium',
                  domain.kind === 'project'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-foreground/[0.06] text-foreground/70',
                )}
              >
                {domain.kind === 'project'
                  ? t('settings.memory.kindShared', { defaultValue: '共享 · 只读' })
                  : t('settings.memory.kindPersonal', { defaultValue: '个人域' })}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {owners.length > 0 ? (
                <>
                  {t('settings.memory.ownersLabel', { defaultValue: '写入助手：' })}
                  {owners.join('、')}
                </>
              ) : (
                t('settings.memory.noOwner', { defaultValue: '未指定助手（缺省落个人域兜底）' })
              )}
            </span>
          </span>
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} aria-hidden />
        </button>

        {isOpen && (
          <div className="mx-3 mb-2 mt-1 rounded-lg border border-border/50 bg-background/50">
            {!content?.loading && content?.exists === false && (
              <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
                <FileText className="h-3.5 w-3.5" aria-hidden />
                {t('settings.memory.empty', { defaultValue: '这个域还没有记忆积累（文件尚未生成）' })}
                {domain.path ? <span className="ml-auto max-w-[45%] truncate font-mono text-[10px]">{domain.path}</span> : null}
              </div>
            )}
            {!content?.loading && content?.exists === true && (
              <div className="px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                    <FileText className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate font-mono text-[10px]">{domain.path}</span>
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
                          viewTab === tab
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-muted/60',
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
                      domainSlug={domain.slug}
                      selectedEntityId={selectedEntity}
                      onSelectEntity={setSelectedEntity}
                    />
                    {selected ? (
                      <div className="mx-3 mb-2 rounded-lg border border-border/50 bg-background/70 px-3 py-2">
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
            )}
            {content?.loading && (
              <div className="px-3 py-3 text-[12px] text-muted-foreground">
                {t('settings.memory.loading', { defaultValue: '读取中…' })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.memory.title', { defaultValue: '记忆' })} actions={<HeaderMenu route={routes.view.settings('memory')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {loadError && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
                  {t('settings.memory.loadFailed', { defaultValue: '记忆域读取失败' })}
                </div>
              )}

              <SettingsSection
                title={t('settings.memory.personal', { defaultValue: '个人域' })}
                description={t('settings.memory.personalDesc', { defaultValue: '每个助手一个可写域；助手卡「记忆域」下拉指定，未指定时缺省落个人域。' })}
              >
                <SettingsCard>
                  {personal.length === 0 ? (
                    <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {t('settings.memory.noPersonal', { defaultValue: '还没有个人域' })}
                    </div>
                  ) : (
                    personal.map(renderDomainRow)
                  )}
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.memory.shared', { defaultValue: '共享 · 项目域' })}
                description={t('settings.memory.sharedDesc', { defaultValue: '项目 MEMORY.md 自动注册为共享只读域（零搬家）；写入口径随阶段 4 定。' })}
              >
                <SettingsCard>
                  {shared.length === 0 ? (
                    <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {t('settings.memory.noShared', { defaultValue: '还没有共享域' })}
                    </div>
                  ) : (
                    shared.map(renderDomainRow)
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* 做梦（记忆整合）：定时 + 立即 + 实时进度。 */}
              <SettingsSection
                title={t('settings.memory.dreaming', { defaultValue: '做梦 · 记忆整合' })}
                description={t('settings.memory.dreamingDesc', {
                  defaultValue: '定时把会话里的零散记忆整理进记忆域。后端调度器按 cron 执行，也可立即整理。',
                })}
              >
                <SettingsCard>
                  {dream ? (
                    <div className="space-y-3 p-3">
                      <label className="flex items-center gap-2 text-[13px]">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={dream.enabled}
                          onChange={(e) => patchDream({ enabled: e.target.checked })}
                        />
                        {t('settings.memory.dreamEnabled', { defaultValue: '启用定时做梦' })}
                      </label>
                      {/*
                        * 启用开关直接决定显隐（与 agent 面板分工说明同一原则）：
                        * 关 → 周期/时区行收起、留一行空态；开 → 展开。
                        * 已配好的 cron/时区存于 dream state 不丢，重新开启即恢复。
                        */}
                      {dream.enabled ? (
                      <>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <label className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">
                            {t('settings.memory.dreamCron', { defaultValue: '周期' })}
                          </span>
                          <input
                            value={dream.cron}
                            onChange={(e) => patchDream({ cron: e.target.value })}
                            className="h-7 w-36 rounded-md border border-input bg-background px-2 font-mono text-[12px]"
                            aria-label={t('settings.memory.dreamCron', { defaultValue: '周期（cron）' })}
                          />
                        </label>
                        <label className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">
                            {t('settings.memory.dreamTimezone', { defaultValue: '时区' })}
                          </span>
                          <input
                            value={dream.timezone}
                            onChange={(e) => patchDream({ timezone: e.target.value })}
                            className="h-7 w-36 rounded-md border border-input bg-background px-2 text-[12px]"
                            aria-label={t('settings.memory.dreamTimezone', { defaultValue: '时区' })}
                          />
                        </label>
                      </div>
                      <p className="text-[10px] text-muted-foreground/60">
                        {t('settings.memory.dreamCronHint', { defaultValue: '例：0 3 * * * = 每天 03:00（按所选时区）' })}
                      </p>
                      </>
                      ) : (
                      <div className="rounded-md border border-dashed border-input bg-muted/30 p-2.5 text-xs text-muted-foreground">
                        {t('settings.memory.dreamDisabledNote', {
                          defaultValue: '关闭时定时任务不会运行；「立即整理」不受影响，随时可手动整理',
                        })}
                        {/* 收起 ≠ 数据不存在：把排班值露出来，关着也看得见“排的是什么班”。 */}
                        <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                          {t('settings.memory.dreamDisabledSchedule', {
                            defaultValue: '当前周期 {{cron}} · 时区 {{timezone}}（开启后生效）',
                            cron: dream.cron.trim() || '0 3 * * *',
                            timezone: dream.timezone,
                          })}
                        </div>
                      </div>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        {run?.active ? (
                          <>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-foreground/70 transition-all duration-500"
                                style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }}
                              />
                            </div>
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {run.done}/{run.total}
                            </span>
                            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void cancelDream()}>
                              <X className="h-3 w-3" aria-hidden />
                              {t('settings.memory.dreamCancel', { defaultValue: '取消' })}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void runDreamNow()}>
                            <Zap className="h-3.5 w-3.5" aria-hidden />
                            {t('settings.memory.dreamNow', { defaultValue: '立即整理' })}
                          </Button>
                        )}
                        {dreamSaving ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('settings.memory.dreamSaving', { defaultValue: '保存中…' })}
                          </span>
                        ) : null}
                        {run && !run.active && run.phase === 'done' && (run.promoted > 0 || run.trashed > 0) ? (
                          <span className="text-[11px] text-success">
                            {t('settings.memory.dreamDone', {
                              defaultValue: '已整理：晋升 {{promoted}} · 清理 {{trashed}}',
                              promoted: run.promoted,
                              trashed: run.trashed,
                            })}
                          </span>
                        ) : null}
                        {run && run.phase === 'error' ? (
                          <span className="text-[11px] text-destructive">
                            {run.message || t('settings.memory.dreamError', { defaultValue: '整理出错' })}
                          </span>
                        ) : null}
                        {run && !run.active && run.phase === 'cancelled' ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('settings.memory.dreamCancelled', { defaultValue: '已取消' })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {t('settings.memory.dreamLoading', { defaultValue: '读取做梦设置…' })}
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
