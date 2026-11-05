/**
 * AgentsSettingsPage — role profiles.
 *
 * Thin wrapper: the page only supplies the workspace id and the candidate lists
 * (sources / skills / strategy groups); the panel owns editing.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'

import { AgentsSettingsPanel } from '@/components/agents/AgentsSettingsPanel'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { useGatewayStrategies } from '@/hooks/useGatewayStrategies'
import { useActiveWorkspace } from '@/context/AppShellContext'

export default function AgentsSettingsPage(): React.JSX.Element {
  const workspace = useActiveWorkspace()
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)
  // The default-strategy picker needs the live group list; without it the
  // dropdown rendered a single "跟随" entry and looked broken.
  const { strategies } = useGatewayStrategies()

  if (!workspace) {
    return <div className="p-4 text-xs text-muted-foreground">请先选择一个工作区。</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <AgentsSettingsPanel
          workspaceId={workspace.id}
          sources={sources.map((s) => ({ slug: s.config.slug, name: s.config.name }))}
          skills={(skills ?? []).map((s) => ({ slug: s.slug, name: s.metadata.name || s.slug }))}
          strategies={strategies.map((s) => ({ id: s.id, name: s.name ?? s.id }))}
        />
      </div>
    </div>
  )
}
