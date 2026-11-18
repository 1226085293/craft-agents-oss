/**
 * Agent (role profile) settings.
 *
 * Two panes: the role list on the left, the editor on the right. The editor is
 * built from the same primitives as every other settings page (SettingsSection /
 * SettingsCard / SettingsRow / SettingsSelectRow) — an earlier hand-rolled
 * version looked bolted on: it had its own headings, its own control styling
 * and mixed Chinese literals into an otherwise translated page.
 *
 * Native <select> is deliberately absent: on Windows/Chromium its popup is drawn
 * by the OS and the option text comes out low-contrast on a dark theme, which
 * read as "greyed out / disabled". Everything goes through the Radix-based
 * settings selects instead.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Smile, Trash2 } from 'lucide-react'

import { useAgents } from '@/hooks/useAgents'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelectRow,
} from '@/components/settings'

interface AgentDraft {
  id?: string
  name: string
  icon?: string
  /**
   * How a dispatcher should pick this role. Third-person, discriminative, and
   * shown to whoever assigns work — never to the agent itself.
   */
  dispatchHint: string
  persona: string
  /** 可分配任务开关（渠道闸门 v6/v7）：缺省 false，显式开启才进派活名单 */
  assignable?: boolean
  /** 记忆域（memory-domains.json 的 slug；阶段 4 域解析启用前仅为存档） */
  memoryDomain?: string
  defaults: {
    strategy?: string | null
    model?: string | null
    permissionMode?: 'safe' | 'ask' | 'allow-all' | null
    thinkingLevel?: string | null
  }
  sources: { mode: 'all' | 'allowlist'; slugs: string[] }
  skills: { mode: 'all' | 'allowlist'; slugs: string[] }
}

/**
 * How long a typing pause has to last before the draft is written.
 *
 * Long enough that a sentence typed at speed is one save, short enough that
 * clicking away does not lose the tail of a word.
 */
const AUTOSAVE_MS = 500

/**
 * Everything about a draft that is *content*, with identity left out.
 *
 * Autosave gates on this string: when the user has not actually changed
 * anything, the key is unchanged and no request goes out. `id` is deliberately
 * excluded — creating a role assigns one mid-flight, and counting that as a
 * change would cause a second save of the same content.
 */
function contentKey(draft: AgentDraft): string {
  return JSON.stringify({
    name: draft.name,
    icon: draft.icon ?? null,
    dispatchHint: draft.dispatchHint,
    persona: draft.persona,
    assignable: draft.assignable ?? false,
    memoryDomain: draft.memoryDomain ?? '',
    defaults: draft.defaults,
    sources: draft.sources,
    skills: draft.skills,
  })
}

/**
 * Mirrors `MAX_DISPATCH_HINT_CHARS` in @craft-agent/shared/agents. The renderer
 * bundle does not import that package, so the number is repeated here; the
 * server caps again on write, so a drift can never produce an oversized hint.
 */
// Mirrors MAX_DISPATCH_HINT_CHARS (raised 120→200 with the 渠道闸门 work: a
// working description that fits 擅长+不接+边界 needs the room).
const MAX_HINT_CHARS = 200

const EMPTY: AgentDraft = {
  name: '',
  dispatchHint: '',
  persona: '',
  assignable: false,
  memoryDomain: '',
  defaults: { strategy: null, model: null, permissionMode: null, thinkingLevel: null },
  sources: { mode: 'all', slugs: [] },
  skills: { mode: 'all', slugs: [] },
}

/** A small curated set — enough to tell roles apart at a glance. */
const ICON_CHOICES = [
  '🙂', '🤖', '🧭', '🛠️', '🔍', '📝', '📊', '🧪',
  '🎨', '🧩', '⚡', '🌱', '🦉', '🐝', '🧠', '📦',
]

/**
 * Icon picker.
 *
 * The old inline text input held a placeholder emoji, which Chromium renders in
 * colour regardless of the surrounding text colour — inside a 56px box it read
 * as a broken control rather than an empty field. A popover of fixed choices
 * keeps the row a single predictable height and makes clearing explicit.
 */
