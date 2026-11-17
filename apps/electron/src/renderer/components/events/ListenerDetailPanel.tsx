/**
 * Listener (plugin) detail — the page a card opens.
 *
 * Layout is five blocks, top to bottom, one unified section container each
 * (block title + border rhythm):
 *
 *   1. Title bar — icon + name, version right after it, then the status
 *      light; the 停用/启用 button alone on the far right
 *   2. Segmented switch — 详情 / 进程日志 (two-way, real tab semantics)
 *   3. 详情 tab:
 *      · 介绍 — description + README tail + errors
 *      · 配置 — schema-driven fields (string / number / boolean), required vs
 *        optional marks, collapsed by default when every required value is
 *        filled, expanded + highlighted when one is missing; a
 *        plugin-provided HTML config UI (manifest `ui`) renders in a
 *        sandboxed iframe that receives Craft's day/night mode + palette
 *      · 依赖 — one region, two sources: what Craft probed from the manifest
 *        (with install actions) and what the plugin reports through its own
 *        control service. Detection logic untouched, layout only.
 *      · 内容 — setup steps and the plugin's own page
 *   4. 进程日志 tab — live log tail + process state (polled, probe-free)
 *
 * The status light is the detail page's reading (the plugin list draws none),
 * and colour is never the only cue: every instance carries its sentence.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
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
import { configSectionInitiallyOpen, missingRequiredConfigValues } from '@craft-agent/shared/events/plugin-status'
import { useTheme } from '@/context/ThemeContext'
import { PluginIcon } from './EventsListenersPanel'
import { ListenerStatusLight } from './ListenerStatusLight'
import { PluginPageFrame } from './PluginPageFrame'
import { ListenerLogView } from './ListenerLogView'
import { ListenerPairingSection } from './ListenerPairingSection'

export interface ListenerDetailPanelProps {
  workspaceId: string
  listenerId: string
  className?: string
}

/**
 * The one section container every block uses.
 *
 * Type scale is deliberate and shared: a 14px semibold heading over 13px body at 1.65 leading.
 * The previous version printed headings at 12px and body at 11px, which is below the size at which
 * Chinese text reads comfortably — the sections looked like annotations on the page rather than
 * its structure, and that is why the layout was hard to scan no matter how it was arranged.
 */
function Section({
  title,
  aside,
  children,
  tone,
}: {
  title: React.ReactNode
  aside?: React.ReactNode
  children?: React.ReactNode
  /** `bad` tints the heading when the block is reporting a failure rather than a fact. */
  tone?: 'bad'
}): React.ReactElement {
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2.5">
        <div
          className={`min-w-0 truncate text-[14px] font-semibold ${
            tone === 'bad' ? 'text-destructive' : 'text-foreground'
          }`}
        >
          {title}
        </div>
        {aside != null && (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">{aside}</div>
        )}
      </div>
      {children != null && <div className="px-5 pb-4">{children}</div>}
    </section>
  )
}

/**
 * Text input for plugin config fields; when the schema marks the field
 * `secret`, it renders as a password box with an eye toggle at the right edge
 * (inside the field) to reveal/hide the plaintext — same interaction as the
 * credential request cards. Plain fields keep the ordinary text input.
 */
