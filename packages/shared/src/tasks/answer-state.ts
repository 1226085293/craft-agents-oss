/**
 * Whether the person's last reply has been acted on yet.
 *
 * A supervisor that asks a question, reads the answer, and asks again in the same breath is
 * producing a confirmation loop, not a new question. Nothing distinguishes the two by wording —
 * 「暂不执行 2，保持暂停」 answered with 「是否继续？」 reads as a new question and as a repeat of
 * the one it answers — so the difference has to come from the record.
 *
 * It does: a NEW question is one asked about a state that changed. Between the reply and the
 * question there is work — a directive written from the reply, a plan step advanced, a status
 * change. When the reply is the most recent thing on the task, nothing has happened yet, and a
 * card raised then can only be the same question again.
 *
 * Observed live on T-1: answered 「暂不执行 2，保持暂停」 at 06:08:59, asked 「是否继续？」 at
 * 06:09:01. Reopening the decision there discarded the answer — the task ended with an open
 * question and no record that the person had ever replied.
 *
 * Pure, and reads only timestamps: no wording is inspected.
 */
import type { Task } from './types.ts';
import { openSteps, type PlanStep } from './plan.ts';

/**
 * When the plan last changed, from the steps themselves.
 *
 * The plan is flat: a sub-step is a row whose id is dotted (`1.1` under outline `1`), so one pass
 * covers every level.
 */
function lastPlanChange(plan: PlanStep[] | undefined): number {
  let latest = 0;
  for (const step of plan ?? []) {
    const at = step.updatedAt ?? 0;
    if (at > latest) latest = at;
  }
  return latest;
}

/**
 * True when nobody has done anything since the person replied.
 *
 * `answered` requires an answer with a timestamp; a decision closed by timeout or made obsolete
 * is not somebody speaking, so it does not count and this returns false.
 */
export function answeredWithoutProgress(task: Task): boolean {
  const answeredAt = task.decision?.answer?.at;
  if (!answeredAt) return false;
  // Still open means the answer was already consumed by an earlier reopen; not this case.
  if (!task.decision?.resolvedAt) return false;

  const since = Math.max(
    task.spec?.directive?.at ?? 0,
    lastPlanChange(task.spec?.plan),
    // A task that moved out of `paused` was acted on, whether or not anything was written.
    task.status === 'paused' ? 0 : task.updatedAt,
  );
  if (since > answeredAt) return false;

  // Nothing to do next means there is no state to ask about either.
  return openSteps(task.spec?.plan).length > 0;
}
