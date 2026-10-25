/**
 * LLM 管理 — the gateway's control surface, ported 1:1 from the frozen
 * prototype at `pages/llm/index.html` (v28).
 *
 * The prototype is the visual + interaction spec: same topnav, same cards,
 * same dialogs. What changed in the port is only the data source — every read
 * comes from `window.electronAPI.llmGateway*` and every write goes through
 * SAVE_CONFIG followed by a re-read, so what is on screen is always the shape
 * the gateway accepted, never an optimistic local copy.
 *
 * Layout note: the prototype's stylesheet is imported as `proto.css` and is
 * selector-scoped to `.llm-proto` (see the file header) so its `.card` /
 * `.badge` / `.main` rules cannot leak into the rest of the app.
 */

import * as React from 'react'

import type { LlmConfigShape, ProviderDetailShape, TimeBucket } from './llm/types'
import { reconcileStrategyRefs } from './llm/helpers'
import { useGatewayStatus, useKeyStates, useLlmConfig, useUsageOverview } from './llm/hooks'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

import './llm/proto.css'

import { buildKpis, buildLogs, buildOrphanLogs, buildProviders, buildRtk, buildStrategies } from './llm/proto/viewmodel'
import type { ProtoLogRow, ProtoRtk } from './llm/proto/viewmodel'
import { ProtoShellContext, type DialogState, type ProtoView } from './llm/proto/state'
import type { ProvTab } from './llm/proto/state'
import { OverviewView } from './llm/proto/OverviewView'
import type { RangeKey } from './llm/proto/OverviewView'
import { ProvidersView } from './llm/proto/ProvidersView'
import { DetailView } from './llm/proto/DetailView'
import { StrategiesView } from './llm/proto/StrategiesView'
import { LogsView, DEFAULT_FILTER } from './llm/proto/LogsView'
import type { LogsFilter } from './llm/proto/LogsView'
import { SettingsView } from './llm/proto/SettingsView'
import { ProtoDialog } from './llm/proto/dialogs'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'llm',
}

const NAV: Array<[ProtoView, string]> = [
  ['overview', '总览'],
  ['providers', '提供商'],
  ['strategies', '策略组'],
  ['logs', '日志'],
  ['settings', '设置'],
]

const KPI_STORAGE = 'llm-proto.kpi-config'
const KPI_DEFAULT = ['tok', 'req', 'rate', 'cache', 'fb']

function readKpiConfig(): string[] {
  try {
    const raw = localStorage.getItem(KPI_STORAGE)
    if (raw) {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr) && arr.length === 5 && arr.every((x) => typeof x === 'string')) return arr as string[]
    }
  } catch {
    // Ignore a corrupt preference and fall back to the default five.
  }
  return KPI_DEFAULT
}

