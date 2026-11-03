/**
 * Events navigator column, "listeners" section.
 *
 * Cards list every listener package found under `<workspace>/events/`, its
 * state, and how many events it produced. Picking one opens the detail page
 * (manifest, config, dependencies, setup). The ingest endpoint used to live
 * here; it moved to the detail page of any listener so the header stays about
 * listeners.
 */

import * as React from 'react'
import { AlertTriangle, CircleDot, Plus, Radio, RefreshCw } from 'lucide-react'
import type { ListenerDto } from '@craft-agent/shared/protocol/dto'

export interface EventsListenersPanelProps {
  workspaceId: string
  selectedListenerId: string | null
  onSelectListener: (listenerId: string) => void
  className?: string
}

function StateDot({ listener }: { listener: ListenerDto }): React.ReactElement {
  const state = listener.status.state
  if (listener.errors.length > 0) {
    return <AlertTriangle className="h-3 w-3 text-destructive shrink-0" aria-label="配置错误" />
  }
  if (!listener.enabled) {
    return <CircleDot className="h-3 w-3 text-muted-foreground/40 shrink-0" aria-label="已停用" />
  }
  if (state === 'running') return <CircleDot className="h-3 w-3 text-primary shrink-0" aria-label="运行中" />
  if (state === 'starting') return <CircleDot className="h-3 w-3 text-amber-500 shrink-0" aria-label="启动中" />
  if (state === 'degraded') return <CircleDot className="h-3 w-3 text-amber-500 shrink-0" aria-label="无响应" />
  if (state === 'failed') return <CircleDot className="h-3 w-3 text-destructive shrink-0" aria-label="异常" />
  return <CircleDot className="h-3 w-3 text-muted-foreground/40 shrink-0" aria-label="已停止" />
}

export function EventsListenersPanel({
  workspaceId,
  selectedListenerId,
  onSelectListener,
  className,
}: EventsListenersPanelProps): React.ReactElement {
  const [listeners, setListeners] = React.useState<ListenerDto[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      // skipProbes=true: cards must render instantly; the detail page pays for
      // the python/pip subprocess checks.
      const rows = await window.electronAPI.listEventListeners(workspaceId, true)
      setListeners(Array.isArray(rows) ? rows : [])
    } catch (err) {
      console.error('[EventsListenersPanel] load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setListeners([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventListenerStatus((wsId, status) => {
      if (wsId !== workspaceId) return
      setListeners((prev) =>
        prev.map((listener) => (listener.id === status.id ? { ...listener, status, enabled: status.state !== 'stopped' || listener.enabled } : listener)),
      )
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId])

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-2 border-b border-border flex items-center gap-1.5">
        <Radio className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">监听器</span>
        <span className="text-[11px] text-muted-foreground">{listeners.length}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
          title="刷新"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {error && <div className="px-1 py-2 text-xs text-destructive">{error}</div>}

        {!error && listeners.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground text-center px-3">
            <Plus className="h-6 w-6" />
            <p className="text-xs">还没有监听器</p>
            <p className="text-[11px] opacity-70 leading-relaxed">
              在 <code className="font-mono">&lt;workspace&gt;/events/&lt;id&gt;/manifest.json</code> 放一个清单，
              这里就会出现卡片
            </p>
          </div>
        )}

        {listeners.map((listener) => {
          const selected = listener.id === selectedListenerId
          return (
            <button
              key={listener.id}
              type="button"
              onClick={() => onSelectListener(listener.id)}
              className={`w-full text-left rounded-md border p-2 transition-colors ${
                selected ? 'border-primary/40 bg-accent' : 'border-border hover:bg-accent/50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <StateDot listener={listener} />
                <span className="text-xs font-medium truncate flex-1">{listener.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">v{listener.version}</span>
              </div>
              {listener.description && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">{listener.description}</p>
              )}
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[10px] px-1 py-px rounded bg-muted text-muted-foreground">
                  {listener.enabled ? '已启用' : '已停用'}
                </span>
                {listener.eventTypes.slice(0, 2).map((type) => (
                  <span key={type} className="text-[10px] text-muted-foreground truncate">
                    {type}
                  </span>
                ))}
              </div>
              {listener.errors.length > 0 && (
                <p className="text-[10px] text-destructive mt-1 line-clamp-1">{listener.errors[0]}</p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
