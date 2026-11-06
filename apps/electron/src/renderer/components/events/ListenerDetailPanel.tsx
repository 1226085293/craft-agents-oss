/**
 * Listener detail — the page a card opens.
 *
 * Order is deliberate (top to bottom): version → name → description → config →
 * dependencies (collapsed) → setup steps → ingest endpoint. Configuration comes
 * before dependencies because a user with a broken config gets nothing useful
 * from a dependency list.
 */

import * as React from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Download, Play, RefreshCw, Square } from 'lucide-react'
import type {
  ListenerDto,
  ListenerDependencyDto,
  ListenerReportedDepDto,
  ListenerReportedDepsDto,
} from '@craft-agent/shared/protocol/dto'
import { PluginIcon } from './EventsListenersPanel'

export interface ListenerDetailPanelProps {
  workspaceId: string
  listenerId: string
  className?: string
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
 * Listener-reported dependencies — the optional control service. Polls while
 * an action is running; a listener without completion semantics just stays
 * clickable and the user re-checks via the refresh button.
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
    <div className="px-4 py-3 border-b border-border">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">依赖状态（插件提供）</span>
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
        {state.control === false && state.reason && (
          <span className="text-[11px] text-muted-foreground truncate">未提供（{state.reason}）</span>
        )}
      </div>
      {deps && deps.length > 0 && (
        <div className="mt-2 divide-y divide-border/50">
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
        <p className="text-[11px] text-muted-foreground mt-1">插件未报告任何依赖。</p>
      )}
    </div>
  )
}

