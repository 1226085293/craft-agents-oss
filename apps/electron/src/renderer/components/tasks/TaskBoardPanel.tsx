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
  PlayCircle,
  Trash2,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { TaskDetailPanelView } from './TaskDetailPanelView'


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
  /** What a paused task is waiting for, when it is waiting on a person. */
  decisionLabel?: string
}

export interface TaskHandoffView {
  at: number
  fromSessionId: string
  outcome: 'delivered' | 'handoff' | 'needs_decision'
  /** Did this change the task's state or its executor? See `Handoff.milestone`. */
  milestone?: boolean
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
    /** The worker's own checklist — the stages this task went through. */
    plan?: Array<{
      id: string
      title: string
      status: 'todo' | 'doing' | 'done' | 'blocked'
      /** Which profile owns the stage; absent means the task's assignee. */
      agent?: string
      note?: string
    }>
  }
  /**
   * The pending question, when `pauseReason` is `needs_decision`.
   *
   * The card used to guess: it offered 「同意，继续跑」/「否，取消任务」 no matter what had
   * actually been asked, so a question with three real answers was answered by a yes/no
   * that matched none of them. `options` is what the asker enumerated; `其他` covers the
   * rest.
   */
  decision?: {
    id?: string
    category?: string
    label?: string
    reason?: string
    askedAt?: number
    deadlineAt?: number
    resolvedAt?: number
    options?: string[]
    /** The question as the relaying session asked it; `reason` keeps the diagnosis. */
    question?: string
    /** What the person replied, recorded on the task so it survives a reload. */
    answer?: { text: string; at: number }
  }
  /**
   * Every question on the task, open and closed.
   *
   * A task can wait on several at once, and the page has to draw them all — `decision` is only the
   * newest open one, kept for readers written before the queue existed.
   */
  decisions?: Array<{
    id?: string
    category?: string
    label?: string
    reason?: string
    askedAt?: number
    deadlineAt?: number
    resolvedAt?: number
    options?: string[]
    question?: string
    answer?: { text: string; at: number }
  }>
  /** Who asked. A free-text answer is a message to this session. */
  supervisorSessionId?: string
  /** Profile this task is assigned to; absent means the workspace default. */
  assigneeAgentId?: string
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
  asking: '等问句',
  // Stopped on instruction with the plan unfinished: the plan has more work, but nobody is
  // asking anything. Without this the list printed the raw enum value.
  awaiting_release: '已按指示停止',
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
  {
    /**
     * A pause with no question yet is not 「等你拍板」.
     *
     * The board used to put it in that group, so the person was shown a column headed 「必须由人
     * 决定」 with nothing in it to decide. Separate group, separate instruction: nothing to do.
     */
    key: 'asking',
    label: '等问句',
    hint: '督导正在整理要问的内容，暂时不用操作',
    match: (task) => task.status === 'paused' && task.pauseReason === 'asking',
  },
  { key: 'running', label: '进行中', match: (task) => task.status === 'running' },
  { key: 'backlog', label: '待开始', match: (task) => task.status === 'backlog' },
  {
    key: 'paused',
    label: '已暂停',
    hint: '失败、超预算或进程丢失',
    match: (task) =>
      task.status === 'paused' && task.pauseReason !== 'needs_decision' && task.pauseReason !== 'asking',
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

/**
 * Task ids in the order the board actually displays them.
 *
 * The board renders group by group, so what the eye sees is the concatenation of
 * the groups — not the order of the incoming array. Range selection read the raw
 * array instead, which meant a shift-click swept up tasks from a different group
 * and skipped the rows that sat between them on screen: two different answers to
 * "what is between these two rows".
 *
 * Derived from `GROUPS` rather than hardcoded, so adding a group cannot silently
 * reintroduce the mismatch. Tasks matching no group are absent here for the same
 * reason they are absent on screen.
 */
function boardOrder(tasks: TaskListItem[]): string[] {
  return GROUPS.flatMap((group) =>
    tasks.filter((task) => group.match(task)).map((task) => task.id),
  )
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
  /** Answer a pending decision with words; see TaskDetailPanelViewProps.onAnswer. */
  onAnswer?: (id: string, text: string) => void
  /** Open the session that is working on a task (board entry as a link). */
  onOpenSession?: (sessionId: string) => void
  /** Pause a live task without cancelling it. */
  onPause?: (id: string) => void
  /** Delete a finished task for good (record, journal, index entry). */
  onDelete?: (id: string) => void
  /** Same, for a multi-selection — one pass, so the caller can clear selection once. */
  onDeleteMany?: (ids: string[]) => void
  /** Workspace roster, so a plan step's owner prints as its display name. */
  agents?: ReadonlyArray<{ id: string; name: string }>
}

/** One item in the right-click menu, plus who it applies to. */
type BoardAction = 'pause' | 'resume' | 'cancel' | 'delete'

const ACTION_LABEL: Record<BoardAction, string> = {
  pause: '暂停',
  resume: '恢复',
  cancel: '取消任务',
  delete: '删除',
}

/** Statuses that are finished — their record can be removed. */
const FINISHED: readonly TaskStatus[] = ['completed', 'failed', 'canceled']

function isFinished(status: TaskStatus): boolean {
  return FINISHED.includes(status)
}

/**
 * What one task can do, judged from its status alone.
 *
 * `paused` offers resume rather than pause: a task already stopped has nothing
 * to stop. A running task offers cancel but not delete — deleting it would pull
 * the record out from under the session that is still writing to it.
 */
export function actionsFor(status: TaskStatus): BoardAction[] {
  if (isFinished(status)) return ['delete']
  if (status === 'paused') return ['resume', 'cancel']
  return ['pause', 'cancel']
}

/**
 * Actions every one of these tasks can do.
 *
 * The intersection, not the union: offering 取消 when one of five selected tasks
 * is already finished would either fail for that one or silently skip it. When
 * nothing is shared the result is empty, and the caller opens no menu at all —
 * a menu that opens with no items is worse than no menu.
 */
export function sharedActionsFor(statuses: TaskStatus[]): BoardAction[] {
  if (statuses.length === 0) return []
  return statuses
    .map(actionsFor)
    .reduce((acc, list) => acc.filter((action) => list.includes(action)))
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
  onAnswer,
  onOpenSession,
  onPause,
  onDelete,
  onDeleteMany,
  agents,
}: TaskBoardPanelProps): React.JSX.Element {
  const { t } = useTranslation()

  // Selection is local to the navigator: it is a way to act on several tasks at
  // once, not a piece of app state that routes depend on.
  const [multi, setMulti] = React.useState<string[]>([])
  const anchorRef = React.useRef<string | null>(null)

  const runAction = React.useCallback(
    (action: BoardAction, ids: string[]) => {
      for (const id of ids) {
        if (action === 'pause') onPause?.(id)
        else if (action === 'resume') onRun?.(id)
        else if (action === 'cancel') onCancel?.(id)
        else if (action === 'delete' && onDeleteMany) onDeleteMany(ids)
        else if (action === 'delete') onDelete?.(id)
      }
      if (action === 'delete') {
        // A deleted task cannot stay selected, or the detail pane would keep
        // asking the backend for a record that no longer exists.
        setMulti((prev) => prev.filter((id) => !ids.includes(id)))
      }
    },
    [onPause, onRun, onCancel, onDelete, onDeleteMany],
  )

  /**
   * Click / ctrl-click / shift-click, the way a file list behaves.
   *
   * Shift selects the visible range in board order — the order the user sees,
   * not the order the array happens to be in, otherwise a range selection would
   * jump across groups.
   */
  const handleItemClick = React.useCallback(
    (event: React.MouseEvent, id: string) => {
      // A right-click is not a left-click: the browser fires mousedown for it
      // too, and letting that path run would collapse a multi-selection down to
      // the one row under the cursor — the menu would then act on one task while
      // the user had picked five.
      if (event.button !== 0) {
        if (!multi.includes(id)) {
          setMulti([id])
          anchorRef.current = id
        }
        return
      }
      const ordered = boardOrder(tasks)
      if (event.shiftKey && anchorRef.current) {
        const from = ordered.indexOf(anchorRef.current)
        const to = ordered.indexOf(id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          setMulti(ordered.slice(start, end + 1))
          return
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setMulti((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
        anchorRef.current = id
        return
      }
      setMulti([id])
      anchorRef.current = id
      onSelect(id)
    },
    [tasks, onSelect, multi],
  )

  /** Right-click targets: the selection if it was hit, otherwise just this row. */
  const targetsFor = React.useCallback(
    (id: string): string[] => (multi.includes(id) ? multi : [id]),
    [multi],
  )

  /**
   * Actions every targeted task can do.
   *
   * The intersection, not the union: offering 取消 when one of five selected
   * tasks is already finished would either fail for that one or silently skip
   * it. When nothing is shared the list is empty and no menu opens at all — a
   * menu that opens with no items is worse than no menu.
   */
  const sharedActions = React.useCallback(
    (ids: string[]): BoardAction[] => {
      const chosen = tasks.filter((task) => ids.includes(task.id))
      return sharedActionsFor(chosen.map((task) => task.status))
    },
    [tasks],
  )

  const selection = multi.length > 0 ? multi : selectedId ? [selectedId] : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-semibold">{t('taskboard.title', { defaultValue: '任务' })}</span>
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground" aria-label={`${tasks.length} 项任务`}>
            {tasks.length}
          </span>
        </div>
        {/*
          No "+ 新建" here on purpose. A task carries a scope, an acceptance
          list and an executor — none of which a dialog can invent, and a task
          created by hand has no supervisor watching it. Work is created by
          asking the supervisor, which is the only path that also assigns who
          does it and how it is judged.
        */}
      </div>

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
                    {items.map((task) => {
                      const targets = targetsFor(task.id)
                      const menu = sharedActions(targets)
                      const selected = multi.includes(task.id)
                      return (
                      <ContextMenu key={task.id}>
                        <ContextMenuTrigger asChild disabled={menu.length === 0}>
                      <div
                        className={cn(
                          'group flex w-full flex-col gap-1 rounded-lg border-l-2 border-transparent px-3 py-2.5 text-left transition-colors duration-150',
                          'hover:bg-foreground/5',
                          (selected || selectedId === task.id) && 'border-accent bg-accent/10',
                        )}
                        onMouseDown={(event) => handleItemClick(event, task.id)}
                        aria-selected={selected || selectedId === task.id}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {STATUS_ICON[task.status]}
                          <button
                            type="button"
                            aria-pressed={selected || selectedId === task.id}
                            onClick={(event) => {
                              if (event.shiftKey || event.ctrlKey || event.metaKey) handleItemClick(event, task.id)
                              else onSelect(task.id)
                            }}
                            className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          >
                            {task.name}
                          </button>
                          {/*
                            The task is what the board is about; the session is
                            where the work actually is. Jumping straight there is
                            the difference between "this task is running" and
                            "let me see what it is doing right now".
                          */}
                          {task.currentSessionId && onOpenSession ? (
                            <button
                              type="button"
                              onClick={() => onOpenSession(task.currentSessionId!)}
                              title="打开正在执行这个任务的会话"
                              className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              会话 ↗
                            </button>
                          ) : null}
                          <ArrowRight className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-70',
                            selectedId === task.id && 'opacity-70',
                          )} aria-hidden="true" />
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[22px] text-[11.5px] text-muted-foreground">
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
                          /*
                           * One label, not two. A decision pause says 「等待你决定」 and the
                           * decision's own label says 「需要你决定」 — printing both read as
                           * 「等待你决定 · 需要你决定」. The decision's wording is the more
                           * specific of the two, so it replaces the generic one when present.
                           */
                          <span className="truncate pl-[22px] text-[11.5px] text-amber-400" title={task.decisionLabel ?? pauseReasonLabel(task.pauseReason)}>
                            {task.decisionLabel ?? pauseReasonLabel(task.pauseReason)}
                          </span>
                        ) : null}
                        {task.lastHandoff ? (
                          <span className="line-clamp-2 pl-[22px] text-[12px] leading-relaxed text-muted-foreground/90" title={task.lastHandoff}>
                            {task.lastHandoff}
                          </span>
                        ) : null}
                      </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-44">
                          {targets.length > 1 ? (
                            <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                              已选 {targets.length} 项
                            </div>
                          ) : null}
                          {menu.includes('pause') ? (
                            <ContextMenuItem onSelect={() => runAction('pause', targets)}>
                              <PauseCircle className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                              {ACTION_LABEL.pause}
                            </ContextMenuItem>
                          ) : null}
                          {menu.includes('resume') ? (
                            <ContextMenuItem onSelect={() => runAction('resume', targets)}>
                              <PlayCircle className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                              {ACTION_LABEL.resume}
                            </ContextMenuItem>
                          ) : null}
                          {menu.includes('cancel') ? (
                            <ContextMenuItem onSelect={() => runAction('cancel', targets)}>
                              <XCircle className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                              {ACTION_LABEL.cancel}
                            </ContextMenuItem>
                          ) : null}
                          {menu.includes('delete') && menu.length > 1 ? <ContextMenuSeparator /> : null}
                          {menu.includes('delete') ? (
                            <ContextMenuItem
                              onSelect={() => runAction('delete', targets)}
                              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                              {ACTION_LABEL.delete}
                            </ContextMenuItem>
                          ) : null}
                        </ContextMenuContent>
                      </ContextMenu>
                      )
                    })}
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
            agents={agents}
            onRun={onRun}
            onClose={onCloseDetail}
            onResume={onResume}
            onAnswer={onAnswer}
            onCancel={onCancel}
          />
        </div>
      ) : null}
    </div>
  )
}
