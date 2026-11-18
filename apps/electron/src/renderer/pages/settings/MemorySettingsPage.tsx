/**
 * MemorySettingsPage
 *
 * The memory-domain registry and the 记忆 wiki itself: every domain's
 * MEMORY.md is viewable here. Personal domains belong to one assistant
 * (the 助手卡「记忆域」dropdown picks them); project domains are shared and
 * read-only until stage 4 lands the L1/L3 resolution.
 *
 * Read-only by design: the file is curated by the memory pipeline, not
 * hand-edited in the UI. What the page answers: which domains exist,
 * which assistant writes to which one, and what is actually in them.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileText, Lock, UserRound } from 'lucide-react'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Info_Markdown } from '@/components/info/Info_Markdown'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'

import { SettingsCard, SettingsSection } from '@/components/settings'

import type { MemoryDomainDef } from '@craft-agent/shared/memory'

type DomainContent = {
  exists: boolean
  content: string
  truncated: boolean
  loading: boolean
}

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'memory',
}

export default function MemorySettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()

  const [domains, setDomains] = React.useState<MemoryDomainDef[]>([])
  const [agentNames, setAgentNames] = React.useState<Record<string, string[]>>({})
  const [openDomain, setOpenDomain] = React.useState<string | null>(null)
  const [contents, setContents] = React.useState<Record<string, DomainContent>>({})
  const [loadError, setLoadError] = React.useState(false)

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

  const toggleDomain = (slug: string): void => {
    const nextOpen = openDomain === slug ? null : slug
    setOpenDomain(nextOpen)
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
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <FileText className="h-3 w-3" aria-hidden />
                  <span className="truncate font-mono text-[10px]">{domain.path}</span>
                </div>
                <Info_Markdown mode="full" maxHeight={320}>
                  {content.content}
                </Info_Markdown>
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
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
