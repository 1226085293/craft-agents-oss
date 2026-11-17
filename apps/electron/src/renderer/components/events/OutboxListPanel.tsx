/**
 * Outbox navigator column (发件箱 左2): every message the agent asked a
 * plugin to send, with its delivery state.
 *
 * Toolbar: search, target filter (the listener that carries the message),
 * status filter (sent / not-sent), and newest/oldest order — the same
 * grammar as the event log. Rows support the Explorer selection grammar
 * (single / Ctrl / Shift) and a right-click delete with second confirm;
 * the detail view lives in 左3 (OutboxDetailPanel).
 *
 * The dispatcher mutates records in the background (retries, give-ups),
 * so the panel keeps a slow refresh of its own — five seconds, the same
 * cadence as the dispatcher tick that writes.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Inbox, RotateCw, Check, Clock, X } from 'lucide-react'
import type { OutboxRecordDto } from '@craft-agent/shared/protocol/dto'
import { FilterMenu, SortMenu, type SortOrder, formatTime } from './EventsListPanel'
import { useExplorerSelection, RowDeleteMenu, RecordDeleteConfirm } from './list-interactions'

export interface OutboxListPanelProps {
  workspaceId: string
  selectedOutboxId: string | null
  onSelectOutbox: (outboxId: string) => void
  /** Fired after a bulk delete succeeds so the shell can drop a stale detail. */
  onDeleted?: (ids: string[]) => void
  className?: string
}

/** The one-line preview: message text when there is some, else the file name. */
export function previewOf(record: OutboxRecordDto): string {
  const text = record.args?.text
  if (typeof text === 'string' && text.trim()) return text.trim()
  const filename = record.args?.filename
  if (typeof filename === 'string' && filename.trim()) return filename
  return record.action
}

