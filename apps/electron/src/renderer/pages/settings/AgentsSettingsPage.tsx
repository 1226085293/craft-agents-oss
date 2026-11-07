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
  const atomSources = useAtomValue(sourcesAtom)
  const atomSkills = useAtomValue(skillsAtom)
  // The default-strategy picker needs the live group list; without it the
  // dropdown rendered a single "跟随" entry and looked broken.
  const { strategies } = useGatewayStrategies()

  //
  // The atoms are filled by AppShell, and this page is not guaranteed to render
  // inside it — settings can open in its own window. When that happens the atoms
  // stay at their initial `[]`, and the scope picker reports "指定 0 / 0 · 没有可选项"
  // for a workspace that plainly has sources: measured in the running app, the
  // backend answered with five sources while this page showed none.
  //
  // So the page loads its own copy when the atoms are empty. Reading the atom first
  // keeps the shared state as the single source of truth when it *is* populated —
  // this is a fallback, not a second owner.
  //
  const [ownSources, setOwnSources] = React.useState<Array<{ slug: string; name: string }>>([])
  const [ownSkills, setOwnSkills] = React.useState<Array<{ slug: string; name: string }>>([])

  React.useEffect(() => {
    if (!workspace) return
    let cancelled = false
    void window.electronAPI
      .getSources(workspace.id)
      .then((loaded) => {
        if (cancelled) return
        setOwnSources(
          (loaded ?? []).map((s) => ({ slug: s.config.slug, name: s.config.name ?? s.config.slug })),
        )
      })
      .catch(() => undefined)

    // Same gap for skills: the workspace-scoped skill list is what the scope picker
    // filters, and an empty one reads as "this workspace has no skills".
    void window.electronAPI
      .getSkills(workspace.id)
      .then((list) => {
        if (cancelled) return
        setOwnSkills(
          (list ?? []).map((s) => ({ slug: s.slug, name: s.metadata?.name || s.slug })),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspace?.id])

  const sources = atomSources.length > 0
    ? atomSources.map((s) => ({ slug: s.config.slug, name: s.config.name }))
    : ownSources

  const skills = (atomSkills ?? []).length > 0
    ? (atomSkills ?? []).map((s) => ({ slug: s.slug, name: s.metadata.name || s.slug }))
    : ownSkills

  if (!workspace) {
    return <div className="p-4 text-xs text-muted-foreground">请先选择一个工作区。</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <AgentsSettingsPanel
          workspaceId={workspace.id}
          sources={sources}
          skills={skills}
          strategies={strategies.map((s) => ({ id: s.id, name: s.name ?? s.id }))}
        />
      </div>
    </div>
  )
}
