/**
 * Agent (role profile) settings.
 *
 * One list plus one editor. The editor is deliberately a plain form: persona,
 * the inherited defaults, and the two scope ceilings (sources, skills) rendered
 * as toggle grids, because "all vs allowlist" is the one decision that silently
 * changes what a session can touch.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'

import { useAgents } from '@/hooks/useAgents'
import { cn } from '@/lib/utils'

interface AgentDraft {
  id?: string
  name: string
  icon?: string
  persona: string
  defaults: {
    strategy?: string | null
    model?: string | null
    permissionMode?: 'safe' | 'ask' | 'allow-all' | null
    thinkingLevel?: string | null
  }
  sources: { mode: 'all' | 'allowlist'; slugs: string[] }
  skills: { mode: 'all' | 'allowlist'; slugs: string[] }
}

const EMPTY: AgentDraft = {
  name: '',
  persona: '',
  defaults: { strategy: null, model: null, permissionMode: null, thinkingLevel: null },
  sources: { mode: 'all', slugs: [] },
  skills: { mode: 'all', slugs: [] },
}

function ScopeGrid({
  label,
  hint,
  scope,
  candidates,
  onChange,
}: {
  label: string
  hint: string
  scope: { mode: 'all' | 'allowlist'; slugs: string[] }
  candidates: Array<{ slug: string; name: string }>
  onChange: (next: { mode: 'all' | 'allowlist'; slugs: string[] }) => void
}): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const visible = candidates.filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-medium">{label}</div>
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        </div>
        <select
          className="rounded border bg-transparent px-1.5 py-1 text-xs"
          value={scope.mode}
          onChange={(e) =>
            onChange({
              mode: e.target.value as 'all' | 'allowlist',
              // Switching back to "all" keeps the ticked set, so flipping back
              // does not lose the user's work.
              slugs: scope.slugs,
            })
          }
        >
          <option value="all">全部</option>
          <option value="allowlist">指定</option>
        </select>
      </div>

      {scope.mode === 'allowlist' ? (
        <>
          <input
            className="w-full rounded border bg-transparent px-2 py-1 text-xs"
            placeholder="搜索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto">
            {visible.map((candidate) => {
              const checked = scope.slugs.includes(candidate.slug)
              return (
                <button
                  key={candidate.slug}
                  type="button"
                  onClick={() =>
                    onChange({
                      mode: 'allowlist',
                      slugs: checked
                        ? scope.slugs.filter((s) => s !== candidate.slug)
                        : [...scope.slugs, candidate.slug],
                    })
                  }
                  className={cn(
                    'flex items-center gap-1.5 rounded border px-2 py-1 text-left text-xs',
                    checked ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', checked ? 'bg-primary' : 'bg-muted-foreground/40')} />
                  <span className="truncate">{candidate.name}</span>
                </button>
              )
            })}
            {visible.length === 0 ? (
              <div className="col-span-2 py-2 text-center text-[11px] text-muted-foreground">没有可选项</div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}

export interface AgentsSettingsPanelProps {
  workspaceId: string
  /** Workspace sources (slug + display name). */
  sources?: Array<{ slug: string; name: string }>
  /** Loaded skills (slug + name). */
  skills?: Array<{ slug: string; name: string }>
  /** Gateway groups, for the default-strategy picker. */
  strategies?: Array<{ id: string; name: string }>
}

