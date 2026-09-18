import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap } from 'lucide-react'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import { UsageListToolbar, formatUsageRelativeTime, type UsageSortKey } from './UsageListToolbar'
import type { LoadedSource, SourceConnectionStatus, SourceFilter, UsageStats } from '../../../shared/types'

const SOURCE_TYPE_CONFIG: Record<string, { labelKey: string; colorClass: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp', colorClass: 'bg-accent/10 text-accent' },
  api: { labelKey: 'sourcesList.typeApi', colorClass: 'bg-success/10 text-success' },
  local: { labelKey: 'sourcesList.typeLocal', colorClass: 'bg-info/10 text-info' },
}

const SOURCE_STATUS_CONFIG: Record<string, { labelKey: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', colorClass: 'bg-warning/10 text-warning' },
  failed: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-destructive/10 text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', colorClass: 'bg-foreground/10 text-foreground/50' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', colorClass: 'bg-foreground/10 text-foreground/50' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: LoadedSource[]
  sourceFilter?: SourceFilter | null
  workspaceRootPath?: string
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: LoadedSource) => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  usageStats?: UsageStats
  className?: string
}

export function SourcesListPanel({
  sources,
  sourceFilter,
  workspaceRootPath,
  onDeleteSource,
  onSourceClick,
  selectedSourceSlug,
  localMcpEnabled = true,
  usageStats,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1

  // Search + sort state
  const [searchQuery, setSearchQuery] = React.useState('')
  const [sortKey, setSortKey] = React.useState<UsageSortKey>('name')

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const filteredSources = React.useMemo(() => {
    let result = sourceFilter ? sources.filter(s => s.config.type === sourceFilter.sourceType) : sources

    // Text search on name, provider, tagline
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(s =>
        s.config.name.toLowerCase().includes(q) ||
        (s.config.provider ?? '').toLowerCase().includes(q) ||
        (s.config.tagline ?? '').toLowerCase().includes(q)
      )
    }

    // Sort
    const stats = usageStats?.sources ?? {}
    const sorted = [...result]
    sorted.sort((a, b) => {
      const aStat = stats[a.config.slug]
      const bStat = stats[b.config.slug]
      if (sortKey === 'count') {
        return (bStat?.useCount ?? 0) - (aStat?.useCount ?? 0)
      }
      if (sortKey === 'lastUsed') {
        const aT = aStat?.lastUsedAt ?? 0
        const bT = bStat?.lastUsedAt ?? 0
        if (aT === bT) return a.config.name.localeCompare(b.config.name)
        return bT - aT
      }
      return a.config.name.localeCompare(b.config.name)
    })
    return sorted
  }, [sources, sourceFilter, searchQuery, sortKey, usageStats])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  return (
    <>
    <EntityPanel<LoadedSource>
      items={filteredSources}
      getId={(s) => s.config.slug}
      selection={sourceSelection}
      selectedId={selectedSourceSlug}
      onItemClick={onSourceClick}
      className={className}
      containerProps={{ 'data-list-role': 'sources' }}
      header={
        <UsageListToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          sortKey={sortKey}
          onSortChange={setSortKey}
          searchPlaceholder={t('usage.searchPlaceholder')}
        />
      }
      emptyState={
        <EntityListEmptyScreen
          icon={<DatabaseZap />}
          title={emptyMessage}
          description={t('sourcesList.emptyDescription')}
          docKey="sources"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('sourcesList.addSource')}
                </button>
              }
              {...getEditConfig(
                sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                workspaceRootPath
              )}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(source) => {
        const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
        const typeConfig = SOURCE_TYPE_CONFIG[source.config.type]
        const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
        const subtitle = source.config.tagline || source.config.provider || ''
        const stat = usageStats?.sources[source.config.slug]
        return {
          icon: <SourceAvatar source={source} size="sm" />,
          title: source.config.name,
          trailing: stat ? (
            <span className="shrink-0 text-[11px] text-foreground/40 whitespace-nowrap cursor-default" title={t('usage.timesUsed', { count: stat.useCount })}>
              {stat.useCount}× · {formatUsageRelativeTime(stat.lastUsedAt)}
            </span>
          ) : undefined,
          badges: (
            <>
              {typeConfig && <EntityListBadge colorClass={typeConfig.colorClass}>{t(typeConfig.labelKey)}</EntityListBadge>}
              {statusConfig && (
                <EntityListBadge colorClass={statusConfig.colorClass} tooltip={source.config.connectionError || undefined} className="cursor-default">
                  {t(statusConfig.labelKey)}
                </EntityListBadge>
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
            </>
          ),
          menu: (
            <SourceMenu
              sourceSlug={source.config.slug}
              sourceName={source.config.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://sources/source/${source.config.slug}?window=focused`)}
              onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
              onDelete={() => onDeleteSource(source.config.slug)}
              onSendToWorkspace={hasOtherWorkspaces ? () => {
                setSendResourceSlug(source.config.slug)
                setSendResourceLabel(source.config.name)
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
        resourceType="source"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
