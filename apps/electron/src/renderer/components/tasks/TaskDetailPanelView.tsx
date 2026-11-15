/**
 * Full-width task detail presentation for the content panel.
 * The task navigator stays compact and independent in the neighboring column.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { requestSessionJump } from '@/lib/session-jump'
import {
  readDecisionAnswer,
  rememberDecisionAnswer,
  subscribeDecisionAnswers,
} from '../app-shell/decision-answers'
import {
  AlertTriangle,
  ChevronRight,
  ChevronDown,
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

import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { planProgress } from '@craft-agent/shared/tasks/plan'
// The `cron` subpath, not the barrel: `@craft-agent/shared/tasks` re-exports the on-disk store, and
// pulling `node:fs` into the renderer took the whole window down once already.
import { describeCron } from '@craft-agent/shared/tasks/cron'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { agentLabelMap } from './agent-label'
import { pauseReasonLabel, statusLabel } from './TaskBoardPanel'
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

/**
 * When a question was asked, short enough for a card corner.
 *
 * Today shows the clock alone — the date is noise for something from this afternoon — and anything
 * older carries its date, because 「14:20」 by itself would be read as today by anyone looking at a
 * task that has been paused since yesterday. `formatTimestamp` is the unabbreviated form, used as the
 * tooltip so the full moment is always one hover away.
 */
