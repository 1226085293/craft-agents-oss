/**
 * Full-width task detail presentation for the content panel.
 * The task navigator stays compact and independent in the neighboring column.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  Circle,
  Loader2,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock3,
  FileText,
  PauseCircle,
  RotateCcw,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { agentLabelMap } from './agent-label'
import type { TaskDetailView, TaskHandoffView, TaskStatus } from './TaskBoardPanel'
import type { PlanJumpTarget } from '@/lib/plan-jump'

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  backlog: <CircleDot className="h-3.5 w-3.5" />,
  running: <CircleDot className="h-3.5 w-3.5" />,
  paused: <PauseCircle className="h-3.5 w-3.5" />,
  completed: <CheckCircle2 className="h-3.5 w-3.5" />,
  failed: <XCircle className="h-3.5 w-3.5" />,
  canceled: <XCircle className="h-3.5 w-3.5" />,
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: '待开始',
  running: '进行中',
  paused: '等我拍板',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STATUS_TONE: Record<TaskStatus, string> = {
  backlog: 'border-border/60 bg-foreground/5 text-muted-foreground',
  running: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  canceled: 'border-border/60 bg-foreground/5 text-muted-foreground',
}

// TaskService pauses after three consecutive failures (see shared task state rules).
const FAILURE_FUSE = 3

const PAUSE_REASON_LABEL: Record<string, string> = {
  failures: '连续失败',
  budget: '预算用尽',
  process_lost: '工作进程中断',
  waiting: '等待中',
  needs_decision: '等待你决定',
}

const HANDOFF_OUTCOME_LABEL: Record<TaskHandoffView['outcome'], string> = {
  delivered: '已交付',
  handoff: '继续交接',
  needs_decision: '等待决定',
}

function formatTimestamp(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts)
}

function pauseReasonLabel(reason: string): string {
  return PAUSE_REASON_LABEL[reason] ?? reason
}

export interface TaskDetailPanelViewProps {
  detail: TaskDetailView
  onClose?: () => void
  onResume?: (id: string) => void
  onCancel?: (id: string) => void
  /** Start a run now (claims the task lock and spawns a worker). */
  onRun?: (id: string) => void
  /** Open a session in the main pane (task ↔ session are two views of one thing). */
  onOpenSession?: (sessionId: string) => void
  /** Jump to the moment in a session that a plan step came from. */
  planJumps?: Map<string, PlanJumpTarget>
  onJumpToStep?: (target: PlanJumpTarget) => void
  /**
   * The workspace roster, so a step's owner prints as the name settings shows.
   * A plan stores `agent: "builtin-default"`; that id is a storage key, and printing it
   * on the page asked the reader to translate. Optional so the page still renders (with
   * ids) when the roster has not loaded yet.
   */
  agents?: ReadonlyArray<{ id: string; name: string }>
}

/** Full-width task detail for the content panel, with an optional navigator back action. */
export function TaskDetailPanelView({ detail, onClose, onResume, onCancel, onRun, onOpenSession, planJumps, onJumpToStep, agents }: TaskDetailPanelViewProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {onClose ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-background px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate td-row-sub font-semibold">{detail.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">任务id：{detail.id}</span>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
          >
            {t('taskboard.close', { defaultValue: '关闭' })}
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskDetailContent
          detail={detail}
          onResume={onResume}
          onCancel={onCancel}
          onRun={onRun}
          onOpenSession={onOpenSession}
          planJumps={planJumps}
          onJumpToStep={onJumpToStep}
          agents={agents}
        />
      </div>
    </div>
  )
}

