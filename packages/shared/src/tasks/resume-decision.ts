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
 * and write it down through `task_update` as `directive`. This function only compares timestamps:
 * has anyone written an instruction since that reply arrived?
 *
 * If not, the task does NOT resume. Silence is not permission, and a guess about what somebody
 * authorised is worse than an explicit wait.
 */
import type { Task } from './types.ts';

export type ResumeVerdict =
  | { allowed: true; /** The supervisor's reading of the reply, verbatim. */ directive?: string; reason: string }
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
  // unanswered 「等你拍板」 a real stop rather than a label. The queue is scanned rather
  // than only the mirror: the mirror is re-derived on save, and a record that missed
  // that pass must not lose this guard.
  const openQuestion = (
    task.decisions?.length ? task.decisions : decision ? [decision] : []
  ).find((entry) => !entry.resolvedAt);
  if (openQuestion || (decision && !decision.resolvedAt && !answer)) {
    return {
      allowed: false,
      why: `任务在等你拍板（${openQuestion?.label ?? decision?.label ?? '未回答的问题'}），先回答才能继续`,
    };
  }

  if (answer) {
    /**
     * The reply is recorded; what it *means* has to be written down by someone who can read it.
     *
     * `directive.at` is stamped by the tool that records the instruction. Comparing it to when the
     * reply arrived answers "has this reply been acted on?" without reading a single character of
     * it. A supervisor that decides 「只剩收尾」 writes that sentence as the directive; one that
     * decides 「停止」 sets the task to `canceled` and never resumes it; one that decides "nothing
     * changes" writes nothing and the task stays paused.
     *
     * Observed: without this, the reply 「停止剩下的任务」 lifted the pause, the worker was
     * resumed with the whole remaining plan, and the brief under the answer asked it to expand
     * the next outline.
     */
    const answeredAt = decision?.answer?.at ?? 0;
    const directive = task.spec?.directive;
    if (!directive || directive.at <= answeredAt) {
      return {
        allowed: false,
        why:
          `你已回复「${answer}」，但还没有人把这句话翻译成指令。` +
          '先由督导用 `task_update` 写下 `directive`（把这句话的意思写成一句话，例如「只做登录修复，其余不动」），' +
          '或者直接把任务结束掉：答复本身不等于放行，代码也不猜它的意思。',
      };
    }
  }

  /**
   * Some question is closed, and nobody answered it.
   *
   * `resolveDecision('obsolete')` closes a question when a scope write moves the boundary past
   * it — and before this branch existed, that state fell through to the final `allowed: true`
   * below. The whole chain then ran on nobody: the supervisor asked the user, wrote its own
   * directive, wrote a scope that closed its own question as obsolete, and resumed — the
   * record never heard from a person, and every guard read it as settled. Observed live on
   * T-1: 「用户拍板放行大纲 2」 was displayed with no answer anywhere in the journal.
   *
   * The whole queue is scanned, not just the mirror: a task can hold several questions, and
   * answering one is not answering the rest. A second question the supervisor closes for
   * itself must not ride the first question's answer.
   *
   * Unlocking needs both halves of the real chain for the *latest* such question: the person
   * spoke after it was asked (on any channel — an answer to that very question goes through
   * the branch above instead, so this is a relay / follow-up), and the supervisor turned
   * those words into a directive newer than that contact. Silence is not permission.
   */
  const closedWithoutAnswer = (
    task.decisions?.length ? task.decisions : decision ? [decision] : []
  ).filter((entry) => entry.resolvedAt && !entry.answer?.text?.trim());
  if (closedWithoutAnswer.length) {
    const latestAskedAt = Math.max(...closedWithoutAnswer.map((entry) => entry.askedAt));
    if ((task.humanAuthAt ?? 0) <= latestAskedAt) {
      return {
        allowed: false,
        why:
          '有被关闭的问题没有任何人回答过。' +
          '不能自己关闭问题再自己放行：先等用户的话（拍板答复或新的要求），' +
          '再把那些话用 `task_update` 写成 `directive`，然后才能继续。',
      };
    }
    const directive = task.spec?.directive;
    if (!directive || directive.at <= (task.humanAuthAt ?? 0)) {
      return {
        allowed: false,
        why:
          '用户在这之后说过话，但还没有人把那些话翻译成指令。' +
          '先由督导用 `task_update` 写下 `directive`（把用户的话写成一句边界，例如「只做登录修复，其余不动」），' +
          '或者直接把任务结束掉：说了话不等于放行，代码也不猜它的意思。',
      };
    }
  }

  /**
   * Both chains passed — or only the applicable one did. The two verdicts are read together,
   * not first-match: an answered question must not carry a sibling question the supervisor
   * closed for itself.
   */
  if (answer) {
    const directive = task.spec?.directive;
    return {
      allowed: true,
      directive: directive?.text,
      reason: `已按你的答复放行：${directive?.text ?? ''}`,
    };
  }
  if (closedWithoutAnswer.length) {
    const directive = task.spec?.directive;
    return {
      allowed: true,
      directive: directive?.text,
      reason: `已按用户的新话放行：${directive?.text ?? ''}`,
    };
  }

  return { allowed: true, reason: '没有待回答的问题' };
}
