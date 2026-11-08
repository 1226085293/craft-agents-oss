/**
 * Whether a task may resume, and inside which boundary.
 *
 * This exists because the same decision was being made in four places — a manual run, a
 * supervisor `task_update({status:'running'})`, an event route, and the watchdog — each
 * with its own idea of what an answered question means. The symptom was consistent and
 * wrong: the person answered 「完成 1.2 后暂停」, one path lifted the pause, another resumed
 * the worker with the whole remaining plan, and the task was finished past the boundary it
 * had just been given.
 *
 * So the question is answered once, here, as a pure function of the task: given what the
 * task records, may anyone start it, and what may they do when they do.
 */
import type { Task } from './types.ts';
import { authorizedStepsFromAnswer } from './answer-scope.ts';

export type ResumeVerdict =
  | { allowed: true; authorizedSteps?: string[]; reason: string }
  | { allowed: false; why: string };

/** Replies that end the task rather than continue it. */
const END_WORDS = /(到此为止|就此结束|结束任务|不用做了|别做了|取消任务|停掉任务)/;

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
    // The reply can end the task outright — 「到此为止」 is a decision, not a delay.
    if (END_WORDS.test(answer)) {
      return { allowed: false, why: `你已回复「${answer}」，任务应结束，不应继续执行` };
    }
    /**
     * A reply that names where to stop sets the boundary for whoever runs next.
     *
     * This is the half that was missing: the boundary was derived and stored in one place
     * (`recordDecisionAnswer`) but the resume paths read `spec.authorizedSteps`, and a task
     * whose boundary had not been stored — because the plan did not yet contain the named
     * step, which is exactly the state 「完成 1.2 后暂停」 is answered in — resumed with the
     * entire plan open.
     */
    const derived = authorizedStepsFromAnswer(answer, task.spec?.plan);
    const stored = task.spec?.authorizedSteps;
    const boundary = derived?.length ? derived : stored?.length ? stored : undefined;
    return {
      allowed: true,
      ...(boundary ? { authorizedSteps: boundary } : {}),
      reason: boundary ? `已授权到 ${boundary.join('、')}，做到这里就停` : '没有边界，按计划继续',
    };
  }

  return { allowed: true, reason: '没有待回答的问题' };
}