export function AgentsSettingsPanel({
  workspaceId,
  sources = [],
  skills = [],
  strategies = [],
}: AgentsSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const { agents } = useAgents(workspaceId)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<AgentDraft>(EMPTY)
  const [saving, setSaving] = React.useState(false)

  const selected = agents.find((a) => a.id === selectedId)

  React.useEffect(() => {
    // The picker list is flat; load the full profile for the selected id.
    if (!selectedId) {
      setDraft(EMPTY)
      return
    }
    let cancelled = false
    void (window.electronAPI as unknown as {
      agentsGet?: (workspaceId: string, id: string) => Promise<AgentDraft | null>
    })
      .agentsGet?.(workspaceId, selectedId)
      .then((profile) => {
        if (!cancelled && profile) setDraft({ ...EMPTY, ...profile })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId, selectedId])

  const save = async () => {
    setSaving(true)
    try {
      await (window.electronAPI as unknown as {
        agentsSave?: (workspaceId: string, agent: unknown) => Promise<{ id: string }>
      }).agentsSave?.(workspaceId, { ...draft, id: draft.id ?? selectedId ?? undefined })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!selectedId) return
    await (window.electronAPI as unknown as {
      agentsDelete?: (workspaceId: string, id: string) => Promise<unknown>
    }).agentsDelete?.(workspaceId, selectedId)
    setSelectedId(null)
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 border-r p-2">
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-accent"
          onClick={() => {
            setSelectedId(null)
            setDraft(EMPTY)
          }}
        >
          <Plus className="h-3.5 w-3.5" /> 新建角色
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => setSelectedId(agent.id)}
            className={cn(
              'mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs',
              selectedId === agent.id ? 'bg-accent' : 'hover:bg-accent',
            )}
          >
            <span>{agent.icon ?? '👤'}</span>
            <span className="truncate">{agent.name}</span>
            {agent.builtin ? (
              <span className="ml-auto rounded bg-muted px-1 text-[10px] text-muted-foreground">内置</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center gap-2">
          <input
            className="w-20 rounded border bg-transparent px-2 py-1 text-center text-sm"
            placeholder="🙂"
            value={draft.icon ?? ''}
            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
          />
          <input
            className="flex-1 rounded border bg-transparent px-2 py-1 text-sm"
            placeholder={t('agent.namePlaceholder', { defaultValue: '角色名称' })}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <section>
          <div className="mb-1 text-xs font-medium">人格提示词</div>
          <div className="mb-1 text-[11px] text-muted-foreground">
            写进系统提示的固定段落。创建会话时快照，之后改这里不会影响已有会话。
          </div>
          <textarea
            className="min-h-[120px] w-full rounded border bg-transparent p-2 font-mono text-xs"
            value={draft.persona}
            onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
          />
        </section>

        <section className="grid grid-cols-2 gap-2">
          <label className="text-xs">
            默认策略组
            <select
              className="mt-1 w-full rounded border bg-transparent px-1.5 py-1"
              value={draft.defaults.strategy ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, defaults: { ...draft.defaults, strategy: e.target.value || null } })
              }
            >
              <option value="">跟随（第一个启用的组）</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            默认权限模式
            <select
              className="mt-1 w-full rounded border bg-transparent px-1.5 py-1"
              value={draft.defaults.permissionMode ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaults: {
                    ...draft.defaults,
                    permissionMode: (e.target.value || null) as AgentDraft['defaults']['permissionMode'],
                  },
                })
              }
            >
              <option value="">跟随工作区</option>
              <option value="safe">只读</option>
              <option value="ask">每次询问</option>
              <option value="allow-all">全部放行</option>
            </select>
          </label>
        </section>

        <ScopeGrid
          label="来源范围（MCP / API / 本地）"
          hint="指定模式下这是上限：会话里只能在白名单内勾选。"
          scope={draft.sources}
          candidates={sources}
          onChange={(sources) => setDraft({ ...draft, sources })}
        />

        <ScopeGrid
          label="技能范围"
          hint="同时影响系统提示里的技能清单和技能调用。"
          scope={draft.skills}
          candidates={skills}
          onChange={(skills) => setDraft({ ...draft, skills })}
        />

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={saving || !draft.name.trim()}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {selected && !selected.builtin ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground"
              onClick={() => void remove()}
            >
              <Trash2 className="h-3 w-3" /> 删除
            </button>
          ) : null}
          {selectedId ? <span className="text-[11px] text-muted-foreground">{selectedId}</span> : null}
        </div>
      </div>
    </div>
  )
}
