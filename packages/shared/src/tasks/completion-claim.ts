/**
 * 「完成」 is a claim about the plan, so the plan gets to answer it.
 *
 * The record already refuses to be marked `completed` while steps are open (`assertPlanSettled`),
 * but that guard only covers status writes. A supervisor can say 「做完了」 to the person without
 * touching the status at all — `ask_user` with `kind: completed` — and then the sentence and the
 * file disagree, which is the disagreement the separation of 完成 and 停止 exists to prevent.
 *
 * Observed live, twice in one hour on 2026-11-13:
 *   - six seconds after a task was created (plan written, first step queued), the user lane sent
 *     `kind: completed` 「任务 T-1「分工验证」已建，3 条大纲及各自负责人已写入，系统正在分析范围并派活」 —
 *     a message that reads 「done」 about something that had just started;
 *   - the task lane's own rule then had to say, in prose, that `completed` means the end.
 *
 * Prose was the only rule before this, and prose is what the model re-reads after it has already
 * decided. The plan is on the record, so the claim is checkable in the same turn: refuse it, name
 * what is left, and let the model reword instead of the person being told the wrong thing.
 *
 * `openSteps` is the same predicate `assertPlanSettled` uses — one definition of 「计划做完了」.
 */

import { openSteps } from './plan.ts'
import type { Task } from './types.ts'

/**
 * Why a `completed` message cannot be sent about this task, or `null` when it can.
 *
 * `undefined` (no task named, or unknown id) is allowed: the guard is about a claim the record can
 * check, and with no record there is nothing to check it against.
 */
export function completedClaimRefusal(task: Task | undefined): string | null {
  if (!task) return null
  const open = openSteps(task.spec?.plan)
  if (open.length === 0) return null
  return (
    `${task.id} 的计划还有 ${open.length} 步没完成（${open.map((step) => step.id).join('、')}），` +
    '不能报 `completed`——这个 kind 的意思是「任务已经结束、这是最终答复」。' +
    '开工、派活、单个小节完成都不需要通知用户；等他需要拍板时用 `decision`，' +
    '真卡住且必须有人动手时用 `blocked`，整个计划做完才用 `completed`。'
  )
}