export function ListenerDetailPanel({
  workspaceId,
  listenerId,
  className,
}: ListenerDetailPanelProps): React.ReactElement {
  const [listener, setListener] = React.useState<ListenerDto | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [installLog, setInstallLog] = React.useState<string | null>(null)
  const [installingDep, setInstallingDep] = React.useState<string | null>(null)
  const [installingMcp, setInstallingMcp] = React.useState<string | null>(null)
  const [depsOpen, setDepsOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [dirty, setDirty] = React.useState(false)

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const result = await window.electronAPI.getEventListener(workspaceId, listenerId)
      setListener(result)
      if (result) {
        // Seed the form from saved config, falling back to manifest defaults.
        const seeded: Record<string, string> = {}
        for (const [key, schema] of Object.entries(result.configSchema?.properties ?? {})) {
          const saved = result.config[key]
          const value = saved ?? schema.default ?? ''
          seeded[key] = value === undefined || value === null ? '' : String(value)
        }
        setDraft(seeded)
        setDirty(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, listenerId])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    const off = window.electronAPI.onEventListenerStatus((wsId, status) => {
      if (wsId !== workspaceId || status.id !== listenerId) return
      setListener((prev) => (prev ? { ...prev, status } : prev))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, listenerId])

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

  const schemaEntries = Object.entries(listener.configSchema?.properties ?? {})
  const blocking = listener.dependencies.filter((d) => d.state === 'missing' || d.state === 'mismatch').length

  return (
    <div className={`flex flex-col h-full overflow-y-auto ${className ?? ''}`}>
      {/* Header: icon, then name with its version beside it. The version used
          to sit alone on the right edge, which read as a separate fact rather
          than as part of the plugin's identity. */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <PluginIcon name={listener.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="text-base font-medium min-w-0 break-words">{listener.name}</h2>
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">v{listener.version}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{listener.description ?? '（无介绍）'}</p>

        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            disabled={busy || listener.errors.length > 0}
            onClick={() => void toggleEnabled()}
            className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors ${
              listener.enabled
                ? 'bg-muted text-foreground hover:bg-accent'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            } disabled:opacity-50`}
          >
            {listener.enabled ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {listener.enabled ? '停用' : '启用'}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {listener.status.state === 'running' && '运行中'}
            {listener.status.state === 'starting' && '启动中'}
            {listener.status.state === 'degraded' && '已启动但未上报健康'}
            {listener.status.state === 'failed' && `异常：${listener.status.lastError ?? '未知'}`}
            {listener.status.state === 'stopped' && (listener.enabled ? '已启用，未运行' : '已停用')}
          </span>
        </div>

        {listener.errors.length > 0 && (
          <div className="mt-2 text-[11px] text-destructive space-y-0.5">
            {listener.errors.map((message) => (
              <div key={message} className="flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
                <span>{message}</span>
              </div>
            ))}
          </div>
        )}

        {listener.status.state === 'failed' && listener.startupErrorTail && (
          <details className="mt-2">
            <summary className="text-[11px] text-destructive cursor-pointer">
              启动失败日志（尾部 30 行）
            </summary>
            <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
              {listener.startupErrorTail}
            </pre>
          </details>
        )}
      </div>

      {/* Config — one block per field: label above input, hint underneath.
          The old single row (label 28 wide, input beside it) forced long
          Chinese hints into a placeholder, so a token field explained nothing. */}
      {schemaEntries.length > 0 && (
        <div className="px-4 py-3 border-b border-border space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium">配置</span>
            {listener.missingConfig.length > 0 && (
              <span className="text-[11px] text-destructive">
                还缺 {listener.missingConfig.length} 项
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {schemaEntries.map(([key, schema]) => {
              const required = (listener.configSchema?.required ?? []).includes(key)
              const value = draft[key] ?? ''
              const missing = required && String(value).trim() === ''
              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <label className="text-[11px] font-medium text-foreground/80">
                      {schema.title ?? key}
                    </label>
                    {required && missing && <span className="text-[10px] text-destructive">必填</span>}
                    {schema.secret && value !== '' && (
                      <span className="text-[10px] text-muted-foreground">已保存</span>
                    )}
                  </div>
                  <input
                    type={schema.secret ? 'password' : 'text'}
                    value={value}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, [key]: e.target.value }))
                      setDirty(true)
                    }}
                    placeholder={schema.secret ? '粘贴后保存' : ''}
                    className={`w-full h-7 px-2 text-xs font-mono rounded border bg-muted/40 focus:outline-none focus:bg-background ${
                      missing ? 'border-destructive/40' : 'border-border/50 focus:border-border'
                    }`}
                  />
                  {schema.description && (
                    <p className="text-[10px] leading-4 text-muted-foreground">{schema.description}</p>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void saveConfig()}
              className="h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-40"
            >
              保存配置
            </button>
            {dirty && <span className="text-[11px] text-muted-foreground">有未保存的改动</span>}
          </div>
        </div>
      )}

      {/* Dependencies (collapsed by default) */}
      {listener.dependencies.length > 0 && (
        <div className="px-4 py-3 border-b border-border">
          <button
            type="button"
            onClick={() => setDepsOpen((prev) => !prev)}
            className="flex items-center gap-1.5 text-xs font-medium w-full text-left"
          >
            {depsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            依赖工具（{listener.dependencies.length}）
            {blocking > 0 && <span className="text-[11px] text-destructive ml-1">{blocking} 项未满足</span>}
          </button>
          {depsOpen && (
            <div className="mt-2 divide-y divide-border/50">
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
          )}
          {installLog && (
            <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-40 overflow-auto">
              {installLog}
            </pre>
          )}
        </div>
      )}

      {/* Listener-reported dependencies (optional control service) */}
      {listener.controlDeps && (
        <ReportedDepsSection workspaceId={workspaceId} listenerId={listener.id} initial={listener.controlDeps} />
      )}

      {/* Setup steps */}
      {listener.setup.length > 0 && (
        <div className="px-4 py-3 border-b border-border space-y-1">
          <div className="text-xs font-medium">内容</div>
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
        </div>
      )}

      {/* Ingest endpoint + log tail */}
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">接收地址</span>
        </div>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 min-w-0 text-[11px] font-mono bg-muted/40 rounded px-2 py-1 truncate">
            {`<CRAFT_EVENTS_URL>`} · 插件 <code className="font-mono">{listener.id}</code>
          </code>
          <CopyButton value={listener.id} label="复制 id" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          启用后 Craft 会启动该插件，并把 <code className="font-mono">CRAFT_EVENTS_URL</code>/
          <code className="font-mono">CRAFT_EVENTS_TOKEN</code> 注入其环境变量，插件向该地址 POST 事件。
        </p>

        {listener.logTail && (
          <details className="pt-1">
            <summary className="text-[11px] text-muted-foreground cursor-pointer">进程日志</summary>
            <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2 max-h-48 overflow-auto">
              {listener.logTail}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