export function OutboxStatusBadge({ status }: { status: OutboxRecordDto['status'] }): React.ReactElement {
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

/** 状态筛选: sent / not-sent (pending + failed) / everything. */
type OutboxStatusFilter = '' | 'sent' | 'unsent'

export function OutboxListPanel({
  workspaceId,
  selectedOutboxId,
  onSelectOutbox,
  onDeleted,
  className,
}: OutboxListPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const [records, setRecords] = React.useState<OutboxRecordDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [status, setStatus] = React.useState<OutboxStatusFilter>('')
  const [sortOrder, setSortOrder] = React.useState<SortOrder>('desc')

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    try {
      const rows = await window.electronAPI.listOutbox(workspaceId)
      setRecords(Array.isArray(rows) ? rows : [])
    } catch (error) {
      console.error('[OutboxListPanel] load failed:', error)
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  // The dispatcher mutates records in the background; keep a slow refresh.
  React.useEffect(() => {
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(timer)
  }, [load])

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])

  const targets = React.useMemo(
    () => Array.from(new Set(records.map((record) => record.listenerId))).sort(),
    [records],
  )

  // The outbox is small (a few hundred records at most), so filtering and
  // ordering are pure view work over one list — no server round-trip.
  const visible = React.useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase()
    let rows = records
    if (target) rows = rows.filter((record) => record.listenerId === target)
    if (status === 'sent') rows = rows.filter((record) => record.status === 'sent')
    else if (status === 'unsent') rows = rows.filter((record) => record.status !== 'sent')
    if (query) {
      rows = rows.filter((record) =>
        [
          previewOf(record),
          record.action,
          record.listenerId,
          String(record.args?.channelId ?? ''),
          record.lastError ?? '',
        ]
          .join(' ')
          .toLowerCase()
          .includes(query),
      )
    }
    return [...rows].sort((a, b) =>
      sortOrder === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
    )
  }, [records, target, status, debouncedSearch, sortOrder])

  const retry = async (id: string) => {
    setBusy(true)
    try {
      await window.electronAPI.retryOutbox(workspaceId, id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------------
  // Bulk selection + right-click delete (shared Explorer grammar).
  // ------------------------------------------------------------------
  const { selected, handleRowClick, handleRowContext, dropIds } = useExplorerSelection(
    visible.map((record) => record.id),
  )
  const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const confirmDeleteNow = React.useCallback(async () => {
    const ids = [...selected]
    if (!ids.length) return
    setDeleteBusy(true)
    try {
      await window.electronAPI.removeOutbox(workspaceId, ids)
      dropIds(ids)
      setRecords((prev) => prev.filter((record) => !ids.includes(record.id)))
      onDeleted?.(ids)
    } catch (error) {
      console.error('[OutboxListPanel] delete failed:', error)
    } finally {
      setDeleteBusy(false)
      setConfirmDelete(false)
    }
  }, [selected, workspaceId, dropIds, onDeleted])

  const pendingCount = records.filter((record) => record.status === 'pending').length

  return (
    <div className={className ? `flex flex-col h-full ${className}` : 'flex flex-col h-full'}>
      <div className="px-3 py-3 space-y-2.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('events.outbox.searchPlaceholder', { defaultValue: '搜索发件箱…' })}
            className="w-full h-9 pl-9 pr-2.5 text-[13.5px] bg-muted/40 rounded-md border border-transparent focus:border-foreground/20 focus:outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterMenu
            value={target}
            placeholder={t('events.outbox.allTargets', { defaultValue: '全部目标' })}
            options={targets}
            onChange={setTarget}
          />
          <FilterMenu
            value={
              status === 'sent'
                ? t('events.outbox.sent', { defaultValue: '已发送' })
                : status === 'unsent'
                  ? t('events.outbox.unsent', { defaultValue: '未发送' })
                  : ''
            }
            placeholder={t('events.list.rowStatus', { defaultValue: '状态' })}
            allLabel={t('events.list.all', { defaultValue: '全部' })}
            options={[
              t('events.outbox.sent', { defaultValue: '已发送' }),
              t('events.outbox.unsent', { defaultValue: '未发送' }),
            ]}
            onChange={(next) => {
              setStatus(
                next === t('events.outbox.sent', { defaultValue: '已发送' })
                  ? 'sent'
                  : next === t('events.outbox.unsent', { defaultValue: '未发送' })
                    ? 'unsent'
                    : '',
              )
            }}
          />
          <SortMenu value={sortOrder} onChange={setSortOrder} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && records.length === 0 && (
          <div className="px-3 py-6 text-[13px] text-muted-foreground/60">
            {t('events.outbox.loading', { defaultValue: '加载中…' })}
          </div>
        )}

        {!loading && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Inbox className="h-7 w-7 opacity-70" />
            <p className="text-sm">
              {records.length === 0
                ? t('events.outbox.empty', { defaultValue: '发件箱为空' })
                : t('events.list.empty', { defaultValue: '没有事件' })}
            </p>
            {records.length === 0 && (
              <p className="text-xs opacity-70">
                {t('events.outbox.emptyHint', { defaultValue: 'Agent 要求发出的消息会在这里记录' })}
              </p>
            )}
          </div>
        )}

        {visible.map((record) => {
          const active = record.id === selectedOutboxId
          const multi = selected.has(record.id)
          return (
            <div
              key={record.id}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                const modifierClick = handleRowClick(e, record.id)
                if (!modifierClick) onSelectOutbox(record.id)
              }}
              onContextMenu={(e) => {
                handleRowContext(e, record.id)
                setMenuPos({ x: e.clientX, y: e.clientY })
              }}
              className={`relative w-full text-left px-3 pr-4 py-3 mx-1 rounded-[8px] transition-colors ${
                active
                  ? 'bg-foreground/3 shadow-[inset_2px_0_0_0_hsl(var(--accent))]'
                  : multi
                    ? 'bg-foreground/5'
                    : 'hover:bg-foreground/2'
              }`}
              style={{ width: 'calc(100% - 8px)' }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[12px] tabular-nums text-muted-foreground/70 shrink-0">
                  {record.listenerId}
                </span>
                <span className="text-[12px] text-foreground/60 shrink-0">·</span>
                <span className="text-[13px] text-foreground/80 truncate min-w-0 flex-1" title={previewOf(record)}>
                  {previewOf(record)}
                </span>
                <span className="shrink-0">
                  <OutboxStatusBadge status={record.status} />
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
                    <span>
                      {t('events.outbox.nextRetry', { defaultValue: '下次重试' })} {formatTime(record.nextAttemptAt)}
                    </span>
                  </>
                ) : null}
                {record.status === 'failed' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void retry(record.id)
                    }}
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
          )
        })}
      </div>

      {records.length > 0 && pendingCount > 0 && (
        <div className="px-4 py-2 text-[12px] text-muted-foreground/70 border-t border-border">
          {t('events.outbox.pendingNote', {
            defaultValue: '有消息正在后台重试，成功或彻底失败前会一直留在这里',
          })}
        </div>
      )}

      {menuPos && (
        <RowDeleteMenu
          position={menuPos}
          count={selected.size}
          onRequestDelete={() => setConfirmDelete(true)}
          onClose={() => setMenuPos(null)}
        />
      )}
      {confirmDelete && (
        <RecordDeleteConfirm
          count={selected.size}
          busy={deleteBusy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void confirmDeleteNow()}
        />
      )}
    </div>
  )
}