export default function LlmGatewayPage(): React.JSX.Element {
  const { config, reload } = useLlmConfig()
  const status = useGatewayStatus()
  const keyStates = useKeyStates()
  const [range, setRange] = React.useState<TimeBucket>('day')
  const { overview, reload: reloadUsage } = useUsageOverview(range)

  // Re-read the config whenever the gateway rebuilds it (file watcher, save
  // from another window). Without this an external edit only shows after the
  // user finds the refresh button.
  const seenGeneration = React.useRef<number | null>(null)
  React.useEffect(() => {
    const generation = status?.generation
    if (generation == null) return
    if (seenGeneration.current == null) {
      seenGeneration.current = generation
      return
    }
    if (seenGeneration.current !== generation) {
      seenGeneration.current = generation
      reload()
    }
  }, [status?.generation, reload])

  const [view, setView] = React.useState<ProtoView>('overview')
  const [detail, setDetail] = React.useState<string | null>(null)
  // Where "back" goes: the overview when the detail was opened from a card
  // there, the providers list when it was opened from the list itself.
  const [detailReturnView, setDetailReturnView] = React.useState<ProtoView>('providers')
  const [provTab, setProvTab] = React.useState<ProvTab>('list')
  const [dialog, setDialog] = React.useState<DialogState | null>(null)
  const [toastMsg, setToastMsg] = React.useState('')
  const [kpiConfig, setKpiConfig] = React.useState<string[]>(readKpiConfig)
  const [logsFilter, setLogsFilter] = React.useState<LogsFilter>(DEFAULT_FILTER)
  // "日志" on a strategy card: go straight to the log page scoped to that group.
  // Replaces the old strategy-logs dialog, which duplicated the log table.
  const openLogsForStrategy = React.useCallback((id: string): void => {
    setDialog(null)
    setView('logs')
    setDetail(null)
    setLogsFilter({ ...DEFAULT_FILTER, strategy: id })
  }, [])

  const [details, setDetails] = React.useState<Record<string, ProviderDetailShape>>({})
  const [detailNonce, setDetailNonce] = React.useState(0)
  // The gateway channel is registered by the main process a moment after the
  // renderer boots; a single failed read used to leave the page spinning
  // forever. Retry a few times, then say so instead of pretending to load.
  const [configTries, setConfigTries] = React.useState(0)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (config) return
    if (configTries >= 10) return
    const id = window.setTimeout(() => {
      reload()
      setConfigTries((n) => n + 1)
    }, 400)
    return () => window.clearTimeout(id)
  }, [config, configTries, reload])

  const toast = React.useCallback((msg: string) => {
    setToastMsg(msg)
  }, [])
  React.useEffect(() => {
    if (!toastMsg) return
    const id = window.setTimeout(() => setToastMsg(''), 2400)
    return () => window.clearTimeout(id)
  }, [toastMsg])

  // All providers' recent requests, merged into the global log view. One call
  // per provider is what the gateway exposes — there is no "all requests" RPC.
  React.useEffect(() => {
    if (!config) return
    let cancelled = false
    void Promise.all(
      config.providers.map(async (p) => {
        const d = (await window.electronAPI.llmGatewayGetProviderDetail?.(p.id)) as ProviderDetailShape | null
        return [p.id, d] as const
      }),
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, ProviderDetailShape> = {}
      pairs.forEach(([id, d]) => {
        if (d) next[id] = d
      })
      setDetails(next)
    })
    return () => {
      cancelled = true
    }
  }, [config, detailNonce])

  const providers = React.useMemo(
    () => buildProviders(config, status, keyStates, details),
    [config, status, keyStates, details],
  )
  const strategies = React.useMemo(() => buildStrategies(config, providers), [config, providers])
  // Failures the gateway refused before choosing a provider carry no provider id,
  // so the per-provider detail calls above can never surface them. They are the
  // ones a misconfigured window or strategy produces, which is exactly what the
  // error aggregate is for.
  const [orphanRows, setOrphanRows] = React.useState<ProtoLogRow[]>([])
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.llmGatewayQueryLogs?.({ sort: 'desc', limit: 500 })
      .then((r) => {
        if (!cancelled) setOrphanRows(buildOrphanLogs(r.rows))
      })
      .catch(() => {
        // The log view has its own query; a failure here only costs the extra rows.
      })
    return () => {
      cancelled = true
    }
    // `view` is a dependency on purpose: the rows arrive from the usage log,
    // which is flushed periodically, so opening the log page is the moment to
    // re-read them. Without it the dialog showed whatever existed when the page
    // first mounted.
  }, [detailNonce, view])

  const logs = React.useMemo<ProtoLogRow[]>(() => {
    const fromProviders = buildLogs(
      Object.entries(details).map(([provider, d]) => ({ provider, detail: d })),
      (provider, keyId) => {
        const raw = config?.providers.find((p) => p.id === provider)?.keys.find((k) => k.id === keyId)?.key
        if (!raw) return keyId
        return raw.length > 12 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw
      },
    )
    return [...fromProviders, ...orphanRows].sort((a, b) => b.tsMs - a.tsMs)
  }, [details, config, orphanRows])
  const kpis = React.useMemo(
    () => buildKpis(overview, providers.length, range === 'day' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : Infinity),
    [overview, providers.length, range],
  )

  // RTK's savings live in rtk's own ledger, not in the gateway's usage log, so
  // the overview reads them through the settings channel. Re-read on entering
  // the overview: the toggle sits on the 设置 page, and the ledger is
  // append-only, so a stale read under-reports rather than inventing savings.
  const [rtk, setRtk] = React.useState<ProtoRtk | null>(null)
  const reloadRtk = React.useCallback((): void => {
    // Each channel is settled on its own: a build that lacks `getRtkGain` still
    // knows whether rtk is on, and one failed probe must not blank the card.
    const settle = <T,>(p: Promise<T> | undefined): Promise<T | undefined> =>
      p ? p.catch(() => undefined) : Promise.resolve(undefined)
    void Promise.all([
      settle(window.electronAPI.getRtkEnabled?.()),
      settle(window.electronAPI.getRtkStatus?.({})),
      settle(window.electronAPI.getRtkGain?.()),
    ]).then(([enabled, status, gain]) => setRtk(buildRtk(enabled, status, gain)))
  }, [])
  React.useEffect(() => {
    if (view === 'overview') reloadRtk()
  }, [view, reloadRtk])

  const save = React.useCallback(
    async (next: unknown): Promise<boolean> => {
      setSaving(true)
      try {
        // Every write repairs stale strategy references first: a config can
        // legitimately point at a strategy that does not exist yet (fresh
        // install), and saving that reference back made the validator reject
        // the write — which is how creating the first strategy failed.
        const res = await window.electronAPI.llmGatewaySaveConfig?.(
          reconcileStrategyRefs(next as LlmConfigShape),
        )
        if (!res) {
          toast('保存失败：当前构建缺少网关通道')
          return false
        }
        if (res.ok === false) {
          toast(`保存失败：${res.errors.join('；')}`)
          return false
        }
        reload()
        return true
      } finally {
        setSaving(false)
      }
    },
    [reload, toast],
  )

  const go = React.useCallback((v: ProtoView) => {
    setView(v)
    setDetail(null)
    setDialog(null)
  }, [])

  const closeDetail = React.useCallback(() => {
    setDetail(null)
    setView(detailReturnView)
  }, [detailReturnView])

  const shellApi = React.useMemo(
    () => ({
      view,
      detail,
      go,
      gotoDetail: (id: string) => {
        setDetailReturnView(view)
        setView('providers')
        setDetail(id)
      },
      goBack: closeDetail,
      dialog,
      openDialog: (d: DialogState) => setDialog(d),
      closeDialog: () => setDialog(null),
      toast,
    }),
    [view, detail, go, dialog, toast, closeDetail],
  )

  // Esc closes the overlay first, then steps back out of a detail view.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (dialog) setDialog(null)
      else if (detail) closeDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, detail, closeDetail])

  const setKpi = (i: number, id: string): void => {
    const next = [...kpiConfig]
    const j = next.indexOf(id)
    if (j >= 0 && j !== i) next[j] = next[i]
    next[i] = id
    setKpiConfig(next)
    try {
      localStorage.setItem(KPI_STORAGE, JSON.stringify(next))
    } catch {
      // Preference persistence is best-effort.
    }
  }

  if (!config) {
    return (
      <div className="llm-proto" style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <p className="small muted">
            {configTries >= 10 ? '没有读到网关配置（网关可能尚未启动）' : '读取网关配置中…'}
          </p>
          {configTries >= 10 ? (
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 10, padding: '4px 12px' }}
              onClick={() => {
                setConfigTries(0)
                reload()
              }}
            >
              重试
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const detailProvider = detail ? providers.find((p) => p.id === detail) : null
  const refreshAll = (): void => {
    reload()
    reloadUsage()
    reloadRtk()
    setDetailNonce((n) => n + 1)
  }

  return (
    <ProtoShellContext.Provider value={shellApi}>
      <div className="llm-proto" style={{ height: '100%', overflowY: 'auto' }}>
        <header className="topnav">
          <div className="topnav-inner">
            <nav>
              {NAV.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`nav ${view === id ? 'on' : ''}`}
                  onClick={() => go(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <button
              type="button"
              className="btn ghost sm"
              style={{ marginLeft: 'auto', padding: '4px 8px', fontSize: 12 }}
              title={saving ? '保存中…' : '重新读取配置与用量'}
              onClick={refreshAll}
              disabled={saving}
            >
              <span className={saving ? 'spin' : ''}>⟳</span>
            </button>
          </div>
        </header>

        <main className="main">
          {view === 'overview' ? (
            <OverviewView
              config={config}
              overview={overview}
              kpis={kpis}
              providers={providers}
              strategies={strategies}
              logs={logs}
              rtk={rtk}
              range={range as RangeKey}
              onRange={(r) => setRange(r)}
              kpiConfig={kpiConfig}
              onKpiConfig={setKpi}
              onOpenSession={(sid) => setDialog({ kind: 'session', sessionId: sid })}
              onSeeAllErrors={() => setDialog({ kind: 'error-agg' })}
            />
          ) : null}

          {view === 'providers' && !detailProvider ? (
            <ProvidersView config={config} providers={providers} tab={provTab} onTab={setProvTab} onSave={save} />
          ) : null}

          {view === 'providers' && detailProvider ? (
            <DetailView config={config} provider={detailProvider} onSave={save} />
          ) : null}

          {view === 'strategies' ? (
            <StrategiesView
              config={config}
              strategies={strategies}
              providers={providers}
              logs={logs}
              onSave={save}
              onOpenStrategyLogs={openLogsForStrategy}
            />
          ) : null}

          {view === 'logs' ? (
            <LogsView
              logs={logs}
              providers={providers}
              strategies={strategies}
              filter={logsFilter}
              onFilter={setLogsFilter}
              onRefresh={() => setDetailNonce((n) => n + 1)}
              onOpenSession={(sid) => setDialog({ kind: 'session', sessionId: sid })}
              onOpenErrorAgg={() => setDialog({ kind: 'error-agg' })}
            />
          ) : null}

          {view === 'settings' ? (
            <SettingsView
              config={config}
              strategies={strategies}
              kpiConfig={kpiConfig}
              onKpiConfig={setKpi}
              onSave={save}
            />
          ) : null}
        </main>

        {dialog ? (
          <ProtoDialog
            config={config}
            providers={providers}
            strategies={strategies}
            logs={logs}
            dialog={dialog}
            onOpenDialog={setDialog}
            onClose={() => setDialog(null)}
            onSave={save}
            onFilterLogs={(q, level, tags) => {
              setView('logs')
              setDetail(null)
              // Replace the filter wholesale: "只看此类" describes one exact
              // population (q + level + tags), so leftover chips or a strategy
              // from an earlier visit would silently narrow it to nothing.
              setLogsFilter({
                ...DEFAULT_FILTER,
                q,
                level: (level as LogsFilter['level']) ?? 'all',
                tags: (tags ?? []) as LogsFilter['tags'],
              })
            }}
            toast={toast}
          />
        ) : null}

        <div id="toast" className={toastMsg ? 'show' : ''}>
          {toastMsg}
        </div>
      </div>
    </ProtoShellContext.Provider>
  )
}
