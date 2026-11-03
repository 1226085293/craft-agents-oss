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

/**
 * Metadata row.
 *
 * The label column is `w-20` (80px): metadata text is `text-[13px]`, so a
 * 4-character Chinese label needs ~56px and 80px leaves a comfortable gap.
 * Labels sit on the same left edge as the content above; values share one
 * column so the block reads as a table, not an indented fragment.
 */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-3 text-[13px] leading-6">
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
      <div className="px-4 py-3 border-b border-border space-y-2">
        <div className="flex items-start gap-2">
          <h2 className="text-[15px] font-medium leading-6 min-w-0 flex-1 break-words">{event.title}</h2>
          <span className="text-[11px] leading-5 px-1.5 rounded bg-muted text-muted-foreground shrink-0">
            {event.type}
          </span>
        </div>
        {event.summary && <p className="text-[13px] leading-5 text-muted-foreground">{event.summary}</p>}

        <div className="pt-1 space-y-1">
          <Row label="来源">{event.source}</Row>
          <Row label="接收时间">{new Date(event.receivedAt).toLocaleString()}</Row>
          {event.occurredAt !== undefined && (
            <Row label="发生时间">{new Date(event.occurredAt).toLocaleString()}</Row>
          )}
          <Row label="接收状态">
            {event.delivered ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                已投递给订阅会话
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-foreground/20" />
                尚未投递
              </span>
            )}
          </Row>
          {event.recipients.length > 0 && (
            <Row label="接收方">
              <span className="flex flex-wrap gap-1">
                {event.recipients.map((recipient) => (
                  <span key={recipient} className="px-1.5 rounded bg-muted text-[12px] leading-5">
                    {recipient}
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
                    {link.rel ? `${link.rel} · ` : ''}{link.url}
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

      <div className="flex-1 overflow-auto px-4 py-3">
        {event.body === undefined ? (
          <p className="text-sm text-muted-foreground">该事件没有正文。</p>
        ) : (
          <pre className="text-[13px] leading-6 whitespace-pre-wrap break-words font-mono bg-muted/30 rounded-md p-3">
            {event.body}
          </pre>
        )}
      </div>
    </div>
  )
}
