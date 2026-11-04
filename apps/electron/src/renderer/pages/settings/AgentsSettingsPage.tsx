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
import { useActiveWorkspace } from '@/context/AppShellContext'

export default function AgentsSettingsPage(): React.JSX.Element {
  const workspace = useActiveWorkspace()
  const sources = useAtomValue(sourcesAtom)

  if (!workspace) {
    return <div className="p-4 text-xs text-muted-foreground">请先选择一个工作区。</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4">
        <div className="text-sm font-medium">角色</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          每个角色是一个人设加一组默认值与范围上限；新建会话时在这里选中的角色会被快照下来。
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AgentsSettingsPanel
          workspaceId={workspace.id}
          sources={sources.map((s) => ({ slug: s.config.slug, name: s.config.name }))}
        />
      </div>
    </div>
  )
}
