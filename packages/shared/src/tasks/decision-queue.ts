/**
 * A task can be waiting on more than one question.
 *
 * The single `Task.decision` slot meant a second question replaced the first, answer included.
 * These helpers read the queue (`Task.decisions`) and keep the old slot pointing at the newest
 * open entry, so every reader that only asks 「is something open?」 keeps working unchanged.
 *
 * No wording is compared here except to spot a literal repeat: 「同一个问题不能问两次」 is judged by
 * the text a person would see, normalized for whitespace and punctuation-free equality. That is
 * identity, not interpretation — deciding whether two differently-worded questions mean the same
 * thing is the supervisor's judgement, and code that guessed at it would be wrong silently.
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

/**
 * Two questions a person would read as one.
 *
 * Whitespace and full-width/half-width punctuation differ across relays while the sentence does
 * not, so they are normalized away. Nothing else is — 「要不要做 2」 and 「要不要做 2？」 are the
 * same question; 「做 2 吗」 and 「做 3 吗」 are not.
 */
export function normalizeQuestion(text: string | undefined): string {
  return (text ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？,.;:!?~～"'“”‘’()（）\[\]【】]/g, '')
    .toLowerCase();
}

/** Whether an identical question is already on the task and still unanswered. */
export function findDuplicateOpen(task: Task, question: string): TaskDecision | undefined {
  const wanted = normalizeQuestion(question);
  if (!wanted) return undefined;
  return openDecisions(task).find((entry) => normalizeQuestion(entry.question) === wanted);
}
