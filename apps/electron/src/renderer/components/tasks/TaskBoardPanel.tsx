/**
 * Task navigator and detail presentation.
 *
 * The navigator stays compact in the shell's second column. The right content
 * panel uses TaskDetailPanelView directly so it can use the available width
 * without overlaying or duplicating the navigator.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  PauseCircle,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { TaskDetailPanelView } from './TaskDetailPanelView'
import { TaskCreateDialog, type TaskCreateInput } from './TaskCreateDialog'

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
  /** Structured contract (v2 tasks). Missing on older tasks. */
  spec?: {
    cwd?: string
    sources?: string[]
    skills?: string[]
    deliverables?: Array<{ kind: string; path?: string; note?: string; required?: boolean }>
    acceptance?: Array<{ id: string; check: string; command?: string }>
  }
  trigger?: { kind: 'manual' | 'cron' | 'event'; expr?: string; timezone?: string; source?: string; types?: string[]; enabled?: boolean }
  stats?: { runs: number; activeMs: number; lastHeartbeatAt?: number }
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
  paused: '等我拍板',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const PAUSE_REASON_LABEL: Record<string, string> = {
  failures: '连续失败',
  budget: '预算用尽',
  process_lost: '工作进程中断',
  waiting: '等待中',
  needs_decision: '等待你决定',
}

function pauseReasonLabel(reason: string): string {
  return PAUSE_REASON_LABEL[reason] ?? reason
}

const GROUPS: Array<{
  key: string
  label: string
  hint?: string
  match: (task: TaskListItem) => boolean
}> = [
  {
    key: 'decision',
    label: '等你拍板',
    hint: '必须由人决定，任务已停在这里',
    match: (task) => task.status === 'paused' && task.pauseReason === 'needs_decision',
  },
  { key: 'running', label: '进行中', match: (task) => task.status === 'running' },
  { key: 'backlog', label: '待开始', match: (task) => task.status === 'backlog' },
  {
    key: 'paused',
    label: '已暂停',
    hint: '失败、超预算或进程丢失',
    match: (task) => task.status === 'paused' && task.pauseReason !== 'needs_decision',
  },
  {
    key: 'done',
    label: '已结束',
    match: (task) => task.status === 'completed' || task.status === 'failed' || task.status === 'canceled',
  },
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
  /** Start a run now (backlog or paused). */
  onRun?: (id: string) => void
  /** Create a task from the UI. */
  onCreate?: (input: TaskCreateInput) => void
}

export function TaskBoardPanel({
  tasks,
  selectedId,
  detail,
  onSelect,
  onCloseDetail,
  onResume,
  onCancel,
  onRun,
  onCreate,
}: TaskBoardPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [creating, setCreating] = React.useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold">{t('taskboard.title', { defaultValue: '任务' })}</span>
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground" aria-label={`${tasks.length} 项任务`}>
            {tasks.length}
          </span>
        </div>
        {onCreate ? (
          <button
            type="button"
            className="rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-foreground/5"
            onClick={() => setCreating(true)}
          >
            + 新建
          </button>
        ) : null}
      </div>

      <TaskCreateDialog open={creating} onClose={() => setCreating(false)} onSubmit={(input) => onCreate?.(input)} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {tasks.length === 0 ? (
          <div className="mx-1 rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {t('taskboard.empty', { defaultValue: '还没有任务。督导在处理跨会话的活时会建一个。' })}
          </div>
        ) : (
          <div className="space-y-4">
            {GROUPS.map((group) => {
              const items = tasks.filter((task) => group.match(task))
              if (items.length === 0) return null
              return (
                <section key={group.key} aria-label={`${group.label}，${items.length} 项任务`}>
                  <div className="mb-1.5 flex items-center justify-between px-2">
                    <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground">{group.label}</h2>
                    <span className="text-[10px] tabular-nums text-muted-foreground/80">{items.length}</span>
                  </div>
                  <div className="space-y-1">
                    {items.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        aria-pressed={selectedId === task.id}
                        onClick={() => onSelect(task.id)}
                        className={cn(
                          'group flex w-full flex-col gap-1 rounded-lg border-l-2 border-transparent px-3 py-2.5 text-left transition-colors duration-150',
                          'hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                          selectedId === task.id && 'border-accent bg-accent/10',
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {STATUS_ICON[task.status]}
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{task.name}</span>
                          <ArrowRight className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-70',
                            selectedId === task.id && 'opacity-70',
                          )} aria-hidden="true" />
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[22px] text-[10px] text-muted-foreground">
                          <span className="font-mono">{task.id}</span>
                          <span aria-hidden="true">·</span>
                          <span>{STATUS_LABEL[task.status]}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatAge(task.updatedAt)}</span>
                          {task.sessionCount > 0 ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>会话 {task.sessionCount}</span>
                            </>
                          ) : null}
                        </span>
                        {task.pauseReason ? (
                          <span className="truncate pl-[22px] text-[10px] text-amber-400" title={pauseReasonLabel(task.pauseReason)}>
                            {pauseReasonLabel(task.pauseReason)}
                          </span>
                        ) : null}
                        {task.lastHandoff ? (
                          <span className="line-clamp-2 pl-[22px] text-[10px] leading-relaxed text-muted-foreground" title={task.lastHandoff}>
                            {task.lastHandoff}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      {detail ? (
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
          <TaskDetailPanelView
            detail={detail}
            onRun={onRun}
            onClose={onCloseDetail}
            onResume={onResume}
            onCancel={onCancel}
          />
        </div>
      ) : null}
    </div>
  )
}
