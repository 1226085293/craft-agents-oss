import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'
import { toast } from 'sonner'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { skillSelection } from '@/hooks/useEntitySelection'
import { SkillMenu } from './SkillMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { UsageListToolbar, formatUsageRelativeTime, type UsageSortKey } from './UsageListToolbar'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import type { LoadedSkill, UsageStats } from '../../../shared/types'

export interface SkillsListPanelProps {
  skills: LoadedSkill[]
  onDeleteSkill: (skillSlug: string) => void
  onSkillClick: (skill: LoadedSkill) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  workspaceRootPath?: string
  usageStats?: UsageStats
  className?: string
}

export function SkillsListPanel({
  skills,
  onDeleteSkill,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  workspaceRootPath,
  usageStats,
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const activeWorkspace = useActiveWorkspace()
  const canRevealLocally = !activeWorkspace?.remoteServer
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // Search + sort state
  const [searchQuery, setSearchQuery] = React.useState('')
  const [sortKey, setSortKey] = React.useState<UsageSortKey>('name')

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const filteredSkills = React.useMemo(() => {
    let result = skills

    // Text search on name + description
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(s =>
        s.metadata.name.toLowerCase().includes(q) ||
        s.metadata.description.toLowerCase().includes(q)
      )
    }

    // Sort
    const stats = usageStats?.skills ?? {}
    const sorted = [...result]
    sorted.sort((a, b) => {
      const aStat = stats[a.slug]
      const bStat = stats[b.slug]
      if (sortKey === 'count') {
        const aC = aStat?.useCount
        const bC = bStat?.useCount
        if (aC !== undefined && bC !== undefined) return bC - aC
        if (aC !== undefined) return -1
        if (bC !== undefined) return 1
        return a.metadata.name.localeCompare(b.metadata.name)
      }
      if (sortKey === 'lastUsed') {
        const aT = aStat?.lastUsedAt
        const bT = bStat?.lastUsedAt
        if (aT !== undefined && bT !== undefined) return bT - aT
        if (aT !== undefined) return -1
        if (bT !== undefined) return 1
        return a.metadata.name.localeCompare(b.metadata.name)
      }
      return a.metadata.name.localeCompare(b.metadata.name)
    })
    return sorted
  }, [skills, searchQuery, sortKey, usageStats])

  return (
    <>
    <EntityPanel<LoadedSkill>
      items={filteredSkills}
      getId={(s) => s.slug}
      selection={skillSelection}
      selectedId={selectedSkillSlug}
      onItemClick={onSkillClick}
      className={className}
      containerProps={{ 'data-list-role': 'skills' }}
      header={
        <UsageListToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          sortKey={sortKey}
          onSortChange={setSortKey}
          searchPlaceholder={t('usage.searchSkillsPlaceholder')}
        />
      }
      emptyState={
        <EntityListEmptyScreen
          icon={<Zap />}
          title={t('skillsList.noSkillsConfigured')}
          description={t('skillsList.emptyDescription')}
          docKey="skills"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('skillsList.addSkill')}
                </button>
              }
              {...getEditConfig('add-skill', workspaceRootPath)}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(skill) => {
        const stat = usageStats?.skills[skill.slug]
        return {
          icon: <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />,
          title: skill.metadata.name,
          trailing: stat ? (
            <span className="shrink-0 text-[11px] text-foreground/40 whitespace-nowrap cursor-default" title={t('usage.timesUsed', { count: stat.useCount })}>
              {stat.useCount}× · {formatUsageRelativeTime(stat.lastUsedAt)}
            </span>
          ) : undefined,
          badges: (
            <span className="flex items-center gap-1.5 min-w-0">
              {skill.source === 'project' && (
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                  {t('skillsList.projectBadge')}
                </span>
              )}
              <span className="truncate">{skill.metadata.description}</span>
            </span>
          ),
          menu: (
            <SkillMenu
              skillSlug={skill.slug}
              skillName={skill.metadata.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://skills/skill/${skill.slug}?window=focused`)}
              onShowInFinder={async () => {
                if (!canRevealLocally) return
                try {
                  await window.electronAPI.showInFolder(skill.path)
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err)
                  toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
                    description: message,
                  })
                }
              }}
              canShowInFinder={canRevealLocally}
              onDelete={skill.source === 'workspace' ? () => onDeleteSkill(skill.slug) : undefined}
              canDelete={skill.source === 'workspace'}
              deleteLabel={skill.source === 'workspace' ? t('skillsList.deleteSkill') : t('skillsList.managedByProject')}
              onSendToWorkspace={hasOtherWorkspaces && skill.source === 'workspace' ? () => {
                setSendResourceSlug(skill.slug)
                setSendResourceLabel(skill.metadata.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
        }
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="skill"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
