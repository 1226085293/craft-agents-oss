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
/**
 * The id the reply says to stop AT — 「完成 1.2 后暂停」 → `1.2`.
 *
 * A ceiling rather than a list, because a list can only name steps that already exist: the
 * reply is answered exactly when 1.2 has *not* been planned, so the list came back empty and
 * the run went unbounded. A ceiling says "everything up to 1.2", which is true whether or not
 * 1.2 has been written down yet.
 */
/** Words that mean "you may go on / do more". */
const RELEASE_WORDS = /(放行|允许|同意|可以继续|继续|接着|都做|全部|所有|做完|全做|整个|剩下的)/;

/**
 * Words that make a release cover the whole plan rather than the step named.
 *
 * `其余` is deliberately absent: 「仅放行 1.2 读回，其余之后再定」 is a release that EXCLUDES
 * everything else, and reading 其余 as "the whole plan" turned a narrow permission into full
 * authorisation — the exact failure direction (too much authority) that matters most.
 */
const WHOLE_PLAN_WORDS = /(全部|所有|都做|做完|全做|整个|剩下的|剩的|剩余)/;

/**
 * What a reply authorises, in both directions.
 *
 * The existing parsers could only ever NARROW: both of them start by requiring a stop word, so
 * 「完成 1.2 后暂停」 became a ceiling and 「放行步骤 2（收尾），把任务做完」 became nothing at
 * all. Nothing in the codebase could widen an authorisation, so the boundary stayed at 1.2 for
 * the rest of the task's life — and every later resume carried 「本次只做到 1.2，到此为止」
 * directly above 「用户的答复是：放行步骤 2」.
 *
 * One function decides both directions, so the answer cannot be read one way by the boundary
 * and another way by the resume path.
 */
export function authorizationFromAnswer(
  answer: string,
  plan: PlanStep[] | undefined,
): { authorizedUpTo?: string; authorizedSteps?: string[] } | undefined {
  const text = answer.trim();
  const steps = plan ?? [];
  if (!text || steps.length === 0) return undefined;

  const mentioned: string[] = [];
  for (const match of text.matchAll(STEP_ID)) {
    const id = match[1] ?? '';
    if (!id) continue;
    const before = text.slice(0, match.index ?? 0);
    if (/[A-Za-z0-9.．]$/.test(before)) continue;
    if (!mentioned.includes(id)) mentioned.push(id);
  }
  const byId = (a: string, b: string) => compareKeys(idKey(a), idKey(b));
  const lastStep = [...steps].map((s) => s.id).sort(byId).at(-1);

  // Narrowing: 「完成 1.2 后暂停」.
  if (STOP_WORDS.test(text) && !RELEASE_WORDS.test(text)) {
    if (mentioned.length === 0) return undefined;
    const ceiling = [...mentioned].sort(byId).at(-1)!;
    const beyond = steps.some((step) => compareKeys(idKey(step.id), idKey(ceiling)) > 0);
    if (!beyond) return undefined;
    /**
     * The explicit list is emitted alongside the ceiling, not instead of it.
     *
     * The ceiling is what bounds a step that does not exist yet (「完成 1.2 后暂停」 is answered
     * before 1.2 is planned); the list is what the resume path hands the worker as its
     * boundary. Emitting only one of them made each caller pick a different half.
     */
    const within = steps
      .filter((step) => compareKeys(idKey(step.id), idKey(ceiling)) <= 0)
      .map((step) => step.id);
    return { authorizedUpTo: ceiling, ...(within.length ? { authorizedSteps: within } : {}) };
  }

  // Widening: 「放行步骤 2」, 「把任务做完」.
  if (RELEASE_WORDS.test(text)) {
    /**
     * 「做完/全部」 means the whole plan, even when a step is named alongside it: the reply
     * 「放行步骤 2（收尾），把任务做完」 names 2 and then says to finish, and reading only the
     * number would authorise up to 2 and stop one step short of what was asked.
     */
    const target = WHOLE_PLAN_WORDS.test(text)
      ? lastStep
      : [...mentioned].sort(byId).at(-1);
    if (!target) return undefined;
    const authorized = steps
      .filter((step) => compareKeys(idKey(step.id), idKey(target)) <= 0)
      .map((step) => step.id);
    if (authorized.length === 0) return undefined;
    return { authorizedUpTo: target, authorizedSteps: authorized };
  }

  return undefined;
}

export function authorizedCeilingFromAnswer(
  answer: string,
  plan: PlanStep[] | undefined,
): string | undefined {
  const text = answer.trim();
  if (!text || (plan ?? []).length === 0) return undefined;
  if (!STOP_WORDS.test(text)) return undefined;

  const mentioned: string[] = [];
  for (const match of text.matchAll(STEP_ID)) {
    const id = match[1] ?? '';
    if (!id) continue;
    const before = text.slice(0, match.index ?? 0);
    if (/[A-Za-z0-9.．]$/.test(before)) continue;
    if (!mentioned.includes(id)) mentioned.push(id);
  }
  if (mentioned.length === 0) return undefined;

  const ceiling = mentioned.map(idKey).sort(compareKeys).at(-1);
  if (!ceiling) return undefined;
  // Something has to be left beyond the ceiling, otherwise it is just "finish the plan".
  const beyond = (plan ?? []).some((step) => compareKeys(idKey(step.id), ceiling) > 0);
  if (!beyond) return undefined;

  return mentioned.find((id) => compareKeys(idKey(id), ceiling) === 0);
}

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
