/**
 * Listener (plugin) detail — the page a card opens.
 *
 * Layout is five blocks, top to bottom, one unified section container each
 * (block title + border rhythm):
 *
 *   1. Title bar — name + version + status light …… 停用/启用 button
 *   2. Segmented switch — 详情 / 进程日志 (two-way)
 *   3. 详情 tab:
 *      · 介绍 — description + README tail + errors
 *      · 配置 — schema-driven fields (string / number / boolean), required vs
 *        optional marks, collapsed by default when every required value is
 *        filled, expanded + highlighted when one is missing; a
 *        plugin-provided HTML config UI (manifest `ui`) renders in a
 *        sandboxed iframe that receives Craft's day/night mode + palette
 *      · 依赖 — declared deps (Craft probed) + plugin-reported deps,
 *        detection logic untouched, restyled into the new layout
 *      · 内容 / 接收地址 — setup steps and the ingest endpoint
 *   4. 进程日志 tab — live log tail + process state (polled, probe-free)
 *
 * The status light is the same component + mapping as the plugin list, so
 * the two columns never disagree.
 */

import * as React from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Play,
  RefreshCw,
  ScrollText,
  Square,
} from 'lucide-react'
import type {
  ListenerDto,
  ListenerDependencyDto,
  ListenerReportedDepDto,
  ListenerReportedDepsDto,
} from '@craft-agent/shared/protocol/dto'
import {
  configSectionInitiallyOpen,
  missingRequiredConfigValues,
} from '@craft-agent/shared/events/plugin-status'
import { useTheme } from '@/context/ThemeContext'
import { ListenerStatusLight } from './ListenerStatusLight'
import { PluginConfigUiFrame } from './PluginConfigUiFrame'

export interface ListenerDetailPanelProps {
  workspaceId: string
  listenerId: string
  className?: string
}

/**
 * The one section container every block uses: a title row (block title left,
 * optional aside right) over a padded body, separated by a border-b rhythm —
 * the same container across 介绍 / 配置 / 依赖 / 接收地址 so the page reads
 * as a stack of equal blocks, not ad-hoc divs.
 */
function Section({
  title,
  aside,
  children,
}: {
  title: React.ReactNode
  aside?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className="text-xs font-medium text-foreground/80 min-w-0 truncate">{title}</div>
        {aside != null && <div className="ml-auto flex items-center gap-1.5 shrink-0 min-w-0">{aside}</div>}
      </div>
      {children != null && <div className="px-4 pb-3">{children}</div>}
    </section>
  )
}

function CopyButton({ value, label }: { value: string; label: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="h-6 px-1.5 inline-flex items-center gap-1 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground transition-colors shrink-0"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? '已复制' : label}
    </button>
  )
}

function DependencyRow({
  dep,
  onInstall,
  onInstallMcp,
  installing,
  installingMcp,
}: {
  dep: ListenerDependencyDto
  onInstall: (dep: ListenerDependencyDto) => void
  onInstallMcp: (dep: ListenerDependencyDto) => void
  installing: boolean
  installingMcp: boolean
}): React.ReactElement {
  const ok = dep.state === 'ok'
  const informational = dep.state === 'not_required'

  return (
    <div className="flex items-center gap-2 py-1 text-[11px]">
      <span className="w-40 shrink-0 font-mono truncate" title={dep.label}>
        {dep.label}
      </span>
      <span className="w-24 shrink-0 text-muted-foreground truncate" title={dep.requirement}>
        {dep.requirement}
      </span>
      <span className={`flex-1 min-w-0 truncate ${ok ? 'text-primary' : informational ? 'text-muted-foreground' : 'text-destructive'}`}>
        {ok && `✅ 已安装${dep.found ? ` ${dep.found}` : ''}`}
        {dep.state === 'missing' && '❌ 未安装'}
        {dep.state === 'mismatch' && `⚠️ 版本不满足${dep.found ? `（当前 ${dep.found}）` : ''}`}
        {dep.state === 'unknown' && '⚠️ 无法检测'}
        {informational && '➖ 已配置'}
      </span>
      {dep.kind === 'mcp' && dep.state === 'missing' && (
        <button
          type="button"
          disabled={installingMcp}
          onClick={() => onInstallMcp(dep)}
          className="h-6 px-2 inline-flex items-center gap-1 rounded border border-border text-[11px] hover:bg-accent disabled:opacity-50 shrink-0"
        >
          <Download className="h-3 w-3" />
          {installingMcp ? '安装中…' : '安装'}
        </button>
      )}
      {dep.kind === 'package' && dep.installHint && (dep.state === 'missing' || dep.state === 'mismatch') && (
        <button
          type="button"
          disabled={installing}
          onClick={() => onInstall(dep)}
          className="h-6 px-2 inline-flex items-center gap-1 rounded border border-border text-[11px] hover:bg-accent disabled:opacity-50 shrink-0"
        >
          <Download className="h-3 w-3" />
          {installing ? '安装中…' : '安装'}
        </button>
      )}
    </div>
  )
}

