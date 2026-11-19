/**
 * AgentsListPanel — the middle-pane role list for the agents navigator
 * (same slot pattern as SourcesListPanel / SkillsListPanel / ProjectsListPanel:
 * left nav → middle list → right detail). Selection syncs with the agents
 * nav state (agents/agent/<id>; 'new' = a fresh role draft, nothing selected).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Users } from 'lucide-react'

import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { Button } from '@/components/ui/button'
import { useAgents } from '@/hooks/useAgents'
import { agentSelection } from '@/hooks/useEntitySelection'

export interface AgentsListPanelProps {
  workspaceId: string
  /** Selected agent id from the nav state ('new' sentinel = creating a role). */
  selectedAgentId?: string | null
  onAgentClick: (id: string) => void
  /** 新建角色：navigate to the 'new' sentinel so the editor opens a fresh draft. */
  onAddAgent: () => void
  className?: string
}

export function AgentsListPanel({
  workspaceId,
  selectedAgentId,
  onAgentClick,
  onAddAgent,
  className,
}: AgentsListPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const { agents, reload } = useAgents(workspaceId)

  React.useEffect(() => {
    // Keep the list fresh after create/delete in the editor (autosave).
    const off = window.electronAPI.onAgentsChanged?.(reload)
    return () => {
      if (typeof off === 'function') off()
    }
  }, [reload])

  return (
    <EntityPanel
      items={agents}
      getId={(a) => a.id}
      selection={agentSelection}
      selectedId={selectedAgentId === 'new' ? null : selectedAgentId ?? null}
      onItemClick={(a) => onAgentClick(a.id)}
      className={className}
      containerProps={{ 'data-list-role': 'agents' }}
      header={
        <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('sidebar.agents', { defaultValue: '智能体' })} · {agents.length}
          </span>
          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={onAddAgent}>
            <Plus className="h-3 w-3" />
            {t('settings.agents.newRole', { defaultValue: '新建角色' })}
          </Button>
        </div>
      }
      emptyState={
        <EntityListEmptyScreen
          icon={<Users />}
          title={t('settings.agents.emptyList', { defaultValue: '还没有角色' })}
          description={t('settings.agents.emptyDescription', { defaultValue: '新建一个角色，给它人设与分工。' })}
        >
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onAddAgent}>
            <Plus className="h-3 w-3" />
            {t('settings.agents.newRole', { defaultValue: '新建角色' })}
          </Button>
        </EntityListEmptyScreen>
      }
      mapItem={(agent) => ({
        icon: (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm" aria-hidden>
            {agent.icon ?? '👤'}
          </span>
        ),
        title: agent.name,
        badges: (
          <span className="flex min-w-0 items-center gap-1.5">
            {agent.builtin ? (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t('settings.agents.builtin', { defaultValue: '内置' })}
              </span>
            ) : null}
            {(agent.dispatchHint ?? '').trim() ? (
              <span className="truncate text-[11px] text-muted-foreground/70">{agent.dispatchHint!.trim()}</span>
            ) : null}
          </span>
        ),
      })}
    />
  )
}