function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  secret,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}): React.ReactElement {
  const [revealed, setRevealed] = React.useState(false)
  const shared = 'h-8 min-w-0 flex-1 rounded-md border border-transparent bg-muted/50 px-2.5 font-mono text-[13px] focus:border-border focus:outline-none'
  if (!secret) {
    return (
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={shared}
      />
    )
  }
  return (
    <div className="relative flex min-w-0 flex-1">
      <input
        id={id}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        className={`${shared} pr-9`}
      />
      <button
        type="button"
        onClick={() => setRevealed((prev) => !prev)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        tabIndex={-1}
        aria-label={revealed ? 'Hide value' : 'Show value'}
      >
        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }): React.ReactElement {
  const { t } = useTranslation()
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
      className="h-8 shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t('events.common.copied') : label}
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
  const { t } = useTranslation()
  const ok = dep.state === 'ok'
  const informational = dep.state === 'not_required'

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
      <span className="w-44 shrink-0 truncate font-mono text-[12.5px]" title={dep.label}>
        {dep.label}
      </span>
      <span className="w-28 shrink-0 truncate text-[12.5px] text-muted-foreground" title={dep.requirement}>
        {dep.requirement}
      </span>
      <span className={`flex-1 min-w-0 truncate ${ok ? 'text-primary' : informational ? 'text-muted-foreground' : 'text-destructive'}`}>
        {ok && (dep.found
          ? t('events.listener.depInstalledVersion', { version: dep.found })
          : t('events.listener.depInstalled'))}
        {dep.state === 'missing' && t('events.listener.depMissing')}
        {dep.state === 'mismatch' && (dep.found
          ? t('events.listener.depMismatchCurrent', { version: dep.found })
          : t('events.listener.depMismatch'))}
        {dep.state === 'unknown' && t('events.listener.depUnknown')}
        {informational && t('events.listener.depConfigured')}
      </span>
      {dep.kind === 'mcp' && dep.state === 'missing' && (
        <button
          type="button"
          disabled={installingMcp}
          onClick={() => onInstallMcp(dep)}
          className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          {installingMcp ? t('events.listener.installing') : t('events.listener.install')}
        </button>
      )}
      {dep.kind === 'package' && dep.installHint && (dep.state === 'missing' || dep.state === 'mismatch') && (
        <button
          type="button"
          disabled={installing}
          onClick={() => onInstall(dep)}
          className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          {installing ? t('events.listener.installing') : t('events.listener.install')}
        </button>
      )}
    </div>
  )
}

/**
 * Plugin-reported dependencies — the optional control service. Polls while
 * an action is running; a plugin without completion semantics just stays
 * clickable and the user re-checks via the refresh button. Detection logic
 * is untouched here — this renders the second half of the 依赖 region.
 */