function TaskDetailContent({ detail, onResume, onCancel, onRun, onOpenSession, planJumps, onJumpToStep, agents }: TaskDetailPanelViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const isPaused = detail.status === 'paused'
  const isStartable = detail.status === 'backlog' || isPaused
  const triggerLabel = detail.trigger?.kind === 'cron'
    ? `定时 · ${detail.trigger.expr}${detail.trigger.timezone ? ` (${detail.trigger.timezone})` : ''}`
    : detail.trigger?.kind === 'event'
      ? `事件 · ${detail.trigger.source ?? ''}${detail.trigger.types?.length ? `/${detail.trigger.types.join(',')}` : ''}`
      : '手动'
  // Placeholders hold the run lock before a session exists; they are not sessions.
  const realSessions = detail.sessionIds.filter((id) => !id.startsWith('pending:'))
  // `activeMs` is the accumulated time actually spent running; the budget is the
  // ceiling and belongs in the hint, not in the value.
  const activeMinutes = Math.round(((detail.stats?.activeMs ?? 0) / 60_000))
  const verificationLabel = detail.verify.lastVerdict === 'pass'
    ? '通过'
    : detail.verify.lastVerdict === 'fail'
      ? '未通过'
      : '待判定'

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-6 py-7 md:px-10 md:py-9">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/*
            * The status belongs to the name, so it sits on the name's baseline: "E2E
            * 计划验证 已完成" is one sentence. It used to sit above the title next to the
            * id, which made the id look like it qualified the status and left the reader
            * to pair the badge back up with the title by eye.
            * The id moves to the page's top-right corner — it is a reference number for
            * talking about the task, not part of its identity.
            */}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="td-title text-foreground">{detail.name}</h1>
            <StatusBadge status={detail.status} />
          </div>
          <p className="td-body mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            最近更新 {formatTimestamp(detail.updatedAt)}
            {typeof detail.stats?.runs === 'number' ? (
              <>
                <span className="mx-1 text-border">·</span>
                已运行 {detail.stats.runs} 次
              </>
            ) : null}
            {/*
              * 触发方式 rides on the meta line. It is one short fact about the task —
              * manual / cron / event — and giving it its own bordered section put a whole
              * heading between the title and the instruction for a single word.
              */}
            <span className="mx-1 text-border">·</span>
            <span>触发方式 {triggerLabel}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground/80">任务id：{detail.id}</span>
          {isStartable ? (
            <>
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border/70 bg-foreground/5 px-3 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => (onRun ?? onResume)?.(detail.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {isPaused ? '继续' : '开始'}
              </button>
              <button
                type="button"
                className="inline-flex min-h-9 items-center rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onCancel?.(detail.id)}
              >
                取消任务
              </button>
            </>
          ) : null}
        </div>
      </header>

      <section className="rounded-xl border border-border/60 bg-foreground/[0.02] p-4 md:p-5" aria-labelledby="task-instruction-heading">
        <div className="mb-2.5 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2 id="task-instruction-heading" className="td-heading text-foreground">任务说明</h2>
        </div>
        <p className="td-body whitespace-pre-wrap text-foreground/90">{detail.instruction}</p>
      </section>

      <PlanSection
        plan={detail.spec?.plan}
        assignee={detail.assigneeAgentId}
        jumps={planJumps}
        onJump={onJumpToStep}
        agents={agents}
        currentSessionId={detail.currentSessionId}
        onOpenSession={onOpenSession}
      />

      {(detail.spec?.cwd || detail.spec?.sources?.length || detail.spec?.deliverables?.length || detail.spec?.acceptance?.length) ? (
        <section className="rounded-xl border border-border/60 p-4 md:p-5" aria-labelledby="task-contract-heading">
          <div className="mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="task-contract-heading" className="td-heading text-foreground">执行契约</h2>
          </div>
          {/*
            * Values take the body size, labels take the label size. Every value here was
            * `text-xs` (11.25px) — the smallest text on the page — even though a working
            * directory and an acceptance command are things people read character by
            * character. Label vs value is hierarchy; 11px vs 15px was not, it was just
            * small.
            */}
          {/*
            * A vertical list, not a two-column grid. One value per line reads as a
            * contract: "· 工作目录: …" then "· 数据源: …". The grid split each row into two
            * columns, so adding a third field reflowed the existing ones and a long path
            * wrapped inside a half-width cell.
            */}
          <ul className="space-y-1.5 td-body">
            {detail.spec?.cwd ? (
              <li className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
                <span className="shrink-0 text-muted-foreground">工作目录:</span>
                <span className="min-w-0 break-all font-mono text-foreground">{detail.spec.cwd}</span>
              </li>
            ) : null}
            {detail.spec?.sources?.length ? (
              <li className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
                <span className="shrink-0 text-muted-foreground">数据源:</span>
                <span className="min-w-0 break-words text-foreground">{detail.spec.sources.join('、')}</span>
              </li>
            ) : null}
            {detail.spec?.deliverables?.length ? (
              <li className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
                <span className="shrink-0 text-muted-foreground">交付物:</span>
                <span className="min-w-0 break-words text-foreground">
                  {detail.spec.deliverables.map((item, index) => (
                    <span key={`${item.kind}-${index}`} className="block">
                      <span className="font-mono text-muted-foreground">{item.kind}</span>
                      {item.path ? <span className="ml-1.5 break-all font-mono">{item.path}</span> : null}
                      {item.note ? <span className="ml-1.5 text-muted-foreground">{item.note}</span> : null}
                    </span>
                  ))}
                </span>
              </li>
            ) : null}
            {detail.spec?.acceptance?.length ? (
              <li className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
                <span className="shrink-0 text-muted-foreground">验收命令:</span>
                <span className="min-w-0 break-words text-foreground">
                  {detail.spec.acceptance.map((item) => (
                    <span key={item.id} className="block">
                      <span className="mr-1.5 font-mono text-muted-foreground">{item.id}</span>
                      {item.check}
                      {item.command ? (
                        <span className="ml-1.5 break-all font-mono text-muted-foreground">{item.command}</span>
                      ) : null}
                    </span>
                  ))}
                </span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="任务摘要">
        {/*
          Two numbers used to be wrong here in a way that made the board untrustworthy.
          The session count included the `pending:<reason>` placeholder that holds the run
          lock before a session exists, so a task with one worker read "2 / 8". And the
          active-time card printed `budget.activeMinutes` — the ceiling — under the label
          累计执行时间, so every task claimed exactly 120 minutes of work.
        */}
        <MetricCard
          label="会话"
          value={`${realSessions.length} / ${detail.budget.maxSessions}`}
          hint="已使用 / 上限"
        />
        <MetricCard label="连续失败" value={`${detail.lifecycle.consecutiveFailures} / ${FAILURE_FUSE}`} hint="触发暂停阈值" tone={detail.lifecycle.consecutiveFailures > 0 ? 'warning' : 'default'} />
        <MetricCard
          label="活跃时间"
          value={`${activeMinutes} 分钟`}
          hint={`上限 ${detail.budget.activeMinutes} 分钟`}
          tone={activeMinutes >= detail.budget.activeMinutes ? 'warning' : 'default'}
        />
        {detail.verify.enabled ? (
          <MetricCard
            label="验收"
            value={verificationLabel}
            hint={`迭代上限 ${detail.verify.maxIterations}`}
            tone={detail.verify.lastVerdict === 'pass' ? 'success' : detail.verify.lastVerdict === 'fail' ? 'danger' : 'default'}
          />
        ) : null}
      </section>

      {detail.pauseReason === 'needs_decision' ? (
        <section className="rounded-xl border border-amber-500/35 bg-amber-500/8 p-4 md:p-5" aria-labelledby="task-decision-heading">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 id="task-decision-heading" className="text-xs font-semibold text-amber-300">等你拍板</h2>
              <p className="td-body mt-1 whitespace-pre-wrap text-foreground/90">
                {detail.handoffs.at(-1)?.summary ?? '执行会话停下来请求决定，但没留下说明。'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-amber-500/20 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/30"
                  onClick={() => (onRun ?? onResume)?.(detail.id)}
                >
                  同意，继续跑
                </button>
                <button
                  type="button"
                  className="inline-flex min-h-8 items-center rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onCancel?.(detail.id)}
                >
                  否，取消任务
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {detail.pauseReason && detail.pauseReason !== 'needs_decision' ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 p-3.5" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-amber-300">暂停原因</div>
            <p className="td-body mt-1 text-foreground/85">{pauseReasonLabel(detail.pauseReason)}</p>
          </div>
        </div>
      ) : null}

      {detail.lifecycle.lastError ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3.5" role="alert">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-destructive">最近错误</div>
            <p className="td-body mt-1 whitespace-pre-wrap break-words text-foreground/85">{detail.lifecycle.lastError}</p>
          </div>
        </div>
      ) : null}

      {detail.verify.enabled ? (
        <section className="rounded-xl border border-border/60 p-4 md:p-5" aria-labelledby="task-verification-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="task-verification-heading" className="td-heading text-foreground">验收判据</h2>
            <span className={cn(
              'rounded-full border px-2 py-0.5 text-xs font-medium',
              detail.verify.lastVerdict === 'pass' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
              detail.verify.lastVerdict === 'fail' && 'border-destructive/30 bg-destructive/10 text-destructive',
              !detail.verify.lastVerdict && 'border-border/60 bg-foreground/5 text-muted-foreground',
            )}>{verificationLabel}</span>
          </div>
          {/*
            Deliberately not called 验收清单: that is the acceptance list above,
            which is a set of commands with pass/fail. This is one sentence a
            model reads to judge a handoff that no command can check — the two
            are different questions and used to look like a duplicate.
          */}
          <p className="mt-1 text-xs text-muted-foreground">
            一句话说明「什么算完成」。命令判定不了的部分，由模型拿它对照交接内容判断。
          </p>
          <p className="td-body mt-2 text-foreground/85">{detail.verify.requirement || '尚未设置验收要求。'}</p>
        </section>
      ) : null}

      <section aria-labelledby="task-handoff-heading">
        {/* The current session moved to the plan header — it names the work in progress, not
            the record of what already happened. This section only counts its entries. */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 id="task-handoff-heading" className="td-heading text-foreground">交接时间线</h2>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{detail.handoffs.length}</span>
          </div>
        </div>
        {detail.handoffs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 px-5 py-8 text-center">
            <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-foreground/5">
              <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-xs font-medium text-foreground">还没有交接记录</p>
            <p className="mt-1 text-xs text-muted-foreground">工蜂提交进展后，会显示在这里。</p>
          </div>
        ) : (
          <ol className="space-y-0">
            {detail.handoffs.map((handoff, index) => (
              <li key={`${handoff.at}-${index}`} className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0">
                {index < detail.handoffs.length - 1 ? (
                  <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border/70" aria-hidden="true" />
                ) : null}
                <span className={cn(
                  'relative z-10 mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border',
                  handoff.outcome === 'delivered' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                  handoff.outcome === 'handoff' && 'border-blue-500/30 bg-blue-500/10 text-blue-400',
                  handoff.outcome === 'needs_decision' && 'border-amber-500/30 bg-amber-500/10 text-amber-400',
                )}>
                  {handoff.outcome === 'delivered' ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {handoff.outcome === 'handoff' ? <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {handoff.outcome === 'needs_decision' ? <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                </span>
                <article className="min-w-0 rounded-xl border border-border/60 bg-foreground/[0.02] p-3.5 md:p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <time className="text-xs text-muted-foreground" dateTime={new Date(handoff.at).toISOString()}>{formatTimestamp(handoff.at)}</time>
                    <span className={cn(
                      'rounded-full border px-2 py-0.5 text-xs font-medium',
                      handoff.outcome === 'delivered' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                      handoff.outcome === 'handoff' && 'border-blue-500/30 bg-blue-500/10 text-blue-400',
                      handoff.outcome === 'needs_decision' && 'border-amber-500/30 bg-amber-500/10 text-amber-400',
                    )}>{HANDOFF_OUTCOME_LABEL[handoff.outcome]}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{handoff.fromSessionId}</span>
                  </div>
                  <p className="td-body whitespace-pre-wrap break-words text-foreground/90">{handoff.summary}</p>
                  {handoff.nextAction ? (
                    <div className="mt-3 flex items-start gap-2 rounded-md bg-foreground/[0.04] px-3 py-2">
                      <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <p className="text-xs leading-relaxed text-foreground/80"><span className="font-medium text-foreground">下一步</span> · {handoff.nextAction}</p>
                    </div>
                  ) : null}
                  {handoff.keyFindings && handoff.keyFindings.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">关键发现</h3>
                      <ul className="space-y-1">
                        {handoff.keyFindings.map((finding, findingIndex) => (
                          <li key={`${findingIndex}-${finding}`} className="flex items-start gap-2 text-xs leading-relaxed text-foreground/80">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" aria-hidden="true" />
                            <span className="min-w-0 break-words">{finding}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {handoff.artifacts && handoff.artifacts.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">产物</h3>
                      <ul className="space-y-1.5">
                        {handoff.artifacts.map((artifact, artifactIndex) => (
                          <li key={`${artifactIndex}-${artifact.path}`} className="flex min-w-0 items-start gap-2 text-xs">
                            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <div className="min-w-0">
                              <code className="block break-all font-mono text-xs text-foreground/85">{artifact.path}</code>
                              {artifact.note ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{artifact.note}</p> : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {handoff.verify ? (
                    <div className={cn(
                      'mt-3 rounded-md border p-3',
                      handoff.verify.passed ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-destructive/25 bg-destructive/5',
                    )}>
                      <div className="mb-2.5 flex items-center gap-2">
                        {handoff.verify.passed
                          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                          : <CircleAlert className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />}
                        <h3 className="text-xs font-semibold text-foreground">{handoff.verify.passed ? '验证通过' : '验证未通过'}</h3>
                      </div>
                      {handoff.verify.ran.length > 0 ? (
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">验证命令</div>
                          {handoff.verify.ran.map((command, commandIndex) => (
                            <code key={`${commandIndex}-${command}`} className="block break-all rounded bg-background/60 px-2 py-1 font-mono text-xs text-foreground/80">{command}</code>
                          ))}
                        </div>
                      ) : null}
                      {handoff.verify.note ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{handoff.verify.note}</p> : null}
                    </div>
                  ) : null}
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
        创建于 {formatTimestamp(detail.createdAt)}
      </p>
    </div>
  )
}

/**
 * The plan, one line per step: `1.0 ☑️ 接口改造 · agent-ui`.
 *
 * The mark comes before the text and is a real glyph, not a bordered box — a box
 * with an `x` in it reads as "wrong" at a glance, which is the opposite of what a
 * finished step means.
 *
 * Outlines are collapsible; sub-steps are not, because a sub-step has nothing
 * under it. On open, finished outlines are collapsed and the section being worked
 * on is expanded: the screen should show what is happening, not what happened.
 */
function PlanSection({
  plan,
  assignee,
  jumps,
  onJump,
  agents,
  currentSessionId,
  onOpenSession,
}: {
  plan?: { id: string; title: string; status: 'todo' | 'doing' | 'done' | 'blocked'; agent?: string; note?: string }[]
  assignee?: string
  jumps?: Map<string, PlanJumpTarget>
  onJump?: (target: PlanJumpTarget) => void
  /** Roster for owner names; see `agentLabelMap`. */
  agents?: ReadonlyArray<{ id: string; name: string }>
  /** The session currently carrying this task, shown in the heading's right corner. */
  currentSessionId?: string
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element {
  // Which outlines the user has folded. Seeded from the plan itself, then left
  // alone until the plan's shape changes — a toggle the user just made must not
  // be undone by the next render.
  const [folded, setFolded] = React.useState<Set<string>>(() => new Set())
  const shape = (plan ?? []).map((step) => `${step.id}:${step.status}`).join('|')
  const shapeRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (shapeRef.current === shape) return
    shapeRef.current = shape
    const steps = plan ?? []
    // Finished sections start collapsed; everything else stays open so the
    // current section (and what is queued behind it) is visible immediately.
    setFolded(new Set(steps.filter((step) => !step.id.includes('.') && step.status === 'done').map((step) => step.id)))
  }, [shape, plan])

  if (!plan || plan.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border/70 p-4 md:p-5" aria-labelledby="task-plan-heading">
        <h2 id="task-plan-heading" className="td-heading text-foreground">执行计划</h2>
        <p className="mt-1.5 text-xs text-muted-foreground">
          还没有计划。负责的会话会边做边用 task_plan 记下阶段，这里就会长出勾选清单。
        </p>
      </section>
    )
  }

  // Leaves only — the same rule `planProgress` uses, so a decomposed outline is
  // not counted alongside its children.
  const leaves = plan.filter((step) => !plan.some((other) => other.id.startsWith(`${step.id}.`)))
  const done = leaves.filter((step) => step.status === 'done').length
  // Resolved once per render: the roster lookup is a map build, not a scan per step.
  const labelOf = agentLabelMap(agents)
  const ownerOf = (step: { agent?: string }) => labelOf(step.agent ?? assignee)

  const childrenOf = (id: string) => plan.filter((step) => step.id.startsWith(`${id}.`))
  const toggle = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // A sub-step renders only when its section is open.
  /**
   * Plan order is by id path, not by insertion.
   *
   * Workers append in the order they discover things — the outline first, then one
   * sub-step per section as they get to it — so the stored array reads
   * `1, 2, 3, 4, 1.1, 2.1, 3.1, 4.1`. Rendering that verbatim put `1.1` under section
   * 4, which looks like the plan is structured wrong when it is only stored in a
   * different order than it reads.
   */
  const byPath = (a: string, b: string) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    const depth = Math.max(left.length, right.length)
    for (let i = 0; i < depth; i += 1) {
      // A missing segment means "the parent itself", which sorts before its children.
      const x = left[i] ?? -1
      const y = right[i] ?? -1
      if (x !== y) return x - y
    }
    return 0
  }

  const visible = [...plan]
    .sort((a, b) => byPath(a.id, b.id))
    .filter((step) => {
      const cut = step.id.lastIndexOf('.')
      if (cut < 0) return true
      return !folded.has(step.id.slice(0, cut))
    })

  return (
    <section className="rounded-xl border border-border/60 p-4 md:p-5" aria-labelledby="task-plan-heading">
      {/*
        * Progress sits inside the heading — "执行计划（4/4）" — instead of floating at the
        * far right as "4 / 4 已完成". The count belongs to the plan, not to the section's
        * corner, and at the far edge it read as a separate status chip. Now the right side
        * of this row is free for the one thing that actually changes: which session is
        * working on it.
        */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 id="task-plan-heading" className="td-heading text-foreground">
          执行计划<span className="ml-1 tabular-nums text-muted-foreground">（{done}/{leaves.length}）</span>
        </h2>
        {currentSessionId ? (
          <button
            type="button"
            onClick={() => onOpenSession?.(currentSessionId)}
            title="打开这个会话"
            className="truncate text-xs text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
          >
            当前会话 · {currentSessionId}
          </button>
        ) : null}
      </div>

      <ul className="space-y-0.5">
        {visible.map((step) => {
          const depth = step.id.split('.').length - 1
          const isOutline = depth === 0
          const kids = isOutline ? childrenOf(step.id) : []
          const isFolded = folded.has(step.id)
          const jump = jumps?.get(step.id)
          const canJump = Boolean(jump?.sessionId && onJump)
          const hint = isOutline ? '跳到这一节开始的地方' : '跳到这一步完成的地方'

          // Status is carried by an SVG mark, not an emoji: emoji render
          // differently on every platform, cannot be themed, and cannot be sized by
          // a design token. Colour reinforces the shape — it never carries the
          // meaning alone, so done stays distinguishable from blocked for anyone who
          // cannot separate the hues.
          const mark =
            step.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              : step.status === 'doing' ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" aria-hidden="true" />
              : step.status === 'blocked' ? <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
              : <Circle className="h-4 w-4 text-muted-foreground/40" aria-hidden="true" />

          return (
            <li
              key={step.id}
              className="td-row flex min-w-0 items-start gap-2"
              style={{ paddingLeft: depth * 16 }}
            >
              {isOutline && kids.length > 0 ? (
                <button
                  type="button"
                  onClick={() => toggle(step.id)}
                  aria-expanded={!isFolded}
                  aria-label={isFolded ? '展开这一节' : '折叠这一节'}
                  className="-ml-1 flex h-[1.55em] w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight
                    className={cn('h-3.5 w-3.5 transition-transform duration-200', !isFolded && 'rotate-90')}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <span className="h-[1.55em] w-5 shrink-0" aria-hidden="true" />
              )}

              <span className="min-w-0 flex-1">
                {/*
                  * `items-start`, and the mark gets a box exactly one line tall so it centres
                  * on that line. With `items-baseline` the icon had no text of its own, so its
                  * baseline was its bottom edge — it sat a couple of pixels below the words it
                  * belongs to. A wrapping title still keeps the mark on the first line.
                  */}
                <span className="flex min-w-0 items-start gap-x-2">
                  {/*
                    * Status mark, then "1. title" as one run of text, then the owner.
                    *
                    * The number is part of the same string as the title so the underline,
                    * the colour and the line wrap all cover "1. 创建 docs/e2e-a.md" as one
                    * item instead of three differently-toned pieces.
                    */}
                  <span className="flex h-[1.55em] w-4 shrink-0 items-center justify-center">{mark}</span>
                  {canJump ? (
                    <button
                      type="button"
                      title={`${step.id}. ${step.title} — ${hint}`}
                      onClick={() => onJump?.(jump!)}
                      className={cn(
                        'td-row min-w-0 flex-1 truncate rounded text-left underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isOutline ? 'font-medium' : 'font-normal',
                        step.status === 'done' ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {step.id}. {step.title}
                    </button>
                  ) : (
                    <span
                      title={`${step.id}. ${step.title}`}
                      className={cn(
                        'td-row min-w-0 flex-1 truncate',
                        isOutline ? 'font-medium' : 'font-normal',
                        step.status === 'done' ? 'text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {step.id}. {step.title}
                    </span>
                  )}
                  {/*
                    * Every step names its owner — outlines and sub-steps alike.
                    *
                    * This was deduplicated once, on the theory that repeating "默认" four
                    * times was noise. It is not: a plan is a list of assignments, and the
                    * owner is part of each entry. Hiding it on all but the first row made a
                    * step look unassigned when it was not, and the reader could not tell
                    * "same worker" from "no worker".
                    */}
                  {ownerOf(step) ? (
                    <span
                      title={ownerOf(step)}
                      className="td-row-sub max-w-[38%] shrink-0 truncate whitespace-nowrap text-muted-foreground"
                    >
                      — {ownerOf(step)}
                    </span>
                  ) : null}
                </span>
                {/*
                  * `note` is intentionally not rendered.
                  *
                  * The plan contract asks a worker to record in `note` what proves a step
                  * ("A step marked done should say in note what proves it"), so the field
                  * carries real evidence: command output, byte sizes, conclusions. But on
                  * screen it read as a wall of self-summaries, two rows for every one step
                  * and half of them restating the row above. The value of a note is in the
                  * record, for audit and for whoever picks the task up next, not in this
                  * layout. So the data stays untouched in the task file and is simply not
                  * drawn.
                  */}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function StatusBadge({ status }: { status: TaskStatus }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', STATUS_TONE[status])}>
      {STATUS_ICON[status]}
      {STATUS_LABEL[status]}
    </span>
  )
}

function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint: string
  tone?: 'default' | 'warning' | 'success' | 'danger'
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-foreground/[0.02] p-3.5">
      <div className="td-label text-muted-foreground">{label}</div>
      <div className={cn(
        'td-metric mt-2 truncate',
        tone === 'default' && 'text-foreground',
        tone === 'warning' && 'text-amber-400',
        tone === 'success' && 'text-emerald-400',
        tone === 'danger' && 'text-destructive',
      )}>{value}</div>
      <div className="td-meta mt-1 truncate text-muted-foreground">{hint}</div>
    </div>
  )
}
