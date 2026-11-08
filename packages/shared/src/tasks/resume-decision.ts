/**
 * Whether a task may resume, and inside which boundary.
 *
 * This exists because the same decision was being made in four places — a manual run, a
 * supervisor `task_update({status:'running'})`, an event route, and the watchdog — each
 * with its own idea of what an answered question means. The question is answered once, here,
 * as a pure function of what the task records.
 *
 * **What decides the meaning of an answer: a model, not this file.**
 *
 * This module used to read the person's reply with keyword tables — 「暂停/停止/放行/其余」 — to
 * work out what they had authorised. That cannot work: the same intent is phrased countless ways
 * (「停止剩下的任务」, 「到此为止」, 「别做了」), a word can mean its opposite depending on context
 * (「其余」 in 「其余之后再定」 excludes, in 「其余都做」 includes), and every miss was silent. Two
 * live failures came from it: 「完成1.2后暂停」 was understood but 「放行步骤 2」 was not, and
 * 「停止剩下的任务」 was read as an instruction to keep going.
 *
 * Interpreting language is the supervisor's job — it is a model, and it can say what it understood
 * and write it down through `task_update` (`authorizedUpTo` / `authorizedSteps`). This function
 * only compares timestamps: has anyone written an authorisation since that reply arrived?
 *
 * If not, the task does NOT resume. Silence is not permission, and a guess about what somebody
 * authorised is worse than an explicit wait.
 */
import type { Task } from './types.ts';

export type ResumeVerdict =
  | { allowed: true; authorizedSteps?: string[]; authorizedUpTo?: string; reason: string }
  | { allowed: false; why: string };

/**
 * The single answer to "may this run, and how far".
 *
 * Deliberately reads only the task: no session state, no caller identity. A rule that
 * depends on who is asking is a rule that behaves differently per entry point, which is
 * the defect this replaces.
 */
export function resumeDecisionFor(task: Task): ResumeVerdict {
  const decision = task.decision;
  const answer = decision?.answer?.text?.trim();

  // A question still open: nobody may start it. This is the guard that makes an
  // unanswered 「等你拍板」 a real stop rather than a label.
  if (decision && !decision.resolvedAt && !answer) {
    return { allowed: false, why: `任务在等你拍板（${decision.label}），先回答才能继续` };
  }

  if (answer) {
    /**
     * The reply is recorded; what it *means* has to be written down by someone who can read it.
     *
     * `authorizedAt` is stamped by the tool that writes a boundary. Comparing it to when the
     * reply arrived answers "has this reply been acted on?" without reading a single character
     * of it. A supervisor that decides 「放行到 2」 writes `authorizedUpTo: '2'`; one that
     * decides 「停止」 sets the task to `canceled` and never resumes it; one that decides
     * "nothing changes" writes nothing and the task stays paused.
     *
     * Observed: without this, the reply 「停止剩下的任务」 lifted the pause, the worker was
     * resumed with the whole remaining plan, and the brief under the answer asked it to expand
     * the next outline.
     */
    const answeredAt = decision?.answer?.at ?? 0;
    const authorizedAt = task.spec?.authorizedAt ?? 0;
    if (authorizedAt < answeredAt) {
      return {
        allowed: false,
        why:
          `你已回复「${answer}」，但还没有人把这句话翻译成授权。` +
          '先由督导用 `task_update` 写下授权（authorizedUpTo / authorizedSteps，或直接结束任务）：' +
          '答复本身不等于放行，代码也不猜它的意思。',
      };
    }
    const boundary = task.spec?.authorizedSteps;
    const ceiling = task.spec?.authorizedUpTo;
    return {
      allowed: true,
      ...(boundary?.length ? { authorizedSteps: boundary } : {}),
      ...(ceiling ? { authorizedUpTo: ceiling } : {}),
      reason: ceiling
        ? `已按你的答复授权到 ${ceiling}`
        : boundary?.length
          ? `已按你的答复授权到 ${boundary.join('、')}`
          : '已按你的答复放行，没有边界',
    };
  }

  return { allowed: true, reason: '没有待回答的问题' };
}
