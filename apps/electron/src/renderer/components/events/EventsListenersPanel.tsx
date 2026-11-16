/**
 * Events navigator column, "listeners" section — the plugin list.
 *
 * Cards list every plugin found under `<workspace>/events/`: name, version,
 * description, enabled state and manifest errors. They carry no status light —
 * that reading lives on the detail page. Picking a card opens that page.
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
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Blocks,
  Bot,
  Mail,
  MessageCircle,
  MessagesSquare,
  Plus,
  Send,
  Terminal,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import type { ListenerDto } from '@craft-agent/shared/protocol/dto'

/**
 * Manifest icon name → component.
 *
 * A plugin names its icon as a string so the manifest stays data — no imports,
 * no code. Unknown or absent names fall back to the neutral block icon: a
 * missing icon must never look like a broken plugin.
 */
const ICONS: Record<string, LucideIcon> = {
  'message-circle': MessageCircle,
  'messages-square': MessagesSquare,
  send: Send,
  bot: Bot,
  mail: Mail,
  terminal: Terminal,
  webhook: Webhook,
}

export function PluginIcon({ name, className }: { name?: string; className?: string }): React.ReactElement {
  const Icon = (name && ICONS[name]) || Blocks
  return <Icon className={className} />
}

export interface EventsListenersPanelProps {
  workspaceId: string
  selectedListenerId: string | null
  onSelectListener: (listenerId: string) => void
  className?: string
}

export function EventsListenersPanel({
  workspaceId,
  selectedListenerId,
  onSelectListener,
  className,
}: EventsListenersPanelProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [listeners, setListeners] = React.useState<ListenerDto[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Kept in a ref so the status subscription can name the plugin without
  // re-subscribing on every list change.
  const listenersRef = React.useRef<ListenerDto[]>([])
  listenersRef.current = listeners

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      // skipProbes=true: cards must render instantly; the detail page pays for
      // the python/pip subprocess checks. `locale` lets the plugin rename its
      // own card in the reader's language.
      const rows = await window.electronAPI.listEventListeners(workspaceId, true, i18n.resolvedLanguage ?? i18n.language)
      setListeners(Array.isArray(rows) ? rows : [])
    } catch (err) {
      console.error('[EventsListenersPanel] load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      setListeners([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId, i18n.resolvedLanguage, i18n.language])

  React.useEffect(() => {
    void load()
  }, [load])

  // The process side: start / running / degraded / failed / stop events keep
  // the cached status current without a reload — the failure toast below reads
  // it.
  React.useEffect(() => {
    if (!workspaceId) return
    // Remember which plugins we have already warned about, so a restart loop
    // does not produce a toast per attempt.
    const warned = new Set<string>()
    const off = window.electronAPI.onEventListenerStatus((wsId, status) => {
      if (wsId !== workspaceId) return
      setListeners((prev) =>
        prev.map((listener) => (listener.id === status.id ? { ...listener, status } : listener)),
      )

      // A plugin that fails to start is still enabled — Craft does not silently
      // switch it off. Say so: nothing else on this list reports it, and the
      // failure reason is only visible on the detail page otherwise.
      if (status.state === 'failed' && !warned.has(status.id)) {
        warned.add(status.id)
        const name = listenersRef.current.find((l) => l.id === status.id)?.name ?? status.id
        toast.error(t('events.listeners.startFailed', { name }), {
          description: status.lastError ?? t('events.listeners.startFailedHint'),
        })
      }
      if (status.state === 'running') warned.delete(status.id)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId])

  // The on-disk side: the detail page toggling the enable switch, saving
  // config, or installing a dependency changes facts a status event cannot
  // carry. The server pushes listener-changed; re-reading the list (cheap,
  // probe-free) keeps every card's chip and errors on what is true now.
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
            <p className="text-sm">{t('events.listeners.empty')}</p>
            <p className="text-xs opacity-70 leading-relaxed">
              {t('events.listeners.emptyHintPath')}{' '}
              <code className="font-mono">&lt;workspace&gt;/events/&lt;id&gt;/manifest.json</code>{' '}
              {t('events.listeners.emptyHintTail')}
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
                {/* The manifest's icon name, resolved to a component. Kept from
                    the single-icon pass: a plugin that declares no icon falls
                    back to the neutral block rather than rendering nothing. */}
                <PluginIcon name={listener.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium truncate flex-1 min-w-0">{listener.name}</span>
                <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                  v{listener.version}
                </span>
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
                  {listener.enabled ? t('events.listeners.enabled') : t('events.listeners.disabled')}
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