function ReportedDepsBody({
  workspaceId,
  listenerId,
  initial,
}: {
  workspaceId: string
  listenerId: string
  initial: ListenerReportedDepsDto
}): React.ReactElement {
  const { t } = useTranslation()
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
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] font-medium text-foreground/70">{t('events.listener.reported')}</span>
        {state.control === false && state.reason && (
          <span className="truncate text-[12.5px] text-muted-foreground">{t('events.listener.reportedNone', { reason: state.reason })}</span>
        )}
        <button
          type="button"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void refresh().finally(() => setRefreshing(false))
          }}
          className="ml-auto h-7 w-7 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
          title={t('events.listener.refresh')}
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {deps && deps.length > 0 && (
        <div className="divide-y divide-border/60 rounded-[7px] border border-border/70">
          {deps.map((dep) => (
            <div key={dep.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
              <span className="w-44 shrink-0 truncate font-mono text-[12.5px]" title={dep.name}>
                {dep.name}
              </span>
              <span className={`flex-1 min-w-0 truncate ${dep.installed ? 'text-primary' : 'text-destructive'}`}>
                {dep.installed
                  ? (dep.version
                      ? t('events.listener.depInstalledVersion', { version: dep.version })
                      : t('events.listener.depInstalled'))
                  : dep.error
                    ? `❌ ${dep.error}`
                    : t('events.listener.depMissing')}
                {dep.detail && <span className="text-muted-foreground"> · {dep.detail}</span>}
              </span>
              {dep.action && (
                <button
                  type="button"
                  disabled={Boolean(busyId) || dep.action.running === true}
                  onClick={() => void trigger(dep)}
                  className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] hover:bg-accent disabled:opacity-50"
                >
                  {dep.action.running === true || busyId === dep.id ? t('events.listener.depRunning') : dep.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {deps && deps.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground">{t('events.listener.depsNone')}</p>
      )}
      {state.control === false && !state.reason && (
        <p className="text-[12.5px] text-muted-foreground">{t('events.listener.depsNoService')}</p>
      )}
    </div>
  )
}

export function ListenerDetailPanel({
  workspaceId,
  listenerId,
  className,
}: ListenerDetailPanelProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const { isDark } = useTheme()

  const [listener, setListener] = React.useState<ListenerDto | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [installLog, setInstallLog] = React.useState<string | null>(null)
  const [installingDep, setInstallingDep] = React.useState<string | null>(null)
  const [installingMcp, setInstallingMcp] = React.useState<string | null>(null)
  const [depsOpen, setDepsOpen] = React.useState(true)
  const [draft, setDraft] = React.useState<Record<string, unknown>>({})
  const [dirty, setDirty] = React.useState(false)
  const [tab, setTab] = React.useState<'details' | 'log'>('details')
  // The switch is a real tablist: ←/→ (plus Home/End) move between the two
  // views and focus follows selection, so the keyboard path matches the one
  // the eye reads.
  const tabRefs = React.useRef<Record<'details' | 'log', HTMLButtonElement | null>>({
    details: null,
    log: null,
  })
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const order: Array<'details' | 'log'> = ['details', 'log']
    const index = order.indexOf(tab)
    let next: 'details' | 'log' | null = null
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length]
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length]
    else if (event.key === 'Home') next = order[0]
    else if (event.key === 'End') next = order[order.length - 1]
    if (!next) return
    event.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }
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
    setDepsOpen(true)
  }, [listenerId])

  const load = React.useCallback(async () => {
    setError(null)
    try {
      const result = await window.electronAPI.getEventListener(workspaceId, listenerId, i18n.resolvedLanguage ?? i18n.language)
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
  }, [workspaceId, listenerId, i18n.resolvedLanguage, i18n.language])

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
    // 1.5s rather than 3s: the manual refresh button is gone, so the only way this page can look
    // live is by asking often enough that a burst of output shows up while it is still happening.
    // The read is a file tail on the server — cheap, and only while this tab is open.
    const timer = setInterval(() => {
      void pollLog()
    }, 1500)
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
    return <div className={`p-4 text-sm text-muted-foreground ${className ?? ''}`}>{t('events.common.loading')}</div>
  }

  const schema = listener.configSchema
  const schemaEntries = Object.entries(schema?.properties ?? {})
  const requiredKeys = schema?.required ?? []
  // Live (draft-aware) required check — the same pure rule as the default
  // collapse, so the highlight and the open/closed state never disagree.
  const missingKeys = missingRequiredConfigValues(schema, draft)
  const blocking = listener.dependencies.filter((d) => d.state === 'missing' || d.state === 'mismatch').length
  const hasConfigBlock = schemaEntries.length > 0
  /**
   * What the plugin actually supplied.
   *
   * Every block used to render unconditionally, so a plugin that declared nothing produced a
   * page of headings each followed by an apology — 「（无介绍）」, an empty dependency list, an
   * ingest address for a plugin that only watches local files. A section is now evidence of a
   * fact; no fact, no section.
   */
  const hasIntro =
    Boolean(listener.description) ||
    Boolean(listener.readme) ||
    listener.errors.length > 0 ||
    (listener.status.state === 'failed' && Boolean(listener.startupErrorTail))
  /**
   * A dependency section needs dependency rows, not a payload that happens to exist.
   *
   * `Boolean(controlDeps)` was true whenever the plugin answered its control endpoint at all —
   * including `control: false` and an empty `deps` array — so a plugin that reports nothing still
   * grew a 依赖 heading over an empty body. The section exists to list what is missing or what can
   * be acted on; with neither, it is a heading over nothing.
   */
  const reportedDeps = listener.controlDeps?.control === true ? listener.controlDeps.deps ?? [] : []
  const hasDependencies = listener.dependencies.length > 0 || reportedDeps.length > 0
  const hasContent = listener.setup.length > 0 || Boolean(listener.ui)
  // Name the fields the user can see, not the schema keys.
  const missingTitles = missingKeys.map((key) => schema?.properties?.[key]?.title ?? key)

  /**
   * The native schema fields. Rendered straight out when the plugin ships no
   * HTML UI; folded under the plugin's own document when it does — the frame is
   * the intended surface there, but nothing becomes uneditable if the document
   * covers only part of the schema.
   */
  const nativeConfigFields =
    schemaEntries.length > 0 ? (
      <div className="space-y-1">
        {schemaEntries.map(([key, prop]) => {
          const isRequired = requiredKeys.includes(key)
          const isMissing = missingKeys.includes(key)
          // Manifest properties are copied through verbatim on the server, so a
          // plugin may carry numeric hints the DTO does not name yet. Read them
          // defensively and only when they are real numbers.
          const hints = prop as { min?: unknown; max?: unknown; step?: unknown }
          const min = typeof hints.min === 'number' ? hints.min : undefined
          const max = typeof hints.max === 'number' ? hints.max : undefined
          const step = typeof hints.step === 'number' && hints.step > 0 ? hints.step : undefined
          return (
            <div
              key={key}
              className={`flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 ${
                isMissing ? 'bg-destructive/5 border-destructive/40' : 'border-transparent'
              }`}
            >
              <label
                htmlFor={`listener-config-${key}`}
                className="w-32 shrink-0 truncate text-[12.5px] text-muted-foreground"
                title={prop.description}
              >
                {prop.title ?? key}
                {isRequired && (
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                )}
              </label>
              <span
                className={`shrink-0 rounded border px-1.5 text-[11.5px] leading-[18px] ${
                  isRequired ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'
                }`}
              >
                {isRequired ? t('events.listener.required') : t('events.listener.optional')}
              </span>
              {prop.type === 'number' ? (
                <input
                  id={`listener-config-${key}`}
                  type="number"
                  min={min}
                  max={max}
                  step={step ?? 'any'}
                  value={draft[key] === undefined || draft[key] === null ? '' : String(draft[key])}
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      setDraft((prev) => ({ ...prev, [key]: '' }))
                      setDirty(true)
                      return
                    }
                    const next = Number(raw)
                    // Half-typed values ("1e", "-.") must not become NaN in the draft.
                    if (!Number.isFinite(next)) return
                    setDraft((prev) => ({ ...prev, [key]: next }))
                    setDirty(true)
                  }}
                  placeholder={prop.description ?? ''}
                  className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-muted/50 px-2.5 font-mono text-[13px] focus:border-border focus:outline-none"
                />
              ) : prop.type === 'boolean' ? (
                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                  <input
                    id={`listener-config-${key}`}
                    type="checkbox"
                    checked={draft[key] === true}
                    onChange={(e) => {
                      setDraft((prev) => ({ ...prev, [key]: e.target.checked }))
                      setDirty(true)
                    }}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  {draft[key] === true ? t('events.listener.on') : t('events.listener.off')}
                </label>
              ) : (
                <SecretInput
                  id={`listener-config-${key}`}
                  value={draft[key] === undefined || draft[key] === null ? '' : String(draft[key])}
                  onChange={(v) => {
                    setDraft((prev) => ({ ...prev, [key]: v }))
                    setDirty(true)
                  }}
                  placeholder={prop.description ?? ''}
                  secret={prop.secret}
                />
              )}
            </div>
          )
        })}
      </div>
    ) : null

  const problemCount = listener.errors.length + (blocking > 0 ? blocking : 0)

  return (
    <div className={`flex flex-col h-full overflow-hidden ${className ?? ''}`}>
      {/*
        ── Identity ────────────────────────────────────────────────────────────
        Icon, name, version, state. Sized so that the plugin's name is unambiguously the page
        title (18px against 13px body), because the previous layout printed it at the same
        weight as the section headings below it and the page had no visual entry point.
      */}
      <header className="shrink-0 px-5 pt-4 pb-3.5 border-b border-border">
        <div className="flex items-start gap-3.5">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border/70 bg-foreground/[0.04]">
            <PluginIcon name={listener.icon} className="h-5 w-5 text-foreground/75" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <h1 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-foreground truncate">
                {listener.name}
              </h1>
              <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[12px] leading-[18px] tabular-nums text-muted-foreground">
                v{listener.version}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <ListenerStatusLight listener={listener} size="md" showLabel />
              {problemCount > 0 && (
                <span className="text-[12.5px] leading-5 text-destructive">
                  {listener.errors.length > 0
                    ? t('events.listener.issueCount', { count: listener.errors.length })
                    : t('events.listener.blockingCount', { count: blocking })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={busy || listener.errors.length > 0}
            onClick={() => void toggleEnabled()}
            className={`mt-0.5 h-8 px-3.5 shrink-0 inline-flex items-center gap-1.5 rounded-[7px] text-[13px] font-medium transition-colors ${
              listener.enabled
                ? 'border border-border text-foreground/85 hover:bg-foreground/[0.06]'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            } disabled:opacity-40`}
          >
            {listener.enabled ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {listener.enabled ? t('events.listener.disable') : t('events.listener.enable')}
          </button>
        </div>
      </header>

      {/*
        ── Tabs ────────────────────────────────────────────────────────────────
        Underline grammar, at body size. The pill switch this replaced sat in its own bordered
        row and read as a segmented control for a toolbar, not as navigation between two
        readings of one object.
      */}
      <div className="shrink-0 px-5 border-b border-border" role="tablist" aria-label={t('events.listener.views')}>
        {([
          { id: 'details' as const, label: t('events.listener.tabDetails'), Icon: FileText },
          { id: 'log' as const, label: t('events.listener.tabLog'), Icon: ScrollText },
        ]).map(({ id, label, Icon }) => (
          <button
            key={id}
            ref={(node) => {
              tabRefs.current[id] = node
            }}
            type="button"
            role="tab"
            id={`listener-tab-${id}`}
            aria-controls={`listener-tabpanel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={onTabKeyDown}
            className={`-mb-px mr-6 inline-flex items-center gap-2 border-b-2 h-10 text-[13.5px] font-medium transition-colors ${
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {id === 'log' && problemCount > 0 && (
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden />
            )}
          </button>
        ))}
      </div>

      {tab === 'log' ? (
        <div
          role="tabpanel"
          id="listener-tabpanel-log"
          aria-labelledby="listener-tab-log"
          className="flex-1 min-h-0 focus:outline-none"
        >
          <ListenerLogView logTail={logTail} status={listener.status} onRefresh={() => void pollLog()} />
        </div>
      ) : (
        <div
          role="tabpanel"
          id="listener-tabpanel-details"
          aria-labelledby="listener-tab-details"
          className="flex-1 min-h-0 overflow-y-auto focus:outline-none"
        >
          {/* Problems lead: a broken plugin is why the page was opened. */}
          {listener.errors.length > 0 && (
            <Section title={t('events.listener.sectionProblems')} tone="bad">
              <ul className="space-y-2">
                {listener.errors.map((message) => (
                  <li
                    key={message}
                    className="flex items-start gap-2 rounded-[7px] border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-[13px] leading-5 text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 break-words">{message}</span>
                  </li>
                ))}
                {listener.warnings.map((message) => (
                  <li
                    key={message}
                    className="flex items-start gap-2 rounded-[7px] border border-border/70 bg-foreground/[0.03] px-3 py-2 text-[13px] leading-5 text-foreground/70"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 opacity-60" />
                    <span className="min-w-0 break-words">{message}</span>
                  </li>
                ))}
              </ul>
              {listener.status.state === 'failed' && listener.startupErrorTail && (
                <details className="mt-3">
                  <summary className="cursor-pointer select-none text-[12.5px] text-destructive">
                    {t('events.listener.startFailureLog')}
                  </summary>
                  <pre className="mt-2 max-h-52 overflow-auto rounded-[7px] bg-muted/50 p-3 font-mono text-[12px] leading-[1.65] whitespace-pre-wrap break-all">
                    {listener.startupErrorTail}
                  </pre>
                </details>
              )}
            </Section>
          )}

          {hasIntro && (
            <Section title={t('events.listener.sectionAbout')}>
              <div className="space-y-3">
                {listener.description && (
                  <p className="text-[13.5px] leading-[1.7] text-foreground/80">{listener.description}</p>
                )}
                {listener.homepage && (
                  <a
                    href={listener.homepage}
                    className="inline-block break-all text-[12.5px] text-primary hover:underline"
                  >
                    {listener.homepage}
                  </a>
                )}
                {listener.readme && (
                  <details>
                    <summary className="cursor-pointer select-none text-[12.5px] text-muted-foreground hover:text-foreground">
                      README
                    </summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-[7px] bg-muted/50 p-3 text-[12.5px] leading-[1.7] whitespace-pre-wrap break-words text-foreground/80">
                      {listener.readme}
                    </pre>
                  </details>
                )}
              </div>
            </Section>
          )}

          {/* Manifest `channels` (derived from isMessagingListener: an
            * action with repliesToOrigin): the pairing block for chat channels.
            * Only platform plugins (telegram / wechat / whatsapp / lark / qq)
            * satisfy the predicate, so the section never shows elsewhere. */}
          {listener.channels && (
            <Section title={t('events.listener.pairing.title')}>
              <ListenerPairingSection workspaceId={workspaceId} listenerId={listenerId} />
            </Section>
          )}

          {hasConfigBlock && (
            <Section
              title={
                <button
                  type="button"
                  onClick={() => setConfigOpen((v) => !(v ?? true))}
                  className="-ml-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[14px] font-semibold text-foreground hover:text-foreground/80"
                >
                  {configOpen !== false ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  {t('events.listener.config')}
                </button>
              }
              aside={
                missingKeys.length > 0 ? (
                  <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[12px] text-destructive">
                    {t('events.listener.missingRequired', { count: missingKeys.length })}
                  </span>
                ) : null
              }
            >
              {configOpen !== false && (
                <div className="space-y-3">
                  {nativeConfigFields}
                  {missingKeys.length > 0 && (
                    <p className="text-[12.5px] text-destructive">{t('events.listener.stillMissing', { titles: missingTitles.join('、') })}</p>
                  )}
                  {dirty && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={busy || missingKeys.length > 0}
                        onClick={() => void saveConfig()}
                        className="h-8 rounded-[7px] bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {t('events.listener.saveConfig')}
                      </button>
                      {missingKeys.length > 0 && (
                        <span className="text-[12.5px] text-destructive">{t('events.listener.fillRequiredFirst')}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {hasDependencies && (
            <Section
              title={
                <button
                  type="button"
                  onClick={() => setDepsOpen((v) => !v)}
                  className="-ml-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[14px] font-semibold text-foreground hover:text-foreground/80"
                >
                  {depsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {t('events.listener.dependencies')}
                </button>
              }
              aside={
                listener.dependencies.length > 0 ? (
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    {t('events.listener.depItems', { count: listener.dependencies.length })}
                    {blocking > 0 && <span className="text-destructive">{t('events.listener.depUnmet', { count: blocking })}</span>}
                  </span>
                ) : null
              }
            >
              {depsOpen && (
                <div className="space-y-3">
                  {listener.dependencies.length > 0 && (
                    <div>
                      {reportedDeps.length > 0 && (
                        <div className="mb-1.5 text-[12px] font-medium text-foreground/60">{t('events.listener.craftDetected')}</div>
                      )}
                      <div className="divide-y divide-border/60 rounded-[7px] border border-border/70">
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
                        <pre className="mt-2.5 max-h-40 overflow-auto rounded-[7px] bg-muted/50 p-3 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all">
                          {installLog}
                        </pre>
                      )}
                    </div>
                  )}
                  {reportedDeps.length > 0 && (
                    <ReportedDepsBody
                      workspaceId={workspaceId}
                      listenerId={listener.id}
                      initial={listener.controlDeps!}
                    />
                  )}
                </div>
              )}
            </Section>
          )}

          {hasContent && (
            <Section title={t('events.listener.sectionContent')}>
              <div className="space-y-3">
                {listener.setup.length > 0 && (
                  <ol className="list-decimal space-y-1.5 pl-5">
                    {listener.setup.map((step) => (
                      <li key={step.text} className="text-[13px] leading-[1.65] text-foreground/75">
                        {step.text}
                        {step.link && (
                          <a href={step.link} className="ml-1 break-all text-primary hover:underline">
                            {step.link}
                          </a>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {uiDoc?.html && (
                  <PluginPageFrame
                    html={uiDoc.html}
                    isDark={isDark}
                    locale={i18n.language}
                    config={draft}
                    onAction={(action, args) => window.electronAPI.listenerPluginAction(workspaceId, listener.id, action, args)}
                  />
                )}
                {listener.ui && !uiDoc?.html && (
                  <p className="text-[12.5px] text-destructive">
                    {t('events.listener.pageUnavailable')}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-[7px] bg-muted/50 px-3 py-2 font-mono text-[12.5px] text-foreground/80">
                    {listener.id}
                  </code>
                  <CopyButton value={listener.id} label={t('events.common.copyId')} />
                </div>
                <p className="text-[12.5px] leading-[1.7] text-muted-foreground">
                  {t('events.listener.enableHint')}
                </p>
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
