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
import { openSteps } from './plan.ts';

export function formatDecisionAnswerLine(task: Task, text: string): string {
  const answer = text.trim();
  const remaining = openSteps(task.spec?.plan);
  return (
    `〔任务 ${task.id} 拍板答复〕${answer}` +
    (remaining.length
      ? `\n（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）`
      : '')
  );
}

/**
 * The message that carries several answers at once.
 *
 * Questions accumulate and answers are held until nothing is open, so the supervisor is interrupted
 * once instead of once per question — and, more importantly, it reads the state after the person has
 * finished thinking rather than acting on the first reply while a second card is still on screen.
 *
 * Each answer names the question it closes: a bare 「放行」 beside two open questions says nothing
 * about which one it releases.
 */
export function formatDecisionAnswersLine(
  task: Task,
  answered: Array<{ question?: string; answer?: { text: string } }>,
): string {
  const remaining = openSteps(task.spec?.plan);
  const lines = answered
    .map((entry) => {
      const asked = entry.question?.trim();
      const said = entry.answer?.text?.trim() ?? '';
      return asked ? `· ${asked}\n  → ${said}` : `· ${said}`;
    })
    .join('\n');
  return (
    `〔任务 ${task.id} 拍板答复〕\n${lines}` +
    (remaining.length
      ? `\n（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）`
      : '')
  );
}
