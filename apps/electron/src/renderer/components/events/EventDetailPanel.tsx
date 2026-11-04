/**
 * Single-event detail. Fetches on demand: this is the only place a body is
 * loaded, which is what keeps the list cheap.
 *
 * Layout grammar (ui-ux-pro-max rules applied):
 *   - visual-hierarchy / content-priority: the title is the anchor; metadata
 *     is a compact, muted strip; the body is the main content and gets the
 *     remaining height.
 *   - whitespace-balance: related metadata is grouped into one bordered
 *     header block, the body sits in its own scrolling region.
 *   - line-length-control: the body column caps around 65–75ch so long
 *     payloads stay readable on wide panes.
 *   - truncation-strategy: long values (dedupe key, payload path) wrap
 *     instead of truncating — the detail page has room.
 */

import * as React from 'react'
import { ExternalLink, Paperclip, Inbox, Send } from 'lucide-react'
import type { EventRecordDto } from '@craft-agent/shared/protocol/dto'
import { EventAttachments } from './EventAttachments'
import { EventBody } from './EventBody'

export interface EventDetailPanelProps {
  workspaceId: string
  eventId: string
  className?: string
}

/** Delivery dot + label, reused in header. */
function DeliveryState({ delivered }: { delivered: boolean }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${delivered ? 'bg-accent' : 'bg-foreground/20'}`} />
      {delivered ? '已投递给订阅会话' : '尚未投递'}
    </span>
  )
}

/** Small muted metadata chip in the header strip. */
function Chip({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 min-w-0 text-[12px] leading-5 text-muted-foreground">
      <span className="opacity-70 shrink-0">{label}</span>
      <span className="text-foreground/75 truncate" title={value}>
        {value}
      </span>
    </span>
  )
}

/** Metadata row — same label column as before (4-char labels need ~56px). */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-3 text-[13.5px] leading-6">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  )
}

/** Section separator: a small caps label with a hairline, not a heavy box. */
function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[12px] font-medium tracking-wide text-muted-foreground">{children}</span>
      <span className="flex-1 h-px bg-border" />
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
  // Older main processes (pre-deliveries) omit the field entirely — HMR can
  // pair a new renderer with an old backend, and that must not crash.
  const deliveries = event.deliveries ?? []

  // Only rows with content render — the block collapses around what exists.
  const extraRows: Array<{ label: string; node: React.ReactNode } | null> = [
    event.occurredAt !== undefined
      ? { label: '发生时间', node: new Date(event.occurredAt).toLocaleString() }
      : null,
    deliveries.length > 0
      ? {
          label: '投递记录',
          node: (
            <span className="flex flex-col gap-0.5">
              {deliveries.map((delivery) => (
                <span key={delivery.sessionId} className="inline-flex items-center gap-1.5">
                  <Send className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-[12px] break-all">{delivery.sessionId}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {new Date(delivery.at).toLocaleString()}
                  </span>
                </span>
              ))}
            </span>
          ),
        }
      : null,
    event.recipients.length > 0
      ? {
          label: '接收方',
          node: (
            <span className="flex flex-wrap gap-1">
              {event.recipients.map((recipient) => (
                <span key={recipient} className="px-1.5 rounded bg-muted text-[12px] leading-5">
                  {recipient}
                </span>
              ))}
            </span>
          ),
        }
      : null,
    event.dedupeKey ? { label: '去重键', node: <span className="font-mono text-[12px]">{event.dedupeKey}</span> } : null,
    event.links.length > 0
      ? {
          label: '链接',
          node: (
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
          ),
        }
      : null,
    event.payloadRef
      ? {
          label: '附件载荷',
          node: (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Paperclip className="h-3 w-3" />
              {event.payloadRef.kind} · {event.payloadRef.path}
              {event.payloadRef.size !== undefined ? ` · ${event.payloadRef.size} B` : ''}
            </span>
          ),
        }
      : null,
  ]
  const details = extraRows.filter((row): row is { label: string; node: React.ReactNode } => row !== null)

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`}>
      {/* Header: title → summary → muted metadata strip → expandable details */}
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-[16px] font-medium leading-7 break-words">{event.title}</h2>
        {event.summary && (
          <p className="text-[13.5px] leading-6 text-muted-foreground mt-1.5">{event.summary}</p>
        )}

        {/* Metadata strip: delivery · source · type · time in one quiet line.
            Same label:value grammar throughout (labels in muted, values in
            foreground/75) so the line reads as one table row. */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 mt-3 text-[12px]">
          <DeliveryState delivered={event.delivered} />
          {deliveries.length > 0 && (
            <span className="text-muted-foreground">{deliveries.length} 个会话</span>
          )}
          <span className="h-3 w-px bg-border" aria-hidden />
          <Chip label="来源" value={event.source} />
          <span className="h-3 w-px bg-border" aria-hidden />
          <Chip label="类型" value={event.type} />
          <span className="h-3 w-px bg-border" aria-hidden />
          <Chip
            label="时间"
            value={new Date(event.receivedAt).toLocaleString()}
          />
        </div>

        {/* Secondary metadata stays available without shouting: behind a
            disclosure unless links/attachments demand visibility. */}
        {details.length > 0 && (
          <details className="mt-2 group" open={Boolean(event.links.length || event.payloadRef || deliveries.length)}>
            <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors select-none">
              详细信息（{details.length}）
            </summary>
            <div className="mt-1.5 space-y-1 pl-3 border-l border-border">
              {details.map((row) => (
                <Row key={row.label} label={row.label}>
                  {row.node}
                </Row>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Body: the actual content, line-length capped for readability */}
      <div className="flex-1 overflow-auto px-5 py-4">
        <SectionLabel>正文</SectionLabel>
        {event.body === undefined ? (
          <p className="text-[13px] text-muted-foreground inline-flex items-center gap-2">
            <Inbox className="h-4 w-4 opacity-60" />
            该事件没有正文
          </p>
        ) : (
          <EventBody
            workspaceId={workspaceId}
            eventId={eventId}
            body={event.body}
            attachments={event.attachments ?? []}
          />
        )}

        <EventAttachments
          workspaceId={workspaceId}
          eventId={eventId}
          attachments={event.attachments ?? []}
        />
      </div>
    </div>
  )
}
