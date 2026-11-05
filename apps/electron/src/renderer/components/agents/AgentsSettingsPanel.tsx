/**
 * Agent (role profile) settings.
 *
 * Two panes: the role list on the left, the editor on the right. The editor is
 * built from the same primitives as every other settings page (SettingsSection /
 * SettingsCard / SettingsRow) — an earlier hand-rolled version looked bolted on:
 * it had its own headings, its own control styling and mixed Chinese literals
 * into an otherwise translated page.
 *
 * The editor stays a plain form on purpose: persona, the inherited defaults and
 * the two scope ceilings (sources, skills). "All vs allowlist" is the one
 * decision that silently changes what a session can touch, so it gets the most
 * visual weight.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Trash2 } from 'lucide-react'

import { useAgents } from '@/hooks/useAgents'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'

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

/**
 * Scope ceiling editor. Renders as a settings card: the mode select sits on the
 * row, and picking "指定" reveals the searchable checklist underneath.
 */
function ScopeField({
  title,
  hint,
  scope,
  candidates,
  onChange,
}: {
  title: string
  hint: string
  scope: { mode: 'all' | 'allowlist'; slugs: string[] }
  candidates: Array<{ slug: string; name: string }>
  onChange: (next: { mode: 'all' | 'allowlist'; slugs: string[] }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')
  const visible = candidates.filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <SettingsSection title={title} description={hint}>
      <SettingsCard>
        <SettingsRow label={t('settings.agents.scopeMode', { defaultValue: '范围' })}>
          <select
            className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
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
            <option value="all">{t('settings.agents.scopeAll', { defaultValue: '全部' })}</option>
            <option value="allowlist">{t('settings.agents.scopePick', { defaultValue: '指定' })}</option>
          </select>
        </SettingsRow>

        {scope.mode === 'allowlist' ? (
          <div className="space-y-2 px-4 pb-3">
            <input
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              placeholder={t('settings.agents.scopeSearch', { defaultValue: '搜索…' })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto">
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
                      'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors',
                      checked
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-transparent hover:bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      )}
                    >
                      {checked ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                    <span className="truncate">{candidate.name}</span>
                  </button>
                )
              })}
              {visible.length === 0 ? (
                <div className="col-span-2 py-3 text-center text-xs text-muted-foreground">
                  {t('settings.agents.scopeEmpty', { defaultValue: '没有可选项' })}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </SettingsCard>
    </SettingsSection>
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
  const { agents, reload } = useAgents(workspaceId)
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
      await reload()
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
    await reload()
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Role list */}
      <div className="flex w-60 shrink-0 flex-col border-r">
        <div className="p-2">
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-1.5 px-2 text-[13px] font-normal"
            onClick={() => {
              setSelectedId(null)
              setDraft(EMPTY)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.agents.newAgent', { defaultValue: '新建角色' })}
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setSelectedId(agent.id)}
              className={cn(
                'mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                selectedId === agent.id ? 'bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <span className="shrink-0 text-sm">{agent.icon ?? '👤'}</span>
              <span className="truncate">{agent.name}</span>
              {agent.builtin ? (
                <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t('settings.agents.builtin', { defaultValue: '内置' })}
                </span>
              ) : null}
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Editor */}
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-7">
            <div className="space-y-8">
              <SettingsSection title={t('settings.agents.identity', { defaultValue: '身份' })}>
                <SettingsCard>
                  <SettingsRow label={t('settings.agents.name', { defaultValue: '名称' })}>
                    <div className="flex items-center gap-2">
                      <input
                        className="h-8 w-14 rounded-md border border-input bg-transparent text-center text-sm"
                        placeholder="🙂"
                        value={draft.icon ?? ''}
                        onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                      />
                      <input
                        className="h-8 w-64 rounded-md border border-input bg-transparent px-2 text-sm"
                        placeholder={t('agent.namePlaceholder', { defaultValue: '角色名称' })}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.agents.persona', { defaultValue: '人设提示词' })}
                description={t('settings.agents.personaHint', {
                  defaultValue: '这段文字会作为系统提示的一部分，决定它怎么说话、怎么做事。',
                })}
              >
                <SettingsCard>
                  <div className="p-3">
                    <textarea
                      className="min-h-[140px] w-full resize-y rounded-md border border-input bg-transparent p-2 font-mono text-xs leading-relaxed"
                      value={draft.persona}
                      onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
                    />
                  </div>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection title={t('settings.agents.defaults', { defaultValue: '默认值' })}>
                <SettingsCard>
                  <SettingsRow label={t('settings.agents.defaultStrategy', { defaultValue: '默认策略组' })}>
                    <select
                      className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={draft.defaults.strategy ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          defaults: { ...draft.defaults, strategy: e.target.value || null },
                        })
                      }
                    >
                      <option value="">
                        {t('settings.agents.followStrategy', { defaultValue: '跟随（第一个启用的组）' })}
                      </option>
                      {strategies.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                  <SettingsRow label={t('settings.agents.defaultPermission', { defaultValue: '默认权限模式' })}>
                    <select
                      className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm"
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
                      <option value="">{t('settings.agents.followWorkspace', { defaultValue: '跟随工作区' })}</option>
                      <option value="safe">{t('mode.safe', { defaultValue: '只读' })}</option>
                      <option value="ask">{t('mode.askToEdit', { defaultValue: '每次询问' })}</option>
                      <option value="allow-all">{t('mode.allow-all', { defaultValue: '全部放行' })}</option>
                    </select>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              <ScopeField
                title={t('settings.agents.sourcesScope', { defaultValue: '可用来源' })}
                hint={t('settings.agents.sourcesScopeHint', {
                  defaultValue: '不选表示不限制；选了就只有这些来源对它可见。',
                })}
                scope={draft.sources}
                candidates={sources}
                onChange={(next) => setDraft({ ...draft, sources: next })}
              />

              <ScopeField
                title={t('settings.agents.skillsScope', { defaultValue: '可用技能' })}
                hint={t('settings.agents.skillsScopeHint', {
                  defaultValue: '同时影响系统提示里的技能清单和技能调用。',
                })}
                scope={draft.skills}
                candidates={skills}
                onChange={(next) => setDraft({ ...draft, skills: next })}
              />

              <div className="flex items-center gap-2 pb-2">
                <Button size="sm" disabled={saving || !draft.name.trim()} onClick={() => void save()}>
                  {saving
                    ? t('settings.agents.saving', { defaultValue: '保存中…' })
                    : t('settings.agents.save', { defaultValue: '保存' })}
                </Button>
                {selected && !selected.builtin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1 text-muted-foreground"
                    onClick={() => void remove()}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('settings.agents.delete', { defaultValue: '删除' })}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
