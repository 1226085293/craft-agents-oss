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
import { authorizationFromAnswer } from './answer-scope.ts';

export type ResumeVerdict =
  | { allowed: true; authorizedSteps?: string[]; authorizedUpTo?: string; reason: string }
  | { allowed: false; why: string };

/**
 * Replies that end the task rather than continue it.
 *
 * 「停止剩下的任务」 was missing, and it is the phrasing that actually arrived: the supervisor
 * read it correctly (marked the task completed and created a different task for the new request),
 * but this function did not, so the resume path lifted the pause and handed the worker a brief
 * ending with 「下一条大纲 2 还没有小节……先判断它，再拆」 — instructions to continue, printed
 * directly under the reply that said to stop. The worker followed the longer, more specific
 * instruction, which is the only thing a model can reasonably do with contradictory input.
 */
const END_WORDS =
  /(到此为止|就此结束|结束任务|不用做了|别做了|取消任务|停掉任务|停止[^，。]{0,6}(任务|工作|剩余|剩下)|停掉剩余|不要再做)/;

/**
 * Does this reply end the task instead of continuing it?
 *
 * Exported because the brief needs the same answer: a resume that is refused produces no brief,
 * but a dispatch can still be built for a task whose reply said stop, and a brief that ends with
 * 「下一条大纲 2 ……先判断它，再拆」 contradicts the sentence it quotes two lines above.
 */
export function answerEndsTask(answer: string | undefined): boolean {
  return END_WORDS.test((answer ?? '').trim());
}

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
    /**
     * The same function the recorder used, so the resume cannot read the answer differently.
     *
     * `recordDecisionAnswer` stores what a reply authorises; this only decides whether the task
     * may run and along what boundary. When the two disagreed, a release answer was applied to
     * the record but not to the run — the task resumed bounded by the previous answer's ceiling.
     */
    const read = authorizationFromAnswer(answer, task.spec?.plan);
    const ceiling = read?.authorizedUpTo ?? task.spec?.authorizedUpTo;
    const derived = read?.authorizedSteps;
    const stored = task.spec?.authorizedSteps;
    const boundary = derived?.length ? derived : stored?.length ? stored : undefined;
    return {
      allowed: true,
      ...(boundary ? { authorizedSteps: boundary } : {}),
      ...(ceiling ? { authorizedUpTo: ceiling } : {}),
      reason: ceiling
        ? `你已回复「${answer}」：做到 ${ceiling} 就停`
        : boundary
          ? `已授权到 ${boundary.join('、')}，做到这里就停`
          : '没有边界，按计划继续',
    };
  }

  return { allowed: true, reason: '没有待回答的问题' };
}
