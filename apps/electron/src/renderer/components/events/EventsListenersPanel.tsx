/**
 * Events navigator column, "listeners" section — the plugin list.
 *
 * Cards list every plugin found under `<workspace>/events/`, its light, and
 * its state. Picking one opens the detail page (intro, config, dependencies).
 *
 * No section header of its own: the navigator's PanelHeader already prints the
 * title (插件) with the refresh action on the SAME row, and a second title row
 * only ate vertical space (it was the "two-line header" the plugin list kept
 * showing). The refresh button no longer floats over the list or owns a row —
 * it lives in the header row next to the title, and the panel registers its
 * reload function there via `refreshRef`.
 *
 * Selection follows the EntityRow grammar (faint wash + left accent rule) so
 * the three event pages read like the rest of the app.
 */

import * as React from 'react'
import { Plus } from 'lucide-react'
import type { ListenerDto } from '@craft-agent/shared/protocol/dto'
import { ListenerStatusLight } from './ListenerStatusLight'

export interface EventsListenersPanelProps {
  workspaceId: string
  selectedListenerId: string | null
  onSelectListener: (listenerId: string) => void
  /**
   * The navigator's title row owns the refresh affordance: the panel
   * registers its reload there, so the header's icon button and the card
   * list share one source of truth instead of a second header row.
   */
  refreshRef?: React.MutableRefObject<(() => void) | null>
  className?: string
}

export function EventsListenersPanel({
  workspaceId,
  selectedListenerId,
  onSelectListener,
  refreshRef,
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

  // The header row's refresh button calls this — one reload function, two
  // owners (the panel and the PanelHeader icon), so the button is never its
  // own line again.
  React.useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => {
      void load()
    }
    return () => {
      refreshRef.current = null
    }
  }, [load, refreshRef])

  // The process side of the lights: start / running / degraded / failed /
  // stop events flip the card's dot without a reload.
  React.useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onEventListenerStatus((wsId, status) => {
      if (wsId !== workspaceId) return
      setListeners((prev) =>
        prev.map((listener) => (listener.id === status.id ? { ...listener, status } : listener)),
      )
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId])

  // The on-disk side: the detail page toggling the enable switch, saving
  // config, or installing a dependency changes facts a status event cannot
  // carry. The server pushes listener-changed; re-reading the list (cheap,
  // probe-free) keeps every card's light and chip on what is true now.
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

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className={`flex-1 overflow-y-auto p-2 space-y-1.5 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
        {error && <div className="px-1 py-2 text-xs text-destructive">{error}</div>}

        {!error && listeners.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground text-center px-3">
            <Plus className="h-7 w-7 opacity-70" />
            <p className="text-sm">还没有插件</p>
            <p className="text-xs opacity-70 leading-relaxed">
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
              className={`relative w-full text-left rounded-[8px] border p-2.5 transition-colors ${
                // EntityRow grammar: wash + left rule; accent stays an accent.
                selected
                  ? 'border-transparent bg-foreground/3 shadow-[inset_2px_0_0_0_hsl(var(--accent))]'
                  : 'border-border/60 hover:bg-foreground/2 hover:border-border'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate flex-1 min-w-0">{listener.name}</span>
                <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                  v{listener.version}
                </span>
                {/* One shared mapping with the detail page title bar. */}
                <ListenerStatusLight listener={listener} />
              </div>
              {listener.description && (
                <p className="text-[12px] leading-4 text-foreground/55 line-clamp-2 mt-1">
                  {listener.description}
                </p>
              )}
              <div className="flex items-center gap-1.5 mt-1.5">
                <span
                  className={`text-[11px] leading-4 px-1.5 rounded ${
                    listener.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {listener.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              {listener.errors.length > 0 && (
                <p className="text-[11px] leading-4 text-destructive mt-1.5 line-clamp-1">
                  {listener.errors[0]}
                </p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
