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

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] uppercase tracking-wide text-muted-foreground/70 mb-1">{label}</div>
      <div className="text-[13.5px] text-foreground break-words min-h-[1.4em]">{children}</div>
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
      <div className={`px-4 py-3 text-[13px] text-muted-foreground/60 ${className ?? ''}`}>
        {t('events.outbox.loading', { defaultValue: '加载中…' })}
      </div>
    )
  }

  if (!record) {
    return (
      <div className={`px-4 py-3 text-[13px] text-muted-foreground ${className ?? ''}`}>
        {t('events.outbox.detail.notFound', { defaultValue: '该记录不存在或已被删除' })}
      </div>
    )
  }

  const payload = previewOf(record)

  return (
    <div className={className ? `px-5 py-4 overflow-y-auto ${className}` : 'px-5 py-4 overflow-y-auto'}>
      <div className="flex items-center gap-2.5 mb-5">
        <span className="text-[15px] font-medium text-foreground truncate flex-1">
          {record.listenerId} · {record.action}
        </span>
        <OutboxStatusBadge status={record.status} />
        {record.status === 'failed' && (
          <button
            type="button"
            onClick={() => void retry()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground hover:underline disabled:opacity-50"
          >
            <RotateCw className="h-3 w-3" />
            {t('events.outbox.retry', { defaultValue: '重试' })}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Field label={t('events.outbox.detail.target', { defaultValue: '目标' })}>
          {record.listenerId}
          {typeof record.args?.channelId === 'string' && record.args.channelId
            ? ` · ${record.args.channelId}`
            : ''}
        </Field>
        <Field label={t('events.outbox.detail.action', { defaultValue: '动作' })}>{record.action}</Field>
        <Field label={t('events.outbox.detail.payload', { defaultValue: '内容' })}>
          <span className="whitespace-pre-wrap break-all">{payload}</span>
        </Field>
        <Field label={t('events.outbox.detail.status', { defaultValue: '状态' })}>
          {record.status}
          {record.attempts > 0 ? ` · ${t('events.outbox.attempts', { defaultValue: '重试' })} ${record.attempts}` : ''}
        </Field>
        {record.status === 'pending' && record.nextAttemptAt ? (
          <Field label={t('events.outbox.nextRetry', { defaultValue: '下次重试' })}>
            {formatTime(record.nextAttemptAt)}
          </Field>
        ) : null}
        {record.lastError && record.status !== 'sent' ? (
          <Field label={t('events.outbox.detail.lastError', { defaultValue: '最近错误' })}>
            <span className="text-red-500/90">{record.lastError}</span>
          </Field>
        ) : null}
        <Field label={t('events.outbox.detail.createdAt', { defaultValue: '创建时间' })}>
          {formatTime(record.createdAt)}
        </Field>
        <Field label={t('events.outbox.detail.updatedAt', { defaultValue: '更新时间' })}>
          {formatTime(record.updatedAt)}
        </Field>
      </div>
    </div>
  )
}
