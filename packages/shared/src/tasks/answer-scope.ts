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

/** `1.2` → [1, 2]; comparable without depending on the plan containing it. */
function idKey(id: string): number[] {
  return id
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
}

function compareKeys(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

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

  const steps = plan ?? [];
  if (steps.length === 0) return undefined;

  /**
   * Ordered by id, not by position in the plan.
   *
   * The previous version required the named step to already exist — and 「完成 1.2 后暂停」 is
   * answered exactly when 1.2 does *not* yet exist (the worker has not planned that section,
   * or the section was expanded after the reply). So the boundary came back `undefined`, the
   * pause lifted with nothing to hold the run, the worker was resumed with the whole
   * remaining plan, and the task was completed past the boundary it had just been given.
   * That is the bug that kept coming back.
   *
   * Comparing ids numerically instead means a step named before it exists still bounds the
   * run: everything up to and including 1.2 is authorised, 2 and later are not.
   */
  const mentioned: string[] = [];
  for (const match of text.matchAll(STEP_ID)) {
    const id = match[1] ?? '';
    if (!id) continue;
    /**
     * Skip a number that is part of a larger token.
     *
     * Now that the id does not have to exist in the plan, 「v1.9」 or 「3.5 小时」 would
     * otherwise become a step and bound the run at an arbitrary point. What precedes the
     * match is the only way to tell: a version number, a decimal, a clock time.
     */
    const before = text.slice(0, match.index ?? 0)
    if (/[A-Za-z0-9.．]$/.test(before)) continue;
    if (!mentioned.includes(id)) mentioned.push(id);
  }
  if (mentioned.length === 0) return undefined;

  const ceiling = mentioned.map(idKey).sort((a, b) => compareKeys(a, b)).at(-1);
  if (!ceiling) return undefined;

  const authorized = steps.filter((step) => compareKeys(idKey(step.id), ceiling) <= 0).map((s) => s.id);
  const beyond = steps.filter((step) => compareKeys(idKey(step.id), ceiling) > 0).map((s) => s.id);

  // A boundary only exists if the reply asks to stop AND something is actually left beyond
  // it. 「1.2 也做完」 is permission to continue, and stopping after the last step is just
  // finishing — neither is a slice.
  if (!STOP_WORDS.test(text) || beyond.length === 0 || authorized.length === 0) return undefined;

  return authorized;
}
