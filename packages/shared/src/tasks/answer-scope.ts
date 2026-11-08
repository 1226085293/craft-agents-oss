/**
 * What a reply authorises, read from the words themselves.
 *
 * A person answers a decision in prose — 「完成 1.2 后暂停」 — and the supervisor, whose turn
 * may fail or be rate-limited, is the only thing expected to translate that into a boundary.
 * On a real run the translation never happened: the reply was recorded, the pause lifted,
 * and the worker resumed with the whole plan still open, ran steps 1.2, 2 and 2.1, and
 * delivered a task the person had explicitly asked to stop.
 *
 * So the boundary is derived here, deterministically, from the sentence. It is deliberately
 * narrow: it only recognises *step ids the plan already contains*, and only when the reply
 * also says to stop. Anything it does not understand leaves the task exactly as before —
 * a guess about what someone authorised is worse than no guess.
 */
import type { PlanStep } from './plan.ts';

/** Words that mean "stop when you get here". */
const STOP_WORDS = /(暂停|停|停止|到此|就此|不要继续|先不要|结束|停一下|停下)/;

/** A step id as people write it: 1.2, 步骤 2, 第 3 步. */
const STEP_ID = /(?:步骤\s*|第\s*)?(\d+(?:\.\d+)*)\s*(?:步|小节)?/g;

/**
 * Steps the reply authorises, or `undefined` when the reply does not state a boundary.
 *
 * `undefined` is the important half of this contract: "do what you were doing" must not be
 * turned into "do only these steps" by a parser that found no numbers.
 */
export function authorizedStepsFromAnswer(
  answer: string,
  plan: PlanStep[] | undefined,
): string[] | undefined {
  const text = answer.trim();
  if (!text) return undefined;

  const known = new Set((plan ?? []).map((step) => step.id));
  if (known.size === 0) return undefined;

  const mentioned: string[] = [];
  for (const match of text.matchAll(STEP_ID)) {
    const id = match[1] ?? '';
    // Only ids the plan actually has: 「1.2」 in a sentence about something else, or a
    // version number, must not become a step.
    if (known.has(id) && !mentioned.includes(id)) mentioned.push(id);
  }
  if (mentioned.length === 0) return undefined;

  // Today's worker can only be told where to stop, not which single step to do:
  // 「完成 1.2」 means "get to 1.2", so everything up to it is authorised and the rest is not.
  const lastIndex = Math.max(...mentioned.map((id) => (plan ?? []).findIndex((s) => s.id === id)));
  const ordered = (plan ?? []).slice(0, lastIndex + 1).map((step) => step.id);
  const beyond = (plan ?? []).slice(lastIndex + 1).map((step) => step.id);

  // A boundary only exists if the reply actually asks to stop, and there is something
  // beyond the named step to stop at. 「1.2 也做完」 is not a boundary.
  if (!STOP_WORDS.test(text) || beyond.length === 0) return undefined;

  return ordered;
}