function IconPicker({
  value,
  onChange,
}: {
  value?: string
  onChange: (next: string | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('settings.agents.iconPick', { defaultValue: '选择图标' })}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input',
            'bg-muted/50 text-base leading-none transition-colors hover:bg-foreground/[0.055]',
          )}
        >
          {value ? (
            <span>{value}</span>
          ) : (
            <Smile className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <div className="grid grid-cols-8 gap-1">
          {ICON_CHOICES.map((icon) => (
            <button
              key={icon}
              type="button"
              onClick={() => {
                onChange(icon)
                setOpen(false)
              }}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded text-sm leading-none transition-colors hover:bg-foreground/[0.055]',
                value === icon && 'bg-accent',
              )}
            >
              {icon}
            </button>
          ))}
        </div>
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange(undefined)
              setOpen(false)
            }}
            className="mt-2 w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.055]"
          >
            {t('settings.agents.iconClear', { defaultValue: '清除图标' })}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Filter the scope candidates for the search box.
 *
 * Matches the display name *and* the slug, case-insensitively: typing `git`
 * has to find "GitHub", and typing a slug has to find an entry whose display
 * name is Chinese. The earlier name-only filter made the box look broken.
 */
export function filterScopeCandidates(
  candidates: Array<{ slug: string; name: string }>,
  query: string,
): Array<{ slug: string; name: string }> {
  const needle = query.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter((c) => {
    const name = (c.name ?? '').toLowerCase()
    const slug = (c.slug ?? '').toLowerCase()
    return name.includes(needle) || slug.includes(needle)
  })
}

