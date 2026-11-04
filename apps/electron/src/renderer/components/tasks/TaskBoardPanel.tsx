/**
 * Task board (sidebar panel).
 *
 * Two levels: a grouped list (进行中 / 等我拍板 / 已完成) and a detail pane
 * with the handoff trail. Deliberately no third column at this width — the
 * detail slides over the list, which is what the shell's panel width can hold.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, CircleDot, PauseCircle, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

export type TaskStatus = 'backlog' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'

export interface TaskListItem {
  id: string
  name: string
  status: TaskStatus
  priority: number
  updatedAt: number
  currentSessionId?: string
  sessionCount: number
  lastHandoff?: string
  pauseReason?: string | null
}

export interface TaskHandoffView {
  at: number
  fromSessionId: string
  outcome: 'delivered' | 'handoff' | 'needs_decision'
  summary: string
  keyFindings?: string[]
  nextAction?: string
  artifacts?: { path: string; note?: string }[]
  verify?: { ran: string[]; passed: boolean; note?: string }
}

export interface TaskDetailView {
  id: string
  name: string
  instruction: string
  status: TaskStatus
  pauseReason?: string | null
  sessionIds: string[]
  currentSessionId?: string
  handoffs: TaskHandoffView[]
  budget: { maxSessions: number; maxRuns: number; activeMinutes: number; deadline?: number | null }
  verify: { enabled: boolean; requirement?: string; maxIterations: number; lastVerdict?: 'pass' | 'fail' }
  lifecycle: { errorCount: number; consecutiveFailures: number; lastError?: string }
  createdAt: number
  updatedAt: number
}

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  backlog: <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />,
  running: <CircleDot className="h-3.5 w-3.5 text-blue-500" />,
  paused: <PauseCircle className="h-3.5 w-3.5 text-amber-500" />,
  completed: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
  canceled: <XCircle className="h-3.5 w-3.5 text-muted-foreground" />,
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: '待开始',
  running: '进行中',
  paused: '暂停',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

/** Three buckets the user actually acts on. */
const GROUPS: Array<{ key: string; label: string; match: (s: TaskStatus) => boolean }> = [
  { key: 'active', label: '进行中', match: (s) => s === 'running' || s === 'backlog' },
  { key: 'blocked', label: '等我拍板', match: (s) => s === 'paused' },
  { key: 'done', label: '已完成', match: (s) => s === 'completed' || s === 'failed' || s === 'canceled' },
]

function formatAge(ts: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export interface TaskBoardPanelProps {
  tasks: TaskListItem[]
  selectedId?: string
  detail?: TaskDetailView | null
  onSelect: (id: string) => void
  onCloseDetail: () => void
  /** Resume / cancel, surfaced as buttons on a paused task. */
  onResume?: (id: string) => void
  onCancel?: (id: string) => void
}

export function TaskBoardPanel({
  tasks,
  selectedId,
  detail,
  onSelect,
  onCloseDetail,
  onResume,
  onCancel,
}: TaskBoardPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">{t('taskboard.title', { defaultValue: '任务' })}</span>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {tasks.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            {t('taskboard.empty', { defaultValue: '还没有任务。督导在处理跨会话的活时会建一个。' })}
          </div>
        ) : (
          GROUPS.map((group) => {
            const items = tasks.filter((task) => group.match(task.status))
            if (items.length === 0) return null
            return (
              <div key={group.key} className="mb-2">
                <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                {items.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelect(task.id)}
                    className={cn(
                      'mb-0.5 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left',
                      'hover:bg-accent',
                      selectedId === task.id && 'bg-accent',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {STATUS_ICON[task.status]}
                      <span className="truncate text-sm">{task.name}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {task.id} · {STATUS_LABEL[task.status]}
                      {task.pauseReason ? ` · ${task.pauseReason}` : ''} · {formatAge(task.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )
          })
        )}
      </div>

      {detail ? (
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="truncate text-sm font-medium">
              {detail.id} · {detail.name}
            </span>
            <button type="button" className="text-xs text-muted-foreground" onClick={onCloseDetail}>
              {t('taskboard.close', { defaultValue: '关闭' })}
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2 text-xs">
            <section>
              <div className="mb-1 text-[11px] uppercase text-muted-foreground">说明</div>
              <p className="whitespace-pre-wrap">{detail.instruction}</p>
            </section>

            <section className="flex flex-wrap gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5">{STATUS_LABEL[detail.status]}</span>
              <span className="rounded bg-muted px-1.5 py-0.5">
                会话 {detail.sessionIds.length}/{detail.budget.maxSessions}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5">
                失败 {detail.lifecycle.consecutiveFailures}/3
              </span>
              {detail.verify.enabled ? (
                <span className="rounded bg-muted px-1.5 py-0.5">
                  验收 {detail.verify.lastVerdict ?? '待判定'}
                </span>
              ) : null}
            </section>

            {detail.pauseReason ? (
              <div className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span>暂停原因：{detail.pauseReason}</span>
              </div>
            ) : null}

            <section>
              <div className="mb-1 text-[11px] uppercase text-muted-foreground">交接流水</div>
              {detail.handoffs.length === 0 ? (
                <div className="text-muted-foreground">还没有交接。</div>
              ) : (
                <ol className="space-y-2">
                  {detail.handoffs.map((handoff, index) => (
                    <li key={`${handoff.at}-${index}`} className="rounded border p-2">
                      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{new Date(handoff.at).toLocaleString()}</span>
                        <span>· {handoff.outcome}</span>
                        <span>· {handoff.fromSessionId}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{handoff.summary}</p>
                      {handoff.nextAction ? (
                        <p className="mt-1 text-muted-foreground">下一步：{handoff.nextAction}</p>
                      ) : null}
                      {handoff.verify ? (
                        <p className={handoff.verify.passed ? 'mt-1 text-emerald-600' : 'mt-1 text-destructive'}>
                          验证：{handoff.verify.ran.join(' / ')} → {handoff.verify.passed ? '通过' : '未通过'}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {detail.status === 'paused' ? (
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  className="rounded border px-2 py-1"
                  onClick={() => onResume?.(detail.id)}
                >
                  继续
                </button>
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-muted-foreground"
                  onClick={() => onCancel?.(detail.id)}
                >
                  取消任务
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
