/**
 * The line a person's reply is delivered as.
 *
 * One function because it was composed inline at the delivery site, and that is the shape
 * every one of these bugs has had: the same intent written twice, differing in the details
 * that matter. The reply has to name its task — with two tasks waiting, 「放行」 closes
 * whichever decision is read first — and it has to say what is left, so the supervisor does
 * not have to re-read the plan to know what the answer applies to.
 *
 * The header is the shared `formatSupervisorMessage` block: 消息来源 says this IS the
 * person's words, and 效力 says what those words can unlock — a directive written from
 * them, nothing more. That sentence exists because the lane once displayed 「用户拍板放行」
 * with no answer anywhere in the record; the answer is not the authorisation, the
 * directive written from it is.
 */
import type { Task } from './types.ts';
import { openSteps } from './plan.ts';
import { formatSupervisorMessage } from './supervisor-message.ts';

export function formatDecisionAnswerLine(task: Task, text: string): string {
  const answer = text.trim();
  const remaining = openSteps(task.spec?.plan);
  return formatSupervisorMessage(
    {
      source: '用户（任务卡拍板）',
      type: '拍板答复',
      taskId: task.id,
      effect: '这是用户本人的话，是本任务唯一的新授权来源。放行后续步骤前，先用 task_update 把这句话翻译成 directive。',
    },
    answer +
      (remaining.length
        ? `\n（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）`
        : ''),
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
  return formatSupervisorMessage(
    {
      source: '用户（任务卡拍板）',
      type: '拍板答复',
      taskId: task.id,
      effect: '这些是用户本人的话，是本任务唯一的新授权来源。放行后续步骤前，先用 task_update 把话翻译成 directive。',
    },
    lines +
      (remaining.length
        ? `\n（该任务当前未完成步骤：${remaining.map((step) => step.id).join('、')}）`
        : ''),
  );
}
