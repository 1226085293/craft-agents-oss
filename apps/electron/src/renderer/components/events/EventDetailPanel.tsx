/**
 * Single-event detail. Fetches on demand: this is the only place a body is
 * loaded, which is what keeps the list cheap.
 */

import * as React from 'react'
import { ExternalLink, Paperclip } from 'lucide-react'
import type { EventRecordDto } from '@craft-agent/shared/protocol/dto'

export interface EventDetailPanelProps {
  workspaceId: string
  eventId: string
  className?: string
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

export function EventDetailPanel({
  workspaceId,
  eventId,
  className,
}: EventDetailPanelProps): React.ReactElement {
  const [event, setEvent] = React.useState<EventRecordDto | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.electronAPI
      .getEvent(workspaceId, eventId)
      .then((result) => {
        if (cancelled) return
        setEvent(result)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, eventId])

  if (error) {
    return <div className={`p-4 text-sm text-destructive ${className ?? ''}`}>{error}</div>
  }
  if (loading && !event) {
    return <div className={`p-4 text-sm text-muted-foreground ${className ?? ''}`}>加载中…</div>
  }
  if (!event) {
    return <div className={`p-4 text-sm text-muted-foreground ${className ?? ''}`}>事件不存在</div>
  }

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`}>
      <div className="px-4 py-3 border-b border-border space-y-1.5">
        <div className="flex items-start gap-2">
          <h2 className="text-base font-medium min-w-0 flex-1 break-words">{event.title}</h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            {event.type}
          </span>
        </div>
        {event.summary && <p className="text-sm text-muted-foreground">{event.summary}</p>}

        <div className="pt-1 space-y-1">
          <Row label="来源">{event.source}</Row>
          <Row label="接收时间">{new Date(event.receivedAt).toLocaleString()}</Row>
          {event.occurredAt !== undefined && (
            <Row label="发生时间">{new Date(event.occurredAt).toLocaleString()}</Row>
          )}
          <Row label="接收状态">
            {event.delivered ? '已投递给订阅会话' : '尚未投递'}
          </Row>
          {event.recipients.length > 0 && (
            <Row label="接收方">
              <span className="flex flex-wrap gap-1">
                {event.recipients.map((recipient) => (
                  <span key={recipient} className="px-1 py-px rounded bg-muted text-[11px]">
                    {recipient}
                  </span>
                ))}
              </span>
            </Row>
          )}
          {event.tags.length > 0 && (
            <Row label="标签">
              <span className="flex flex-wrap gap-1">
                {event.tags.map((tag) => (
                  <span key={tag} className="px-1 py-px rounded bg-muted text-[11px]">
                    {tag}
                  </span>
                ))}
              </span>
            </Row>
          )}
          {event.dedupeKey && <Row label="去重键">{event.dedupeKey}</Row>}
          {event.links.length > 0 && (
            <Row label="链接">
              <span className="flex flex-col gap-0.5">
                {event.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    className="text-primary hover:underline inline-flex items-center gap-1 break-all"
                  >
                    {link.rel ? `${link.rel} · ` : ''}
                    {link.url}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ))}
              </span>
            </Row>
          )}
          {event.payloadRef && (
            <Row label="附件载荷">
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                {event.payloadRef.kind} · {event.payloadRef.path}
                {event.payloadRef.size !== undefined ? ` · ${event.payloadRef.size} B` : ''}
              </span>
            </Row>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {event.body === undefined ? (
          <p className="text-xs text-muted-foreground">该事件没有正文。</p>
        ) : (
          <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-muted/40 rounded-md p-3">
            {event.body}
          </pre>
        )}
      </div>
    </div>
  )
}
