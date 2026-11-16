/**
 * Outbox: the navigator column for outbound messages.
 *
 * Every message the agent asked a plugin to send lands here with its
 * delivery state: sent (it went out), pending (a retry is scheduled, the
 * server-side dispatcher keeps trying with backoff), failed (the dispatcher
 * gave up — 重试 re-arms it). The panel refreshes on its own because the
 * dispatcher mutates records in the background.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Clock, X, RotateCw, Trash2, Inbox } from 'lucide-react'
import type { OutboxRecordDto } from '@craft-agent/shared/protocol/dto'

export interface OutboxPanelProps {
  workspaceId: string
  className?: string
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The one-line preview: message text when there is some, else the file name. */
function previewOf(record: OutboxRecordDto): string {
  const text = record.args?.text
  if (typeof text === 'string' && text.trim()) return text.trim()
  const filename = record.args?.filename
  if (typeof filename === 'string' && filename.trim()) return filename
  return record.action
}

function StatusBadge({ status }: { status: OutboxRecordDto['status'] }) {
  const { t } = useTranslation()
  const style =
    status === 'sent'
      ? 'bg-emerald-500/15 text-emerald-600'
      : status === 'pending'
        ? 'bg-amber-500/15 text-amber-600'
        : 'bg-red-500/15 text-red-600'
  const Icon = status === 'sent' ? Check : status === 'pending' ? Clock : X
  const label =
    status === 'sent'
      ? t('events.outbox.sent', { defaultValue: '已发送' })
      : status === 'pending'
        ? t('events.outbox.pending', { defaultValue: '待发送' })
        : t('events.outbox.failed', { defaultValue: '发送失败' })
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] ${style}`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  )
}

export function OutboxPanel({ workspaceId, className }: OutboxPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [records, setRecords] = React.useState<OutboxRecordDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    try {
      const rows = await window.electronAPI.listOutbox(workspaceId)
      setRecords(Array.isArray(rows) ? rows : [])
    } catch (error) {
      console.error('[OutboxPanel] load failed:', error)
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  // The dispatcher mutates records in the background (retries, give-ups),
  // so the panel keeps a slow refresh of its own — five seconds, same cadence
  // as the dispatcher tick that writes.
  React.useEffect(() => {
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(timer)
  }, [load])

  const retry = async (id: string) => {
    setBusy(true)
    try {
      await window.electronAPI.retryOutbox(workspaceId, id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const purge = async () => {
    setBusy(true)
    try {
      await window.electronAPI.purgeOutbox(workspaceId)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const hasResolved = records.some((record) => record.status !== 'pending')
  const pendingCount = records.filter((record) => record.status === 'pending').length

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-[13px] text-muted-foreground">
          {t('events.outbox.title', { defaultValue: '发出的消息' })}
        </span>
        {hasResolved && (
          <button
            type="button"
            onClick={() => void purge()}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {t('events.outbox.purge', { defaultValue: '清除已处理' })}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && records.length === 0 && (
          <div className="px-3 py-6 text-[13px] text-muted-foreground/60">{t('events.outbox.loading', { defaultValue: '加载中…' })}</div>
        )}

        {!loading && records.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Inbox className="h-7 w-7 opacity-70" />
            <p className="text-sm">{t('events.outbox.empty', { defaultValue: '发件箱为空' })}</p>
            <p className="text-xs opacity-70">{t('events.outbox.emptyHint', { defaultValue: 'Agent 要求发出的消息会在这里记录' })}</p>
          </div>
        )}

        {records.map((record) => (
          <div key={record.id} className="px-3 pr-4 py-3 mx-1 rounded-[8px]" style={{ width: 'calc(100% - 8px)' }}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] tabular-nums text-muted-foreground/70 shrink-0">
                {record.listenerId}
              </span>
              <span className="text-[12px] text-foreground/60 shrink-0">·</span>
              <span className="text-[13px] text-foreground/80 truncate min-w-0 flex-1" title={previewOf(record)}>
                {previewOf(record)}
              </span>
              <span className="shrink-0">
                <StatusBadge status={record.status} />
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5 text-[12px] leading-5 text-muted-foreground">
              <span>{formatTime(record.updatedAt)}</span>
              {record.attempts > 0 && (
                <>
                  <span className="opacity-50">·</span>
                  <span>{t('events.outbox.attempts', { defaultValue: '重试' })} {record.attempts}</span>
                </>
              )}
              {record.status === 'pending' && record.nextAttemptAt ? (
                <>
                  <span className="opacity-50">·</span>
                  <span>{t('events.outbox.nextRetry', { defaultValue: '下次重试' })} {formatTime(record.nextAttemptAt)}</span>
                </>
              ) : null}
              {record.status === 'failed' && (
                <button
                  type="button"
                  onClick={() => void retry(record.id)}
                  disabled={busy}
                  className="ml-auto inline-flex items-center gap-1 text-[12px] text-foreground hover:underline disabled:opacity-50"
                >
                  <RotateCw className="h-3 w-3" />
                  {t('events.outbox.retry', { defaultValue: '重试' })}
                </button>
              )}
            </div>
            {record.lastError && record.status !== 'sent' && (
              <div className="text-[12px] text-red-500/90 mt-1 truncate" title={record.lastError}>
                {record.lastError}
              </div>
            )}
          </div>
        ))}

        {records.length > 0 && pendingCount > 0 && (
          <div className="px-4 py-2 text-[12px] text-muted-foreground/70 border-t border-border">
            {t('events.outbox.pendingNote', { defaultValue: '有消息正在后台重试，成功或彻底失败前会一直留在这里' })}
          </div>
        )}
      </div>
    </div>
  )
}
