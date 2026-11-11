/**
 * A task can be waiting on more than one question.
 *
 * The single `Task.decision` slot meant a second question replaced the first, answer included.
 * These helpers read the queue (`Task.decisions`) and keep the old slot pointing at the newest
 * open entry, so every reader that only asks 「is something open?」 keeps working unchanged.
 *
 * No wording is compared here. 「同一个问题不能问两次」 was once decided by comparing the text a person
 * would read, normalized for whitespace and punctuation — which can only catch a literal repeat, so
 * a supervisor that re-read the task and reworded its question produced two entries for one
 * unresolved situation. Identity is not a string property; the asker reads the queue back
 * (`list_questions`) and decides, which is the only place that judgement can actually be made.
 */
import type { Task, TaskDecision } from './types.ts';

/** Every question on the task, oldest first. */
export function allDecisions(task: Task): TaskDecision[] {
  // A task written before the queue existed has only the single slot.
  if (task.decisions?.length) return task.decisions;
  return task.decision ? [task.decision] : [];
}

/** Questions still waiting for a reply. */
export function openDecisions(task: Task): TaskDecision[] {
  return allDecisions(task).filter((entry) => !entry.resolvedAt);
}

/** Answers the person has given that nobody has been told about yet. */
export function undeliveredAnswers(task: Task): TaskDecision[] {
  return allDecisions(task).filter((entry) => entry.answer && !entry.deliveredAt);
}

/**
 * Questions the person has been asked but not yet shown.
 *
 * The other direction of `undeliveredAnswers`, and batched for the same reason: asking three
 * things should cost one interruption. A supervisor writes the question while its turn runs and
 * the card goes out when the turn ends.
 */
export function undeliveredQuestions(task: Task): TaskDecision[] {
  return allDecisions(task).filter(
    (entry) => !entry.resolvedAt && entry.question?.trim() && !entry.questionDeliveredAt,
  );
}

/**
 * The entry the legacy `decision` slot should show.
 *
 * Newest open question wins, because that is what every existing reader was built around: a card,
 * a pause label, a 「may the task run」 gate. With nothing open, the newest entry overall keeps the
 * closed state visible on the page.
 */
export function decisionMirror(task: Task): TaskDecision | undefined {
  const all = allDecisions(task);
  const open = all.filter((entry) => !entry.resolvedAt);
  return open.at(-1) ?? all.at(-1);
}