/**
 * Plugin-reported dependencies — the optional control service. Polls while
 * an action is running; a plugin without completion semantics just stays
 * clickable and the user re-checks via the refresh button. Detection logic
 * is untouched here — only the layout moved into the shared Section.
 */
function ReportedDepsSection({
  workspaceId,
  listenerId,
  initial,
}: {
  workspaceId: string
  listenerId: string
  initial: ListenerReportedDepsDto
}): React.ReactElement {
  const [state, setState] = React.useState<ListenerReportedDepsDto>(initial)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const pollRef = React.useRef(0)

  const refresh = React.useCallback(async (): Promise<ListenerReportedDepsDto | null> => {
    try {
      const next = await window.electronAPI.getListenerReportedDeps(workspaceId, listenerId)
      setState(next)
      return next
    } catch {
      return null
    }
  }, [workspaceId, listenerId])

  const trigger = async (dep: ListenerReportedDepDto) => {
    if (busyId) return
    setBusyId(dep.id)
    try {
      await window.electronAPI.listenerDepAction(workspaceId, listenerId, dep.id)
    } catch {
      // The next refresh surfaces the failure state.
    }
    // Poll while any action is running (cap ~5 min). Actions without a
    // completion callback never set running → the loop exits after one poll.
    const poll = pollRef.current + 1
    pollRef.current = poll
    for (let round = 0; round < 150; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (pollRef.current !== poll) return // superseded by a newer action
      const next = await refresh()
      const running = next?.control === true && (next.deps ?? []).some((d) => d.action?.running === true)
      if (!running) break
    }
    setBusyId(null)
  }

  const deps = state.control === true ? state.deps ?? [] : null

  return (
    <Section
      title="依赖状态（插件提供）"
      aside={
        <>
          {state.control === false && state.reason && (
            <span className="text-[11px] text-muted-foreground truncate">未提供（{state.reason}）</span>
          )}
          <button
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void refresh().finally(() => setRefreshing(false))
            }}
            className="h-5 px-1 inline-flex items-center rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </>
      }
    >
      {deps && deps.length > 0 && (
        <div className="divide-y divide-border/50">
          {deps.map((dep) => (
            <div key={dep.id} className="flex items-center gap-2 py-1 text-[11px]">
              <span className="w-40 shrink-0 font-mono truncate" title={dep.name}>
                {dep.name}
              </span>
              <span className={`flex-1 min-w-0 truncate ${dep.installed ? 'text-primary' : 'text-destructive'}`}>
                {dep.installed
                  ? `✅ 已安装${dep.version ? ` ${dep.version}` : ''}`
                  : dep.error
                    ? `❌ ${dep.error}`
                    : '❌ 未安装'}
                {dep.detail && <span className="text-muted-foreground"> · {dep.detail}</span>}
              </span>
              {dep.action && (
                <button
                  type="button"
                  disabled={Boolean(busyId) || dep.action.running === true}
                  onClick={() => void trigger(dep)}
                  className="h-6 px-2 inline-flex items-center gap-1 rounded border border-border text-[11px] hover:bg-accent disabled:opacity-50 shrink-0"
                >
                  {dep.action.running === true || busyId === dep.id ? '执行中…' : dep.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {deps && deps.length === 0 && (
        <p className="text-[11px] text-muted-foreground">插件未报告任何依赖。</p>
      )}
      {state.control === false && !state.reason && (
        <p className="text-[11px] text-muted-foreground">该插件未提供依赖状态服务。</p>
      )}
    </Section>
  )
}

export function ListenerDetailPanel({
  workspaceId,
  listenerId,
  className,
}: ListenerDetailPanelProps): React.ReactElement {
  const { isDark } = useTheme()

  const [listener, setListener] = React.useState<ListenerDto | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [installLog, setInstallLog] = React.useState<string | null>(null)
  const [installingDep, setInstallingDep] = React.useState<string | null>(null)
  const [installingMcp, setInstallingMcp] = React.useState<string | null>(null)
  const [depsOpen, setDepsOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Record<string, unknown>>({})
  const [dirty, setDirty] = React.useState(false)
  const [tab, setTab] = React.useState<'details' | 'log'>('details')
  /** null = not yet resolved; the shared rule decides on first load. */
  const [configOpen, setConfigOpen] = React.useState<boolean | null>(null)
  const [uiDoc, setUiDoc] = React.useState<{ html: string | null; source?: 'file' | 'inline' } | null>(null)
  const [logTail, setLogTail] = React.useState<string | null>(null)

  // Fresh state per plugin — the resolved default-collapsed state and the
  // tab choice belong to one plugin, not to the panel component.
  React.useEffect(() => {
    setConfigOpen(null)
    setTab('details')
    setLogTail(null)
    setUiDoc(null)
    setDraft({})
    setDirty(false)
    setDepsOpen(false)
  }, [listenerId])

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const result = await window.electronAPI.getEventListener(workspaceId, listenerId)
      setListener(result)
      if (result) {
        // Seed the form from saved config, falling back to manifest
        // defaults — keeping the native value (a number stays a number, so
        // the type-aware inputs and the required check see what the server
        // actually has).
        const seeded: Record<string, unknown> = {}
        for (const [key, schema] of Object.entries(result.configSchema?.properties ?? {})) {
          const saved = result.config[key]
          const value = saved ?? schema.default
          seeded[key] = value === undefined ? '' : value
        }
        setDraft(seeded)
        setDirty(false)
        // Default collapse resolves once (per plugin), from the shared pure
        // rule: open only when a required value is still blank.
        setConfigOpen((prev) => (prev === null ? configSectionInitiallyOpen(result.configSchema, seeded) : prev))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, listenerId])

  React.useEffect(() => {
    void load()
  }, [load])

  // The process side of the light: start / fail / stop events flip the
  // title-bar dot without a reload.
  React.useEffect(() => {
    const off = window.electronAPI.onEventListenerStatus((wsId, status) => {
      if (wsId !== workspaceId || status.id !== listenerId) return
      setListener((prev) => (prev ? { ...prev, status } : prev))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, listenerId])

  // The on-disk side: the toggle below, a saved config (including one posted
  // from the plugin's HTML form), or an installed dependency changes facts a
  // status event cannot carry — re-reading keeps light + required badges true.
  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventListenerChanged((wsId) => {
      if (wsId !== workspaceId) return
      void load()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, load])

  // The plugin's own HTML config document: fetched by the server (path
  // confined to the plugin directory), rendered by the sandboxed frame.
  const uiDeclared = listener ? Boolean(listener.ui) : false
  React.useEffect(() => {
    if (!uiDeclared) {
      setUiDoc(null)
      return
    }
    let cancelled = false
    window.electronAPI
      .getEventListenerUi(workspaceId, listenerId)
      .then((res) => {
        if (!cancelled) setUiDoc(res)
      })
      .catch(() => {
        if (!cancelled) setUiDoc(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, listenerId, uiDeclared])

  // 进程日志 tab: log tail + process state, polled (probe-free by design —
  // this never re-runs the dependency probes a list reload would skip too).
  const listenerRef = React.useRef<ListenerDto | null>(null)
  listenerRef.current = listener
  const pollLog = React.useCallback(async () => {
    if (!listenerRef.current) return
    try {
      const res = await window.electronAPI.getEventListenerLog(workspaceId, listenerId)
      setLogTail(res.logTail)
      setListener((prev) => (prev ? { ...prev, status: res.status } : prev))
    } catch {
      // A broken poll keeps the last tail; the next tick retries.
    }
  }, [workspaceId, listenerId])

  const onLogTab = tab === 'log' && listener !== null
  React.useEffect(() => {
    if (!onLogTab) return
    void pollLog()
    const timer = setInterval(() => {
      void pollLog()
    }, 3000)
    return () => clearInterval(timer)
  }, [onLogTab, pollLog])

  const saveConfig = async () => {
    if (!listener) return
    setBusy(true)
    try {
      await window.electronAPI.setEventListenerConfig(workspaceId, listener.id, draft)
      setDirty(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async () => {
    if (!listener) return
    setBusy(true)
    try {
      await window.electronAPI.setEventListenerEnabled(workspaceId, listener.id, !listener.enabled)
      // The server also pushes listener-changed; the explicit reload makes
      // the button feel instant even before the push lands.
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const install = async (dep: ListenerDependencyDto) => {
    if (!listener) return
    const manager = dep.label.startsWith('npm:') ? 'npm' : 'pip'
    const name = dep.label.slice(dep.label.indexOf(':') + 1)
    setInstallingDep(dep.label)
    setInstallLog(null)
    try {
      const result = await window.electronAPI.installEventListenerDependency(workspaceId, listener.id, {
        manager,
        name,
        range: dep.requirement,
      })
      setInstallLog(`${result.ok ? '✅' : '❌'} ${result.command}\n\n${result.output}`)
      await load()
    } catch (err) {
      setInstallLog(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstallingDep(null)
    }
  }

  const installMcp = async (dep: ListenerDependencyDto) => {
    if (!listener) return
    const mcpId = dep.label.startsWith('mcp:') ? dep.label.slice(4) : dep.label
    setInstallingMcp(dep.label)
    setInstallLog(null)
    try {
      const result = await window.electronAPI.installListenerMcp(workspaceId, listener.id, mcpId)
      setInstallLog(`${result.ok ? '✅' : '❌'} ${result.command || result.error || ''}\n\n${result.output}`)
      await load()
    } catch (err) {
      setInstallLog(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstallingMcp(null)
    }
  }

  if (error && !listener) {
    return <div className={`p-4 text-sm text-destructive ${className ?? ''}`}>{error}</div>
  }
  if (!listener) {
    return <div className={`p-4 text-sm text-muted-foreground ${className ?? ''}`}>加载中…</div>
  }

  const schema = listener.configSchema
  const schemaEntries = Object.entries(schema?.properties ?? {})
  const requiredKeys = schema?.required ?? []
  // Live (draft-aware) required check — the same pure rule as the default
  // collapse, so the highlight and the open/closed state never disagree.
  const missingKeys = missingRequiredConfigValues(schema, draft)
  const blocking = listener.dependencies.filter((d) => d.state === 'missing' || d.state === 'mismatch').length
  const hasConfigBlock = schemaEntries.length > 0 || Boolean(listener.ui)

  return (
    <div className={`flex flex-col h-full overflow-hidden ${className ?? ''}`}>
      {/* Block 1 — title bar: name + version + light …… 停用/启用 (far right) */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <h2 className="text-sm font-medium min-w-0 flex-1 truncate">{listener.name}</h2>
        <span className="text-[11px] font-mono text-muted-foreground shrink-0">v{listener.version}</span>
        <ListenerStatusLight listener={listener} size="md" showLabel />
        <button
          type="button"
          disabled={busy || listener.errors.length > 0}
          onClick={() => void toggleEnabled()}
          className={`h-7 px-2.5 shrink-0 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors ${
            listener.enabled
              ? 'bg-muted text-foreground hover:bg-accent'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          } disabled:opacity-50`}
        >
          {listener.enabled ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {listener.enabled ? '停用' : '启用'}
        </button>
      </div>

      {/* Block 2 — segmented switch: 详情 / 进程日志 */}
      <div className="px-4 py-2 border-b border-border">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border p-0.5" role="tablist" aria-label="详情视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'details'}
            onClick={() => setTab('details')}
            className={`h-6 px-2.5 inline-flex items-center gap-1.5 rounded text-[11px] transition-colors ${
              tab === 'details' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="h-3 w-3" />
            详情
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'log'}
            onClick={() => setTab('log')}
            className={`h-6 px-2.5 inline-flex items-center gap-1.5 rounded text-[11px] transition-colors ${
              tab === 'log' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <ScrollText className="h-3 w-3" />
            进程日志
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'details' ? (
          <>
            {/* Block 3 — 介绍: description + README tail + errors */}
            <Section title="介绍">
              <div className="space-y-2">
                <p className="text-[12px] leading-5 text-foreground/70">{listener.description ?? '（无介绍）'}</p>
                {listener.readme && (
                  <details>
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                      README
                    </summary>
                    <pre className="mt-1.5 text-[11px] leading-4 whitespace-pre-wrap break-words bg-muted/40 rounded p-2 max-h-64 overflow-auto text-foreground/75">
                      {listener.readme}
                    </pre>
                  </details>
                )}
                {listener.errors.length > 0 && (
                  <div className="text-[11px] text-destructive space-y-0.5">
                    {listener.errors.map((message) => (
                      <div key={message} className="flex items-start gap-1">
                        <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
                        <span>{message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {listener.status.state === 'failed' && listener.startupErrorTail && (
                  <details>
                    <summary className="text-[11px] text-destructive cursor-pointer">
                      启动失败日志（尾部）
                    </summary>
                    <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
                      {listener.startupErrorTail}
                    </pre>
                  </details>
                )}
              </div>
            </Section>

            {/* Block 4 — 配置: schema fields + required marks + optional HTML UI */}
            {hasConfigBlock && (
              <Section
                title={
                  <button
                    type="button"
                    onClick={() => setConfigOpen((v) => !(v ?? true))}
                    className="flex items-center gap-1.5 -ml-1 px-1 py-0.5 rounded text-xs font-medium text-foreground/80 hover:text-foreground"
                  >
                    {configOpen !== false ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    配置
                  </button>
                }
                aside={
                  missingKeys.length > 0 ? (
                    <span className="text-[11px] text-destructive shrink-0">{missingKeys.length} 项必填未填</span>
                  ) : null
                }
              >
                {configOpen !== false && (
                  <div className="space-y-2">
                    {schemaEntries.length > 0 && (
                      <div className="space-y-1">
                        {schemaEntries.map(([key, prop]) => {
                          const isRequired = requiredKeys.includes(key)
                          const isMissing = missingKeys.includes(key)
                          return (
                            <div
                              key={key}
                              className={`flex items-center gap-2 px-2 py-1 rounded border ${
                                isMissing ? 'bg-destructive/5 border-destructive/40' : 'border-transparent'
                              }`}
                            >
                              <label className="w-28 shrink-0 text-[11px] text-muted-foreground truncate" title={prop.description}>
                                {prop.title ?? key}
                                {isRequired && (
                                  <span className="text-destructive" aria-hidden>
                                    *
                                  </span>
                                )}
                              </label>
                              <span
                                className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${
                                  isRequired ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'
                                }`}
                              >
                                {isRequired ? '必填' : '可选'}
                              </span>
                              {prop.type === 'number' ? (
                                <input
                                  type="number"
                                  value={draft[key] === undefined || draft[key] === null ? '' : String(draft[key])}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    setDraft((prev) => ({ ...prev, [key]: raw === '' ? '' : Number(raw) }))
                                    setDirty(true)
                                  }}
                                  placeholder={prop.description ?? ''}
                                  className="flex-1 min-w-0 h-7 px-2 text-xs font-mono bg-muted/50 rounded border border-transparent focus:border-border focus:outline-none"
                                />
                              ) : prop.type === 'boolean' ? (
                                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={draft[key] === true}
                                    onChange={(e) => {
                                      setDraft((prev) => ({ ...prev, [key]: e.target.checked }))
                                      setDirty(true)
                                    }}
                                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                                  />
                                  {draft[key] === true ? '开' : '关'}
                                </label>
                              ) : (
                                <input
                                  type={prop.secret ? 'password' : 'text'}
                                  value={draft[key] === undefined || draft[key] === null ? '' : String(draft[key])}
                                  onChange={(e) => {
                                    setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                                    setDirty(true)
                                  }}
                                  placeholder={prop.description ?? ''}
                                  className="flex-1 min-w-0 h-7 px-2 text-xs font-mono bg-muted/50 rounded border border-transparent focus:border-border focus:outline-none"
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {uiDoc?.html && (
                      <div className="space-y-1">
                        <div className="text-[11px] text-muted-foreground">插件提供的自定义配置界面</div>
                        <PluginConfigUiFrame
                          html={uiDoc.html}
                          isDark={isDark}
                          configSchema={schema}
                          config={draft}
                          onConfigUpdate={(patch) => {
                            setDraft((prev) => ({ ...prev, ...patch }))
                            setDirty(true)
                          }}
                        />
                      </div>
                    )}
                    {listener.ui && !uiDoc?.html && (
                      <p className="text-[11px] text-destructive">自定义配置界面不可用（文件缺失或读取失败）。</p>
                    )}
                    {missingKeys.length > 0 && (
                      <p className="text-[11px] text-destructive">还缺：{missingKeys.join(', ')}</p>
                    )}
                    {dirty && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveConfig()}
                        className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
                      >
                        保存配置
                      </button>
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* Block 5 — 依赖: Craft-probed declared deps, restyled into the
                Section; detection logic untouched. */}
            {listener.dependencies.length > 0 && (
              <Section
                title={
                  <button
                    type="button"
                    onClick={() => setDepsOpen((v) => !v)}
                    className="flex items-center gap-1.5 -ml-1 px-1 py-0.5 rounded text-xs font-medium text-foreground/80 hover:text-foreground"
                  >
                    {depsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    依赖
                  </button>
                }
                aside={
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {listener.dependencies.length} 项
                    {blocking > 0 && <span className="text-destructive"> · {blocking} 未满足</span>}
                  </span>
                }
              >
                {depsOpen && (
                  <div>
                    <div className="divide-y divide-border/50">
                      {listener.dependencies.map((dep) => (
                        <DependencyRow
                          key={dep.label}
                          dep={dep}
                          installing={installingDep === dep.label}
                          installingMcp={installingMcp === dep.label}
                          onInstall={(target) => void install(target)}
                          onInstallMcp={(target) => void installMcp(target)}
                        />
                      ))}
                    </div>
                    {installLog && (
                      <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto">
                        {installLog}
                      </pre>
                    )}
                  </div>
                )}
              </Section>
            )}

            {listener.controlDeps && (
              <ReportedDepsSection workspaceId={workspaceId} listenerId={listener.id} initial={listener.controlDeps} />
            )}

            {/* 内容 / 接收地址 — setup steps + the ingest endpoint */}
            <Section title="内容 / 接收地址">
              <div className="space-y-2">
                {listener.setup.length > 0 && (
                  <ol className="list-decimal list-inside space-y-0.5">
                    {listener.setup.map((step) => (
                      <li key={step.text} className="text-[11px] text-muted-foreground">
                        {step.text}
                        {step.link && (
                          <a href={step.link} className="text-primary hover:underline ml-1 break-all">
                            {step.link}
                          </a>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 text-[11px] font-mono bg-muted/40 rounded px-2 py-1 truncate">
                    {`<CRAFT_EVENTS_URL>`} · 监听器 <code className="font-mono">{listener.id}</code>
                  </code>
                  <CopyButton value={listener.id} label="复制 id" />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  启用后 Craft 会启动该插件，并把 <code className="font-mono">CRAFT_EVENTS_URL</code>/
                  <code className="font-mono">CRAFT_EVENTS_TOKEN</code> 注入其环境变量，插件向该地址 POST 事件。
                </p>
              </div>
            </Section>
          </>
        ) : (
          /* 进程日志 tab — live log tail + process state */
          <Section
            title="进程日志"
            aside={
              <button
                type="button"
                onClick={() => void pollLog()}
                className="h-6 px-1.5 inline-flex items-center gap-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground shrink-0"
                title="刷新"
              >
                <RefreshCw className="h-3 w-3" />
                刷新
              </button>
            }
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ListenerStatusLight listener={listener} size="md" showLabel />
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  pid {listener.status.pid ?? '—'} · 重启 {listener.status.attempts} 次
                </span>
              </div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-96 min-h-24 overflow-auto">
                {logTail && logTail.length > 0 ? logTail : '（暂无日志）'}
              </pre>
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}
