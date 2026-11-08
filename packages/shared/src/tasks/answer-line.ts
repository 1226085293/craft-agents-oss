/**
 * The line a person's reply is delivered as.
 *
 * One function because it was composed inline at the delivery site, and that is the shape
 * every one of these bugs has had: the same intent written twice, differing in the details
 * that matter. The reply has to name its task — with two tasks waiting, 「放行」 closes
 * whichever decision is read first — and it has to say what is left, so the supervisor does
 * not have to re-read the plan to know what the answer applies to.
 */
import type { Task } from './types.ts';

export function formatDecisionAnswerLine(task: Task, text: string): string {
  const answer = text.trim();
  const remaining = (task.spec?.plan ?? []).filter((step) => step.status !== 'done');
  return (
    `〔任务 ${task.id} 拍板答复〕${answer}` +
    (remaining.length
      ? `\n（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）`
      : '')
  );
}