function formatAskTime(ts: number): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return ''
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  const now = new Date()
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return time
  return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(at)} ${time}`
}

export interface TaskDetailPanelViewProps {
  detail: TaskDetailView
  onClose?: () => void
  onResume?: (id: string) => void
  onCancel?: (id: string) => void
  /** Start a run now (claims the task lock and spawns a worker). */
  onRun?: (id: string) => void
  /**
   * Answer a pending decision with words.
   *
   * A decision is a question for a person, so the reply has to travel as one: the text is
   * sent to the session that asked. Without this the card could only ever say yes or no.
   */
  /** `decisionId` names which open question the reply closes; a task can hold several. */
  onAnswer?: (id: string, text: string, decisionId?: string) => void | Promise<void>
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
  /**
   * Change what starts this task.
   *
   * `updateTaskTrigger` existed and had no caller: the page could show 「定时 · 0 9 * * *」 and
   * nothing could change it, so a scheduled task's schedule was only editable by editing files.
   * Manual / cron / event are the three the scheduler understands, and the editor offers exactly
   * those — a free-form JSON box would let the page save a trigger the loop silently ignores.
   */
  onUpdateTrigger?: (
    id: string,
    /** The whole list: a task may be scheduled and event-driven at the same time. */
    triggers: TaskTriggerValue[],
  ) => void | Promise<void>
}

/** Full-width task detail for the content panel, with an optional navigator back action. */
/** One rule on a task. The list may hold a cron rule and an event rule at once. */
type TaskTriggerValue =
  | { kind: 'manual' }
  | { kind: 'cron'; expr: string; timezone?: string; enabled: boolean }
  | { kind: 'event'; source: string; types?: string[]; enabled: boolean }

export function TaskDetailPanelView({ detail, onClose, onResume, onCancel, onRun, onAnswer, onOpenSession, planJumps, onJumpToStep, agents, onUpdateTrigger }: TaskDetailPanelViewProps): React.JSX.Element {
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
          // Remount per task: the trigger editor (and every other piece of local state) is a draft
          // about one task, and carrying it across a switch showed the previous task's expression
          // in the next task's editor.
          key={detail.id}
          detail={detail}
          onResume={onResume}
          onCancel={onCancel}
          onRun={onRun}
          // The card's answer callback has to reach the content component that draws it.
          // It did not: `onAnswer` stopped at this wrapper, so every option button and the
          // send button rendered with `disabled={!onAnswer}` — permanently dead, while
          // 「其他（自己输入）」 still opened its box because that button has no such guard.
          onAnswer={onAnswer}
          onOpenSession={onOpenSession}
          planJumps={planJumps}
          onJumpToStep={onJumpToStep}
          agents={agents}
          // Editing a trigger needs the same wrapper pass-through `onAnswer` needed: the field is
          // drawn in the content component, and a callback that stops at this wrapper renders the
          // control as absent.
          onUpdateTrigger={onUpdateTrigger}
        />
      </div>
    </div>
  )
}

/**
 * The answer controls for a pending decision.
 *
 * What this replaces: two fixed buttons — 「同意，继续跑」 and 「否，取消任务」 — shown whatever
 * had actually been asked. A question with three real answers (`1.2` only, `1.2`+`2`, or
 * stop) was answered by a yes/no that matched none of them, and the user's intent had to be
 * reconstructed from which of the two they pressed. The asker's own `options` are now the
 * buttons, and 「其他」 carries everything they did not think of.
 */
function TaskDecisionAnswer({
  detail,
  onApprove,
  onCancel,
  onAnswer,
}: {
  detail: TaskDetailView
  onApprove: () => void
  onCancel: () => void
  onAnswer?: (id: string, text: string, decisionId?: string) => void | Promise<void>
}): React.JSX.Element {
  const options = (detail.decision?.options ?? []).filter((o) => o.trim().length > 0)
  const [typing, setTyping] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const askedAt = detail.decision?.askedAt
  /** The question's own identity — see the note on `keyFor`; the timestamp is shared by a batch. */
  const decisionId = detail.decision?.id

  /**
   * The answer, from whichever record knows first.
   *
   * `decision.answer` is authoritative and survives a restart; the shared store covers
   * the window before the task is re-read AND the other surface — the conversation card
   * asks the same question, and answering it there must lock this one too.
   */
  const [sent, setSentState] = React.useState<string | null>(
    detail.decision?.answer?.text ?? readDecisionAnswer(detail.id, askedAt, decisionId),
  )
  React.useEffect(() => {
    // Another surface answered the same question: take its answer rather than offering
    // the buttons again. Keyed on the question, so a re-ask stays answerable.
    return subscribeDecisionAnswers(() => {
      const shared = readDecisionAnswer(detail.id, askedAt, decisionId)
      if (shared) setSentState(shared)
    })
  }, [detail.id, askedAt, decisionId])
  const setSent = (value: string) => {
    setSentState(value)
    rememberDecisionAnswer(detail.id, askedAt, value, decisionId)
  }

  /**
   * Announce the answer only once it has actually been delivered.
   *
   * This used to mark the card answered and then fire the send — so a delivery that
   * threw still left 「已回复」 on screen. The card told the person their answer had
   * arrived while nothing had left the machine, which is worse than an error: there is
   * nothing to retry because the UI says it is done.
   */
  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sent || !onAnswer) return
    setError(null)
    try {
      // `onAnswer` may be async; a rejection is reported rather than swallowed.
      void Promise.resolve(onAnswer(detail.id, trimmed, detail.decision?.id)).then(
        () => {
          setSent(trimmed)
          setTyping(false)
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (sent) {
    /**
     * Answered, but the card stays whole.
     *
     * It used to replace the options with a single line, so choosing 做 made 不做 vanish — and
     * with several questions on the page, the whole question could disappear on the next
     * refresh. What was on offer is part of what was decided: the chosen option is marked, the
     * rest stay visible and inert so the record reads the way it happened.
     */
    return (
      <div className="mt-2">
        {options.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {options.map((option) => {
              const chosen = sent === option
              return (
                <span
                  key={option}
                  aria-pressed={chosen}
                  className={
                    chosen
                      ? 'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-500/45 bg-amber-500/20 px-3 text-xs font-medium text-amber-100'
                      : 'inline-flex min-h-8 items-center rounded-md border border-border/50 px-3 text-xs text-muted-foreground/60'
                  }
                >
                  {chosen ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : null}
                  {option}
                </span>
              )
            })}
          </div>
        ) : null}
        <div className="mt-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-foreground/80">
          已回复：{sent}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {options.length > 0 ? (
          options.map((option) => (
            <button
              key={option}
              type="button"
              className="inline-flex min-h-8 items-center rounded-md bg-amber-500/20 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/30 disabled:opacity-40"
              disabled={!onAnswer}
              onClick={() => submit(option)}
            >
              {option}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-amber-500/20 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/30"
              onClick={onApprove}
            >
              同意，继续跑
            </button>
            <button
              type="button"
              className="inline-flex min-h-8 items-center rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={onCancel}
            >
              否，取消任务
            </button>
          </>
        )}
        {!typing ? (
          // Not a choice: it submits nothing and only opens the box, so the card can never
          // be answered by wording the asker invented.
          <button
            type="button"
            className="inline-flex min-h-8 items-center rounded-md border border-dashed border-amber-500/40 px-3 text-xs text-amber-200/70 transition-colors hover:border-solid hover:text-amber-200"
            onClick={() => setTyping(true)}
          >
            其他（自己输入）
          </button>
        ) : null}
      </div>

      {typing ? (
        <div className="mt-2">
          <textarea
            autoFocus
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(draft)
              }
            }}
            placeholder="写下你的答复，Enter 发送，Shift+Enter 换行"
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
          />
          {error ? (
            <p className="mt-1.5 text-[11px] text-destructive">发送失败：{error}</p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              disabled={!draft.trim() || !onAnswer}
              onClick={() => submit(draft)}
              className="rounded-md bg-amber-500/25 px-2.5 py-1 text-xs text-amber-100 disabled:opacity-40"
            >
              发送
            </button>
            <button
              type="button"
              onClick={() => {
                setTyping(false)
                setDraft('')
              }}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function TaskDetailContent({ detail, onResume, onCancel, onRun, onAnswer, onOpenSession, planJumps, onJumpToStep, agents, onUpdateTrigger }: TaskDetailPanelViewProps): React.JSX.Element {
  /**
   * The questions still waiting for an answer, in the order they were asked.
   *
   * Falls back to the single `decision` mirror for tasks written before the queue existed.
   */
  type QuestionEntry = {
    id?: string
    question?: string
    reason?: string
    options?: string[]
    askedAt?: number
    answer?: { text: string; at: number }
    resolvedAt?: number
  }
  const askedQuestions = ((detail.decisions?.length ? detail.decisions : detail.decision ? [detail.decision] : []) as QuestionEntry[])
    .filter((entry) => entry.question?.trim())
  const isClosed = (entry: QuestionEntry) => typeof entry.resolvedAt === 'number'
  const openQuestions = askedQuestions.filter((entry) => !isClosed(entry))
  /**
   * Answered questions stay on the page, after the open ones.
   *
   * They used to be filtered out the moment they were answered, so a task waiting on three
   * questions lost each card as the person worked down the list — including the answers they
   * had just given. The record keeps every question it ever asked (`decisions`, oldest first);
   * the page was the only thing dropping them. Answered entries move to the end so the ones
   * still needing a decision stay at the top, closest to where the reader is looking.
   */
  const closedQuestions = askedQuestions
    .filter(isClosed)
    .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
  const listedQuestions = [...openQuestions, ...closedQuestions]

  /**
   * Answered cards start folded.
   *
   * They are the record of what was decided and belong on the page — but once everything is
   * answered there is nothing to act on, and a task that asked six questions pushed its plan and
   * verdicts off the screen to show them. An open question always wins over the fold: a card asking
   * for a decision must never be collapsed away from the person who has to make it.
   *
   * Seeded rather than synced with an effect, so the initial state is the answer for this render —
   * an effect would flash the body open for one frame before folding it.
   */
  const [answersOpen, setAnswersOpen] = React.useState(openQuestions.length > 0)
  const answersCollapsed = openQuestions.length === 0 && !answersOpen


  const { t } = useTranslation()
  const isPaused = detail.status === 'paused'
  /**
   * No 「继续」 for a retry that is already on its way.
   *
   * `willRetry` comes from the same predicate the watchdog's retry rule uses; before it, the card
   * offered the button and the click was refused by the run gate with a sentence the page had never
   * shown. The button that cannot work is worse than no button.
   */
  const isStartable = (detail.status === 'backlog' || isPaused) && !detail.willRetry
  const trigger = detail.trigger
  /**
   * Every rule on the task, not just the mirrored one.
   *
   * The single `trigger` above is what the board prints; editing has to work on the list, or
   * saving from this page would silently drop the second rule (T-1 「每晚九点」 + 「github issue」).
   */
  const triggerList: TaskTriggerValue[] = (() => {
    const fromRecord = (detail as unknown as { triggers?: TaskTriggerValue[] }).triggers
    if (Array.isArray(fromRecord)) return fromRecord.filter((entry) => entry.kind !== 'manual')
    return trigger && trigger.kind !== 'manual' ? [trigger as TaskTriggerValue] : []
  })()
  const [editingTrigger, setEditingTrigger] = React.useState(false)
  /** Which entry the form is standing in for; -1 = adding a new rule. */
  const [editingIndex, setEditingIndex] = React.useState(-1)
  const [triggerKind, setTriggerKind] = React.useState<'manual' | 'cron' | 'event'>(
    trigger?.kind === 'cron' ? 'cron' : trigger?.kind === 'event' ? 'event' : 'manual',
  )
  const [cronExpr, setCronExpr] = React.useState<string>(
    trigger?.kind === 'cron' ? (trigger.expr ?? '') : '',
  )
  const [cronTimezone, setCronTimezone] = React.useState(
    trigger?.kind === 'cron' ? (trigger.timezone ?? '') : '',
  )
  const [eventSource, setEventSource] = React.useState<string>(
    trigger?.kind === 'event' ? (trigger.source ?? '') : '',
  )
  const [eventTypes, setEventTypes] = React.useState<string>(
    trigger?.kind === 'event' ? (trigger.types ?? []).join(', ') : '',
  )
  const [triggerError, setTriggerError] = React.useState<string | null>(null)
  const [triggerSaving, setTriggerSaving] = React.useState(false)
  /**
   * Whether the schedule runs at all.
   *
   * `enabled` was written `true` on every save, so the only way to stop a schedule was to delete
   * it or edit the JSON — the page could start a timer nobody could turn off. Manual has no switch:
   * it never fires by itself.
   */
  const [triggerEnabled, setTriggerEnabled] = React.useState<boolean>(
    detail.trigger?.enabled !== false,
  )
  const saveTrigger = async (): Promise<void> => {
    if (!onUpdateTrigger) return
    setTriggerError(null)
    const types = eventTypes
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (triggerKind === 'cron' && !cronExpr.trim()) {
      setTriggerError('定时触发需要一个 cron 表达式，例如 0 9 * * *')
      return
    }
    if (triggerKind === 'event' && !eventSource.trim()) {
      setTriggerError('事件触发需要一个来源，例如 git')
      return
    }
    setTriggerSaving(true)
    try {
      /**
       * The edited rule replaces the one being edited, and the others stay.
       *
       * The page used to send exactly one rule, so opening it on a two-rule task and pressing save
       * would have deleted the other one — a destructive edit nobody asked for. `editingIndex`
       * names which entry this form is standing in for; `-1` means 「add a rule」.
       */
      const edited =
        triggerKind === 'manual'
          ? null
          : triggerKind === 'cron'
            ? {
                kind: 'cron' as const,
                expr: cronExpr.trim(),
                ...(cronTimezone.trim() ? { timezone: cronTimezone.trim() } : {}),
                enabled: triggerEnabled,
              }
            : {
                kind: 'event' as const,
                source: eventSource.trim(),
                ...(types.length ? { types } : {}),
                enabled: triggerEnabled,
              }
      const rest = triggerList.filter((_, index) => index !== editingIndex)
      const next = edited ? [...rest, edited] : rest
      await onUpdateTrigger(detail.id, next)
      setEditingTrigger(false)
    } catch (error) {
      setTriggerError(error instanceof Error ? error.message : String(error))
    } finally {
      setTriggerSaving(false)
    }
  }
  const triggerOff = detail.trigger?.enabled === false && detail.trigger.kind !== 'manual'
  /** One rule, as a short fact: 「定时 · 0 9 * * *」 / 「事件 · github/issues」. */
  const describeRule = (rule: TaskTriggerValue): string => {
    if (rule.kind === 'cron') {
      const schedule = describeCron(rule.expr)
      /**
       * Words only — the expression adds nothing once the words are right.
       *
       * This label is plain text in a `<span>`, not Markdown, so any wrapper shows up literally: with
       * backticks it read 「每分钟（`* * * * *`）」, and without them 「每分钟（* * * * *）」 — either way five
       * asterisks sat next to the words that already said the same thing. The expression is still the
       * source of truth on the record; it is printed only when `describeCron` did not recognise the
       * shape, which is exactly when the words are missing.
       */
      const short = schedule === rule.expr ? rule.expr : schedule
      return `定时 · ${short}${rule.timezone ? ` (${rule.timezone})` : ''}${rule.enabled === false ? '（已停用）' : ''}`
    }
    if (rule.kind === 'event') {
      const types = rule.types?.length ? `/${rule.types.join(',')}` : ''
      return `事件 · ${rule.source}${types}${rule.enabled === false ? '（已停用）' : ''}`
    }
    return '手动'
  }
  /**
   * The whole picture on the meta line: 手动 when nothing fires it, otherwise every rule joined.
   *
   * A task can be scheduled and event-driven at once, and printing only the mirrored rule hid the
   * second one — the page then looked like the task had one way to start when it had two.
   */
  const triggerLabel = (triggerList.length ? triggerList.map(describeRule).join(' · ') : '手动') + (triggerOff ? '（已停用）' : '')
  // Placeholders hold the run lock before a session exists; they are not sessions.
  const realSessions = detail.sessionIds.filter((id) => !id.startsWith('pending:'))
  /**
   * The counter the budget speaks about, and the one a person can act on.
   *
   * `sessionIds` is the task's whole life — that is what deleting a task uses to take its
   * conversations with it, and a per-minute task adds one a minute. Printed next to `maxSessions` it
   * read as 「0 / 8」 on a task that had already used two, then 「9 / 8」 on one that was working
   * fine, because the budget now counts the round. `roundSessionIds` is cleared with the round.
   */
  const roundSessions = (detail.roundSessionIds ?? []).filter((id) => !id.startsWith('pending:'))
  /**
   * The timeline is a history of the task, not a log of attempts.
   *
   * Every `report_result` used to add a row, so one file produced seven entries:
   * six rejections of the same claim and one pass, all from the same session, with
   * nothing changed in six of them. Rows now appear when the task's state or its
   * executor changed. `milestone` is absent on hand-offs written before the field
   * existed, and those keep showing — hiding real history to tidy a list is worse
   * than a slightly long list.
   */
  const milestones = detail.handoffs.filter((handoff) => handoff.milestone !== false)
  const foldedAttempts = detail.handoffs.length - milestones.length
  /**
   * Which round the timeline is about.
   *
   * The array holds the round in progress, so 「第 N 轮」 is read off the entries rather than guessed
   * from the record's total — after a round closes the panel still shows that round until the next one
   * files its first report, and that is the round a person is asking about.
   */
  const timelineRound = [...detail.handoffs].reverse().find((handoff) => handoff.round)?.round
  // A hand-off names the session that produced it by id. An id is a storage key,
  // not something a person can match against the session list, so it is resolved to
  // the name the user sees — and falls back to the id when the session is gone,
  // because "who handed this off" must never render blank.
  const sessionMetas = useAtomValue(sessionMetaMapAtom)
  const sessionNameOf = React.useCallback(
    (id: string) => sessionMetas.get(id)?.name?.trim() || id,
    [sessionMetas],
  )
  // `activeMs` is the accumulated time actually spent running; the budget is the
  // ceiling and belongs in the hint, not in the value.
  const activeMinutes = Math.round(((detail.stats?.activeMs ?? 0) / 60_000))
  /**
   * Running, but nothing is working on it.
   *
   * The watchdog wakes an idle session after a few minutes, which means there is a
   * real window where the board says 进行中 and nothing is happening. Observed by the
   * user as "会话中止了，一直没恢复" — it had not recovered *yet*, and nothing on screen
   * said it was waiting. A silent wait reads as a hang.
   */
  const sessionMeta = detail.currentSessionId ? sessionMetas.get(detail.currentSessionId) : undefined
  const awaitingRecovery =
    detail.status === 'running' && Boolean(detail.currentSessionId) && sessionMeta?.isProcessing === false
  // Terminal-only acceptance (C2′): while the plan has open steps the verdict is
  // not decided yet — the judge runs only once the plan is complete. A task without
  // a plan has no intermediate states, so it keeps the plain labels.
  const planProgressView = planProgress(detail.spec?.plan)
  const planOpen = planProgressView.total > 0 && !planProgressView.complete
  const verificationLabel = planOpen
    ? '待终态判定'
    : detail.verify.lastVerdict === 'pass'
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
            <StatusBadge status={detail.status} pauseReason={detail.pauseReason} />
            {awaitingRecovery ? (
              <span
                className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400"
                title="执行会话已经停下，看门狗会在空闲几分钟后自动唤醒它继续；如果连续唤醒仍不推进，任务会被暂停"
              >
                等待恢复 · 会话已停下
              </span>
            ) : null}
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
            {onUpdateTrigger ? (
              <button
                type="button"
                className="rounded px-1 text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setEditingIndex(triggerList.length ? 0 : -1)
                  setEditingTrigger((open) => !open)
                }}
                aria-expanded={editingTrigger}
              >
                触发方式 {triggerLabel}
              </button>
            ) : (
              <span>触发方式 {triggerLabel}</span>
            )}
          </p>
          {editingTrigger && onUpdateTrigger ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-foreground/[0.03] p-3">
              {/*
                * Which rule this form is editing.
                *
                * Without this the page could only ever hold one rule: opening it on a two-rule task
                * and pressing save replaced the list with whatever the single form said. The strip
                * names the others so they are visibly still there, and 「再加一条」 starts a new one
                * instead of overwriting the first.
                */}
              {triggerList.length ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  {triggerList.map((rule, index) => (
                    <span
                      key={`${rule.kind}-${index}`}
                      className={
                        index === editingIndex
                          ? 'rounded-md border border-primary/60 bg-primary/15 px-2 py-0.5 text-[11px] text-foreground'
                          : 'rounded-md border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setEditingIndex(index)
                          setTriggerKind(rule.kind === 'cron' ? 'cron' : rule.kind === 'event' ? 'event' : 'cron')
                          setCronExpr(rule.kind === 'cron' ? rule.expr : '')
                          setCronTimezone(rule.kind === 'cron' ? (rule.timezone ?? '') : '')
                          setEventSource(rule.kind === 'event' ? rule.source : '')
                          setEventTypes(rule.kind === 'event' ? (rule.types ?? []).join(', ') : '')
                          setTriggerEnabled(rule.kind === 'manual' ? true : rule.enabled !== false)
                        }}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {describeRule(rule)}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${describeRule(rule)}`}
                        className="ml-1.5 text-muted-foreground hover:text-foreground"
                        onClick={() => void onUpdateTrigger(detail.id, triggerList.filter((_, i) => i !== index))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    className="rounded-md border border-dashed border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setEditingIndex(-1)
                      setTriggerKind('cron')
                      setCronExpr('')
                      setCronTimezone('')
                      setEventSource('')
                      setEventTypes('')
                      setTriggerEnabled(true)
                    }}
                  >
                    再加一条
                  </button>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ['manual', '手动'],
                    ['cron', '定时'],
                    ['event', '事件'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setTriggerKind(kind)}
                    className={
                      triggerKind === kind
                        ? 'rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1 text-xs font-medium text-foreground'
                        : 'rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {triggerKind === 'cron' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={cronExpr}
                    onChange={(event) => setCronExpr(event.target.value)}
                    placeholder="0 9 * * * （分 时 日 月 周）"
                    className="min-h-8 w-48 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="cron 表达式"
                  />
                  <input
                    value={cronTimezone}
                    onChange={(event) => setCronTimezone(event.target.value)}
                    placeholder="时区（可选，如 Asia/Shanghai）"
                    className="min-h-8 w-52 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="时区"
                  />
                </div>
              ) : null}
              {triggerKind === 'event' ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={eventSource}
                    onChange={(event) => setEventSource(event.target.value)}
                    placeholder="来源（如 git、qqmail-idle）"
                    className="min-h-8 w-44 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="事件来源"
                  />
                  <input
                    value={eventTypes}
                    onChange={(event) => setEventTypes(event.target.value)}
                    placeholder="事件类型（逗号分隔，可选）"
                    className="min-h-8 w-56 rounded-md border border-border/70 bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="事件类型"
                  />
                </div>
              ) : null}
              {triggerError ? <p className="mt-2 text-xs text-destructive">{triggerError}</p> : null}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={triggerSaving}
                  onClick={() => void saveTrigger()}
                  className="inline-flex min-h-8 items-center rounded-md border border-border/70 bg-foreground/5 px-3 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {triggerSaving ? '保存中…' : '保存触发方式'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingTrigger(false)
                    setTriggerError(null)
                  }}
                  className="inline-flex min-h-8 items-center rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5"
                >
                  取消
                </button>
                {triggerKind === 'manual' ? (
                  <span className="text-xs text-muted-foreground">只有手动或督导触发才启动</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTriggerEnabled((on) => !on)}
                    aria-pressed={triggerEnabled}
                    className={
                      triggerEnabled
                        ? 'inline-flex min-h-8 items-center rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-300'
                        : 'inline-flex min-h-8 items-center rounded-md border border-border/70 px-2.5 text-xs text-muted-foreground'
                    }
                  >
                    {triggerEnabled ? '已启用 · 点击停用' : '已停用 · 点击启用'}
                  </button>
                )}
              </div>
            </div>
          ) : null}
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

      {/*
        The question sits directly under the instruction, above the plan.

        It used to come after the plan, the contract and four metric cards, so on a task that was
        waiting for an answer the reader had to scroll past everything already decided to reach the
        one thing that needed them. This page is ordered by what a person can act on: what was
        asked, then what is planned, then the record of what happened.

        The card mirrors the conversation card — same words, same options, same moment. It used to
        build its own text from the rule that detected the situation, so it appeared at handoff time
        with a sentence nobody had asked, then changed underneath the reader once the relay put the
        real question in the conversation. Two renderings of one decision disagreeing about both
        content and timing. So it draws nothing until the relay has actually asked: `question` is
        written by `setDecisionWording` from the same payload the conversation card is built from.
        Before that the task is paused and waiting, which is what the banner below says.
      */}
      {
        listedQuestions.length ? (
          /**
           * Every question this task has asked: the open ones first, the answered ones after.
           *
           * Answered cards are not a leftover — they are the record of what the person decided,
           * and the reason the task is where it is. Hiding them made the page look as if the
           * questions had never existed, and left no way to check what had been agreed.
           */
          <section
            className={
              openQuestions.length
                ? 'rounded-xl border border-amber-500/35 bg-amber-500/8 p-4 md:p-5'
                : 'rounded-xl border border-border/60 bg-muted/20 p-4 md:p-5'
            }
            aria-labelledby="task-decision-heading"
          >
            <div className="flex items-start gap-3">
              {openQuestions.length ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <h2
                  id="task-decision-heading"
                  className={openQuestions.length ? 'text-xs font-semibold text-amber-300' : 'text-xs font-semibold text-foreground/70'}
                >
                  {openQuestions.length ? (
                    `等你拍板${openQuestions.length > 1 ? `（${openQuestions.length} 个问题）` : ''}`
                  ) : (
                    /**
                     * The heading is the fold control once nothing is owed.
                     *
                     * A separate 「展开」 button beside a heading that already names the thing is two
                     * controls for one action; the title is the obvious target and the chevron says
                     * which way it goes.
                     */
                    <button
                      type="button"
                      onClick={() => setAnswersOpen((open) => !open)}
                      aria-expanded={!answersCollapsed}
                      aria-controls="task-decision-body"
                      className="inline-flex items-center gap-1 text-left transition-colors hover:text-foreground"
                    >
                      {answersCollapsed ? (
                        <ChevronRight className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3 w-3" aria-hidden="true" />
                      )}
                      已答复
                      {closedQuestions.length > 1 ? `（${closedQuestions.length} 个问题）` : ''}
                    </button>
                  )}
                </h2>
                {openQuestions.length > 1 ? (
                  <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
                    全部答完才会一起交给督导，中途回答不会打断它。
                  </p>
                ) : null}
                <div id="task-decision-body" hidden={answersCollapsed} className="mt-2 space-y-3">
                  {listedQuestions.map((entry, index) => (
                    <div
                      key={entry.id ?? `${entry.askedAt}-${index}`}
                      className={`rounded-lg bg-background/40 p-3${isClosed(entry) ? ' opacity-90' : ''}`}
                    >
                      <div className="flex items-start gap-2">
                        <p className="td-body min-w-0 flex-1 whitespace-pre-wrap text-foreground/90">{entry.question}</p>
                        {/*
                          * When this question was asked, in the corner of the question itself.
                          *
                          * A task can sit here for hours behind a fuse or a spent budget, and 「这个问句
                          * 是什么时候的」 is what tells the reader whether the situation it describes is
                          * still the current one. Shown per question because a task can be holding
                          * several, asked at different times.
                          */}
                        {entry.askedAt ? (
                          <span
                            className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                            title={formatTimestamp(entry.askedAt)}
                          >
                            {formatAskTime(entry.askedAt)}
                          </span>
                        ) : null}
                      </div>
                      {/* The rule's diagnosis stays as a footnote: same question as the card in
                          the conversation, plus why a person is being asked at all. */}
                      {entry.reason?.trim() ? (
                        <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                          {entry.reason}
                        </p>
                      ) : null}
                      <TaskDecisionAnswer
                        detail={{ ...detail, decision: entry }}
                        onApprove={() => (onRun ?? onResume)?.(detail.id)}
                        onCancel={() => onCancel?.(detail.id)}
                        onAnswer={onAnswer}
                      />
                    </div>
                  ))}
                </div>
                {openQuestions.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-amber-500/40 px-2.5 py-1 text-[11.5px] text-amber-200 hover:bg-amber-500/10"
                      onClick={() => onCancel?.(detail.id)}
                    >
                      结束任务
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : detail.pauseReason === 'needs_decision' || detail.pauseReason === 'asking' ? (
          /**
           * Nothing has been asked yet — so say that, and say it does not need the reader.
           *
           * The old line was 「等待督导把问题转达给你，稍后会上来这里」. True, but it left the person
           * unsure whether they were supposed to sit and watch. The state is unambiguous from the
           * record: the task is paused for a question, and no question exists yet. That is
           * 「督导正在整理要问你的内容」 — the only thing to do is go and do something else, and this
           * page will change by itself when the question lands.
           */
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 p-3.5" role="status">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground/80">等问句</div>
              <p className="td-body mt-1 text-foreground/85">
                督导正在整理要问你的内容，暂时不用你操作。问题写好后会出现在这里，也会出现在会话里。
              </p>
            </div>
          </div>
        ) : null}

      {/*
        * Above the plan, because a stop is what the reader needs first: why nothing is moving
        * decides whether the plan below is worth reading at all. It used to sit under the whole
        * plan and the contract, so a paused task's reason was below the fold.
        *
        * Only reasons that have no notice of their own: `needs_decision` draws the ask card and
        * `asking` draws 「等问句」 — repeating them here put one state on screen twice.
        */}
      {detail.pauseReason && detail.pauseReason !== 'needs_decision' && detail.pauseReason !== 'asking' ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 p-3.5" role="status">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-amber-300">暂停原因</div>
            <p className="td-body mt-1 text-foreground/85">{pauseReasonLabel(detail.pauseReason)}</p>
            {detail.willRetry ? (
              <p className="td-meta mt-1 text-amber-300/90">
                巡检会自动重试一次，不需要手动继续；再失败会停下来等你决定。
              </p>
            ) : null}
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

      <PlanSection
        plan={detail.spec?.plan}
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
          label="本轮会话"
          value={`${roundSessions.length} / ${detail.budget.maxSessions}`}
          hint="本轮已用 / 单轮上限"
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
            hint={planOpen ? '任务完成后统一验收' : `迭代上限 ${detail.verify.maxIterations}`}
            tone={planOpen ? 'default' : detail.verify.lastVerdict === 'pass' ? 'success' : detail.verify.lastVerdict === 'fail' ? 'danger' : 'default'}
          />
        ) : null}
      </section>


      {/*
        * The task's conversations, under the numbers that count them.
        *
        * 「本轮会话 3 / 8」 says how many without saying which ones — opening them meant leaving the
        * task page and searching a flat list for names that all look alike. Each row says what the
        * conversation did and opens it.
        *
        * Faithful to the record rather than tidy: archived rows are shown as archived, and the
        * acceptance conversation appears once because the task reuses it for every hand-off.
        */}
      {detail.sessions?.length ? (
        <section className="rounded-xl border border-border/60 p-4 md:p-5" aria-labelledby="task-sessions-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="task-sessions-heading" className="text-sm font-semibold text-foreground">会话</h2>
            <span className="td-meta text-muted-foreground">{detail.sessions.length} 个</span>
          </div>
          <ul className="flex flex-col gap-1">
            {detail.sessions.map((session) => (
              <li key={session.id} className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                    session.purpose === 'verify'
                      ? 'border-violet-500/30 bg-violet-500/10 text-violet-400'
                      : session.purpose === 'section'
                        ? 'border-border/60 bg-foreground/5 text-muted-foreground'
                        : 'border-blue-500/30 bg-blue-500/10 text-blue-400',
                  )}
                >
                  {session.purpose === 'verify' ? '验收' : session.purpose === 'section' ? '分工' : 'worker'}
                </span>
                <button
                  type="button"
                  onClick={() => requestSessionJump({ sessionId: session.id, at: 0 })}
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[13px] hover:underline',
                    session.archived ? 'text-muted-foreground' : 'text-foreground',
                  )}
                  title={session.id}
                >
                  {session.name}
                </button>
                {session.archived ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">已归档</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.verify.enabled ? (
        <section className="rounded-xl border border-border/60 p-4 md:p-5" aria-labelledby="task-verification-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="task-verification-heading" className="td-heading text-foreground">验收判据</h2>
            <span className={cn(
              'rounded-full border px-2 py-0.5 text-xs font-medium',
              !planOpen && detail.verify.lastVerdict === 'pass' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
              !planOpen && detail.verify.lastVerdict === 'fail' && 'border-destructive/30 bg-destructive/10 text-destructive',
              (planOpen || !detail.verify.lastVerdict) && 'border-border/60 bg-foreground/5 text-muted-foreground',
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
            {timelineRound ? (
              <span className="text-xs tabular-nums text-muted-foreground">第 {timelineRound} 轮</span>
            ) : null}
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{milestones.length}</span>
          </div>
        </div>
        {milestones.length === 0 && detail.handoffs.length > 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 px-5 py-6 text-center text-xs text-muted-foreground">
            还没有改变过执行者或状态。{detail.handoffs.length} 次过程记录只留在任务日志里。
          </div>
        ) : null}
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
            {milestones.map((handoff, index) => (
              <li key={`${handoff.at}-${index}`} className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0">
                {index < milestones.length - 1 ? (
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
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={handoff.fromSessionId}
                    >
                      {sessionNameOf(handoff.fromSessionId)}
                    </span>
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
        {foldedAttempts > 0 ? (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
            另有 {foldedAttempts} 次过程记录（被拒的交接、未改变执行者的进度汇报）保留在任务日志里，未在这里显示。
          </p>
        ) : null}
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
  jumps,
  onJump,
  agents,
  currentSessionId,
  onOpenSession,
}: {
  plan?: { id: string; title: string; status: 'todo' | 'doing' | 'done' | 'blocked'; agent?: string; note?: string }[]
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
  /**
   * Who does this step, read straight off the record.
   *
   * No fallbacks. A sub-step cannot be written without an `agent` — `applyPlanPatch` refuses one,
   * and so do `task_create` and `updateSpec` — so an empty field means the plan predates that rule,
   * and the honest way to show it is to show nothing. Filling the gap with the task's assignee, or
   * with the only profile in the workspace, made legacy plans look assigned and removed the one
   * visible sign that the choice was never made.
   */
  const ownerOf = (step: { agent?: string }) => labelOf(step.agent)

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
                /**
                 * Same box as the chevron, including `-ml-1`.
                 *
                 * The two are the first thing in the row, so they decide where every row starts.
                 * Without the negative margin here, a section with sub-steps began 4px left of one
                 * without — 「执行计划」 showed 「1. 写文件」 and 「2. 收尾」 off by the width of a
                 * chevron, which reads as a nesting mistake rather than a leaf.
                 */
                <span className="-ml-1 h-[1.55em] w-5 shrink-0" aria-hidden="true" />
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
                        /**
                         * `min-w-0` without `flex-1`, so the text keeps its natural width and the
                         * owner sits right after it. `flex-1` stretched the title to the end of the
                         * row and pushed 「— 默认」 to the far edge, where it read as a column of its
                         * own instead of part of the line it describes. The title still truncates
                         * when the row runs out of room: it shrinks, the owner does not (`shrink-0`).
                         */
                        'td-row min-w-0 truncate rounded text-left underline decoration-border underline-offset-2 transition-colors hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
                        'td-row min-w-0 truncate',
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
                      data-owner={step.id}
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

function StatusBadge({ status, pauseReason }: { status: TaskStatus; pauseReason?: string | null }): React.JSX.Element {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', STATUS_TONE[status])}>
      {STATUS_ICON[status]}
      {statusLabel(status, pauseReason)}
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