/**
 * Scope ceiling editor. Renders as a settings card: the mode select sits on the
 * row, and picking "指定" reveals the searchable checklist underneath.
 *
 * The filter matches the display name *and* the slug: typing `git` has to find
 * "GitHub" and typing a source's slug has to find it even when its display name
 * is Chinese.
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
  const visible = React.useMemo(
    () => filterScopeCandidates(candidates, query),
    [candidates, query],
  )

  return (
    <SettingsSection title={title} description={hint}>
      <SettingsCard>
        <SettingsSelectRow
          label={t('settings.agents.scopeMode', { defaultValue: '范围' })}
          value={scope.mode}
          onValueChange={(next) =>
            onChange({
              mode: next as 'all' | 'allowlist',
              // Switching back to "all" keeps the ticked set, so flipping back
              // does not lose the user's work.
              slugs: scope.slugs,
            })
          }
          options={[
            { value: 'all', label: t('settings.agents.scopeAll', { defaultValue: '全部' }) },
            { value: 'allowlist', label: t('settings.agents.scopePick', { defaultValue: '指定' }) },
          ]}
        />

        {scope.mode === 'allowlist' ? (
          <div className="space-y-2 px-4 pb-3">
            <div className="flex items-center gap-2">
              <Input
                className="h-8 bg-muted/50 text-xs"
                placeholder={t('settings.agents.scopeSearch', { defaultValue: '搜索…' })}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t('settings.agents.scopeCount', {
                  defaultValue: '{{shown}} / {{total}}',
                  shown: visible.length,
                  total: candidates.length,
                })}
              </span>
            </div>
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
                        : 'border-transparent hover:bg-foreground/[0.055]',
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
                    <span className="truncate">{candidate.name || candidate.slug}</span>
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
  /**
   * No save button. The page writes itself: every edit is persisted after a
   * short pause. A settings page that makes you press Save teaches you to
   * distrust it — the only question that matters is whether your change
   * survived, and the answer should always be yes.
   */
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  /** contentKey() of what is already on disk. The autosave gate. */
  const persistedRef = React.useRef(contentKey(EMPTY))
  /**
   * The id whose profile is currently in `draft`. Guards re-hydration: after
   * creating a role the server hands back an id, and re-fetching it would
   * overwrite whatever the user typed in the meantime.
   */
  const hydratedForRef = React.useRef<string | null>(null)
  const flashRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const selected = agents.find((a) => a.id === selectedId)

  // 记忆域下拉数据源（memory-domains 最小版：表 + 自动注册的 project 共享域）
  const [memoryDomainOptions, setMemoryDomainOptions] = React.useState<
    Array<{ value: string; label: string }>
  >([])
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .memoryDomains(workspaceId)
      .then((file) => {
        if (cancelled) return
        setMemoryDomainOptions([
          {
            value: '',
            label: t('settings.agents.memoryDomainNone', { defaultValue: '未指定' }),
          },
          ...file.domains.map((domain) => ({
            value: domain.slug,
            label: `${
              domain.kind === 'project'
                ? t('settings.agents.memoryDomainShared', { defaultValue: '共享' })
                : t('settings.agents.memoryDomainPersonal', { defaultValue: '个人' })
            } · ${domain.slug}`,
          })),
        ])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId, t])

  React.useEffect(() => {
    // The picker list is flat; load the full profile for the selected id.
    if (!selectedId) {
      hydratedForRef.current = null
      persistedRef.current = contentKey(EMPTY)
      setDraft(EMPTY)
      return
    }
    // Already holding this profile — a refetch would only clobber the field the
    // user is in the middle of editing.
    if (hydratedForRef.current === selectedId) return
    let cancelled = false
    void (window.electronAPI as unknown as {
      agentsGet?: (workspaceId: string, id: string) => Promise<AgentDraft | null>
    })
      .agentsGet?.(workspaceId, selectedId)
      .then((profile) => {
        if (cancelled || !profile) return
        // `dispatchHint` is optional on the wire (older rows have none), but the
        // editor needs a string it can type into.
        const next = { ...EMPTY, ...profile, dispatchHint: profile.dispatchHint ?? '' }
        hydratedForRef.current = selectedId
        // Seeding the draft must not look like an edit.
        persistedRef.current = contentKey(next)
        setDraft(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId, selectedId])

  const flash = (next: 'saved' | 'error') => {
    setStatus(next)
    if (flashRef.current) clearTimeout(flashRef.current)
    flashRef.current = setTimeout(() => setStatus('idle'), next === 'saved' ? 1600 : 5000)
  }

  React.useEffect(() => {
    return () => {
      if (flashRef.current) clearTimeout(flashRef.current)
    }
  }, [])

  /**
   * Autosave.
   *
   * Three guards, each for a specific way this goes wrong:
   *  - unchanged content, or a draft that came from disk, sends nothing;
   *  - an empty name sends nothing, because every role needs a label;
   *  - a brand-new role is not written until it has a name, so merely opening
   *    the page does not litter the list with rows named 「新角色」.
   */
  React.useEffect(() => {
    const key = contentKey(draft)
    if (key === persistedRef.current) return
    if (!draft.name.trim()) return

    const timer = setTimeout(() => {
      const payload = { ...draft, id: draft.id ?? selectedId ?? undefined }
      setStatus('saving')
      void (window.electronAPI as unknown as {
        agentsSave?: (workspaceId: string, agent: unknown) => Promise<{ id: string }>
      })
        .agentsSave?.(workspaceId, payload)
        .then((result) => {
          // The key recorded is the one that was actually sent: if a keystroke
          // landed while the request was in flight, the effect fires again
          // with a different key, which is exactly right.
          persistedRef.current = key
          if (result?.id && draft.id !== result.id) {
            // Adopt the id the server assigned so the next edit updates this
            // role instead of creating a twin.
            hydratedForRef.current = result.id
            setSelectedId(result.id)
            setDraft((current) => (contentKey(current) === key ? { ...current, id: result.id } : current))
          }
          flash('saved')
        })
        .catch(() => flash('error'))
    }, AUTOSAVE_MS)

    return () => clearTimeout(timer)
  }, [draft, selectedId, workspaceId])

  const remove = async () => {
    if (!selectedId) return
    await (window.electronAPI as unknown as {
      agentsDelete?: (workspaceId: string, id: string) => Promise<unknown>
    }).agentsDelete?.(workspaceId, selectedId)
    setSelectedId(null)
    await reload()
  }

  const strategyOptions = [
    {
      value: '__follow',
      label: t('settings.agents.followStrategy', { defaultValue: '跟随（第一个启用的组）' }),
    },
    ...strategies.map((s) => ({ value: s.id, label: s.name })),
  ]

  /**
   * Roles whose hints are identical. Two roles that describe themselves the same
   * way cannot be routed between, and the editor shows one role at a time, so
   * this is the only place the collision is visible at all.
   *
   * The current draft is folded in, so a half-typed hint that duplicates another
   * role is flagged before it is saved.
   */
  const hints = agents.map((agent) =>
    (agent.id === (draft.id ?? selectedId) ? draft.dispatchHint : (agent.dispatchHint ?? '')).trim(),
  )
  const seenHints = new Map<string, number>()
  for (const hint of hints) {
    if (hint) seenHints.set(hint, (seenHints.get(hint) ?? 0) + 1)
  }
  const collisionCount = Array.from(seenHints.values()).filter((n) => n > 1).length
  const headlineCollision = collisionCount > 0

  const permissionOptions = [
    { value: '__follow', label: t('settings.agents.followWorkspace', { defaultValue: '跟随工作区' }) },
    { value: 'safe', label: t('mode.safe', { defaultValue: '只读' }) },
    { value: 'ask', label: t('mode.askToEdit', { defaultValue: '每次询问' }) },
    { value: 'allow-all', label: t('mode.allow-all', { defaultValue: '全部放行' }) },
  ]

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
                // `--accent` is the purple brand colour (Auto mode). Using it for
                // row hover and selection painted the whole list purple whenever the
                // pointer moved, which fights the neutral surfaces everywhere else in
                // settings. A hover is a surface, not a brand moment: the selected row
                // is a neutral fill with a left marker, so colour is reserved for
                // things that actually mean something.
                selectedId === agent.id
                  ? 'bg-foreground/[0.08] font-medium text-foreground'
                  : 'text-foreground/85 hover:bg-foreground/[0.055]',
              )}
            >
              <span className="flex w-4 shrink-0 justify-center text-sm">{agent.icon ?? '👤'}</span>
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
                  <SettingsRow
                    label={t('settings.agents.name', { defaultValue: '名称' })}
                    description={t('settings.agents.nameHint', {
                      defaultValue: '显示在会话列表与角色选择器里。',
                    })}
                  >
                    <div className="flex w-64 items-center gap-2">
                      <span
                        className={cn(selected?.builtin === true && 'pointer-events-none opacity-50')}
                        title={
                          selected?.builtin
                            ? t('settings.agents.builtinNameFixed', {
                                defaultValue: '内置角色的名称固定',
                              })
                            : undefined
                        }
                      >
                        <IconPicker
                          value={draft.icon}
                          onChange={(icon) => setDraft({ ...draft, icon })}
                        />
                      </span>
                      <Input
                        className="h-8 bg-muted/50 text-sm"
                        placeholder={t('agent.namePlaceholder', { defaultValue: '角色名称' })}
                        value={draft.name}
                        // Identity is fixed for the built-in role: the server's save
                        // path for it edits the workspace defaults block and never
                        // writes a name or an icon. Editable fields that silently
                        // discard what you type are worse than read-only ones — with
                        // autosave there is no longer a button press to hint that the
                        // write was a no-op.
                        readOnly={selected?.builtin === true}
                        title={
                          selected?.builtin
                            ? t('settings.agents.builtinNameFixed', {
                                defaultValue: '内置角色的名称固定',
                              })
                            : undefined
                        }
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/*
                * 分工说明 sits above 人设提示词 on purpose: it is the field that
                * decides whether this role ever gets work, and the one people
                * forget to fill in. Putting it below a 140px textarea buried it.
                */}
              <SettingsSection
                title={t('settings.agents.dispatchHint', { defaultValue: '分工说明' })}
                description={t('settings.agents.dispatchHintHint', {
                  defaultValue:
                    '写给「决定把活派给谁」的那个模型看，不是写给这个角色自己看的。写清接什么、不接什么，最好带一个典型触发。留空则退回到人设首行。',
                })}
              >
                <SettingsCard>
                  <div className="p-3">
                    <div className="flex items-start gap-2">
                      <textarea
                        className="min-h-[52px] w-full resize-y rounded-md border border-input bg-muted/50 p-2 text-[13px] leading-relaxed"
                        maxLength={MAX_HINT_CHARS}
                        placeholder={t('settings.agents.dispatchHintPlaceholder', {
                          defaultValue: '例：改界面、调样式、排版与交互。不接后端接口与数据迁移。看到「页面／组件／配色／间距」就派给它。',
                        })}
                        value={draft.dispatchHint}
                        onChange={(e) => setDraft({ ...draft, dispatchHint: e.target.value })}
                      />
                      <span
                        className={cn(
                          'shrink-0 pt-2 text-[11px] tabular-nums',
                          draft.dispatchHint.length >= MAX_HINT_CHARS
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {draft.dispatchHint.length}/{MAX_HINT_CHARS}
                      </span>
                    </div>
                    {/*
                      * Every role's hint in one place. Routing fails when two roles
                      * describe themselves the same way, and a per-agent editor can
                      * never show that — the collision only exists between rows.
                      */}
                    <div className="mt-3 border-t pt-2.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[11px] text-muted-foreground">
                          {t('settings.agents.dispatchCompare', { defaultValue: '全部角色的分工（对照用）' })}
                        </span>
                        {headlineCollision ? (
                          <span className="text-[11px] text-destructive">
                            {t('settings.agents.dispatchCollision', {
                              defaultValue: '有 {{count}} 组分工完全一样，派活时会分不清',
                              count: collisionCount,
                            })}
                          </span>
                        ) : null}
                      </div>
                      <ul className="mt-1.5 space-y-1">
                        {agents.map((agent) => {
                          const mine = agent.id === (draft.id ?? selectedId)
                          const text = mine ? draft.dispatchHint.trim() : (agent.dispatchHint ?? '').trim()
                          return (
                            <li key={agent.id} className="flex gap-2 text-[11px] leading-snug">
                              <span
                                className={cn(
                                  'w-16 shrink-0 truncate',
                                  mine ? 'font-medium text-foreground' : 'text-muted-foreground',
                                )}
                              >
                                {agent.name}
                              </span>
                              <span
                                className={cn(
                                  'min-w-0 flex-1 break-words',
                                  text ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
                                )}
                              >
                                {text ||
                                  t('settings.agents.dispatchEmpty', {
                                    defaultValue: '未填（退回人设首行）',
                                  })}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </div>
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
                      className="min-h-[140px] w-full resize-y rounded-md border border-input bg-muted/50 p-2 font-mono text-xs leading-relaxed"
                      value={draft.persona}
                      onChange={(e) => setDraft({ ...draft, persona: e.target.value })}
                    />
                  </div>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.agents.dispatchAndMemory', { defaultValue: '派活与记忆' })}
                description={t('settings.agents.dispatchAndMemoryHint', {
                  defaultValue: '控制这个角色出现在谁的派活名单里、它的记忆归哪个家。',
                })}
              >
                <SettingsCard>
                  <div className="flex items-center gap-2 p-3 text-[13px]">
                    <input
                      type="checkbox"
                      id="agent-assignable"
                      className="h-4 w-4"
                      checked={draft.assignable === true}
                      onChange={(e) => setDraft({ ...draft, assignable: e.target.checked })}
                    />
                    <label htmlFor="agent-assignable" className="cursor-pointer">
                      {t('settings.agents.assignable', { defaultValue: '可分配任务' })}
                    </label>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.agents.assignableHint', {
                        defaultValue: '开启后才会出现在任务派活名单里（分工说明给督导看）',
                      })}
                    </span>
                  </div>
                  <SettingsSelectRow
                    label={t('settings.agents.memoryDomain', { defaultValue: '记忆域' })}
                    value={draft.memoryDomain ?? ''}
                    onValueChange={(next) =>
                      setDraft({ ...draft, memoryDomain: next || undefined })
                    }
                    options={memoryDomainOptions}
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection title={t('settings.agents.defaults', { defaultValue: '默认值' })}>
                <SettingsCard>
                  <SettingsSelectRow
                    label={t('settings.agents.defaultStrategy', { defaultValue: '默认策略组' })}
                    value={draft.defaults.strategy ?? '__follow'}
                    onValueChange={(next) =>
                      setDraft({
                        ...draft,
                        defaults: { ...draft.defaults, strategy: next === '__follow' ? null : next },
                      })
                    }
                    options={strategyOptions}
                  />
                  <SettingsSelectRow
                    label={t('settings.agents.defaultPermission', { defaultValue: '默认权限模式' })}
                    value={draft.defaults.permissionMode ?? '__follow'}
                    onValueChange={(next) =>
                      setDraft({
                        ...draft,
                        defaults: {
                          ...draft.defaults,
                          permissionMode:
                            next === '__follow'
                              ? null
                              : (next as AgentDraft['defaults']['permissionMode']),
                        },
                      })
                    }
                    options={permissionOptions}
                  />
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

              <div className="flex min-h-8 items-center gap-3 pb-2">
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
                {/*
                  * A status word, not a button. Saving is no longer an action the
                  * user takes, so the only thing worth showing is the result:
                  * nothing while idle, a brief 「已保存」, and a persistent
                  * 「保存失败」 if the write did not land. Failure has to stay on
                  * screen — a silent autosave that quietly dropped a change is
                  * worse than a button you forgot to press.
                  */}
                <span
                  role="status"
                  aria-live="polite"
                  className={cn(
                    'text-[11px] tabular-nums',
                    status === 'error' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {status === 'saving'
                    ? t('settings.agents.saving', { defaultValue: '保存中…' })
                    : status === 'saved'
                      ? t('settings.agents.saved', { defaultValue: '已保存' })
                      : status === 'error'
                        ? t('settings.agents.saveFailed', { defaultValue: '保存失败' })
                        : ''}
                </span>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
