/**
 * Outbox record detail (发件箱 左3): one outbound message and its delivery
 * state. Refreshes on the same five-second cadence as the dispatcher tick,
 * because a pending record's status can flip while this view is open.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import type { OutboxRecordDto } from '@craft-agent/shared/protocol/dto'
import { OutboxStatusBadge, previewOf } from './OutboxListPanel'
import { formatTime } from './EventsListPanel'

export interface OutboxDetailPanelProps {
  workspaceId: string
  outboxId: string
  className?: string
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

/** Metadata row — same label column as the inbox detail (4-char labels need ~56px). */
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

export function OutboxDetailPanel({
  workspaceId,
  outboxId,
  className,
}: OutboxDetailPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [record, setRecord] = React.useState<OutboxRecordDto | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!workspaceId || !outboxId) return
    try {
      const rows = await window.electronAPI.listOutbox(workspaceId)
      setRecord(Array.isArray(rows) ? rows.find((row) => row.id === outboxId) ?? null : null)
    } catch (error) {
      console.error('[OutboxDetailPanel] load failed:', error)
      setRecord(null)
    } finally {
      setLoaded(true)
    }
  }, [workspaceId, outboxId])

  React.useEffect(() => {
    setRecord(null)
    setLoaded(false)
    void load()
  }, [load])

  // The dispatcher mutates records in the background; keep this view honest.
  React.useEffect(() => {
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(timer)
  }, [load])

  const retry = async () => {
    if (!record) return
    setBusy(true)
    try {
      await window.electronAPI.retryOutbox(workspaceId, record.id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <div className={`px-5 py-4 text-sm text-muted-foreground ${className ?? ''}`}>
        {t('events.outbox.loading', { defaultValue: '加载中…' })}
      </div>
    )
  }

  if (!record) {
    return (
      <div className={`px-5 py-4 text-sm text-muted-foreground ${className ?? ''}`}>
        {t('events.outbox.detail.notFound', { defaultValue: '该记录不存在或已被删除' })}
      </div>
    )
  }

  const payload = previewOf(record)
  const targetText =
    typeof record.args?.channelId === 'string' && record.args.channelId
      ? `${record.listenerId} · ${record.args.channelId}`
      : record.listenerId
  const statusLabel =
    record.status === 'sent'
      ? t('events.outbox.sent', { defaultValue: '已发送' })
      : record.status === 'pending'
        ? t('events.outbox.pending', { defaultValue: '待发送' })
        : t('events.outbox.failed', { defaultValue: '发送失败' })

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`}>
      {/* Header: identity → muted status strip — the same grammar as the inbox detail. */}
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-[16px] font-medium leading-7 break-words">
          {record.listenerId} · {record.action}
        </h2>

        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 mt-3 text-[12px]">
          <OutboxStatusBadge status={record.status} />
          <span className="h-3 w-px bg-border" aria-hidden />
          <Chip label={t('events.outbox.detail.target')} value={targetText} />
          <span className="h-3 w-px bg-border" aria-hidden />
          <Chip label={t('events.outbox.detail.createdAt')} value={formatTime(record.createdAt)} />
        </div>
      </div>

      {/* Body: the payload first, delivery facts after — same layout as the inbox body. */}
      <div className="flex-1 overflow-auto px-5 py-4">
        <SectionLabel>{t('events.outbox.detail.payload')}</SectionLabel>
        <p className="text-[13.5px] whitespace-pre-wrap break-all mb-4">{payload}</p>

        <div className="space-y-1.5">
          <Row label={t('events.outbox.detail.status')}>
            <span className="inline-flex items-center gap-2">
              {statusLabel}
              {record.attempts > 0
                ? ` · ${t('events.outbox.attempts', { defaultValue: '重试' })} ${record.attempts}`
                : ''}
              {record.status === 'failed' && (
                <button
                  type="button"
                  onClick={() => void retry()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-[12.5px] text-foreground hover:underline disabled:opacity-50"
                >
                  <RotateCw className="h-3 w-3" />
                  {t('events.outbox.retry', { defaultValue: '重试' })}
                </button>
              )}
            </span>
          </Row>
          {record.status === 'pending' && record.nextAttemptAt ? (
            <Row label={t('events.outbox.nextRetry', { defaultValue: '下次重试' })}>
              {formatTime(record.nextAttemptAt)}
            </Row>
          ) : null}
          {record.lastError && record.status !== 'sent' ? (
            <Row label={t('events.outbox.detail.lastError')}>
              <span className="text-red-500/90 break-all">{record.lastError}</span>
            </Row>
          ) : null}
          <Row label={t('events.outbox.detail.updatedAt')}>{formatTime(record.updatedAt)}</Row>
        </div>
      </div>
    </div>
  )
}
