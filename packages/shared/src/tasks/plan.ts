/**
 * Task plan — the checklist a worker keeps about its own work.
 *
 * Why this exists: "the worker drifted off target" is a judgement, and judging it
 * needs a model reading a transcript. "No step has moved in twenty minutes" is a
 * fact, and facts are cheap to check. A plan turns the first question into the
 * second.
 *
 * Two rules keep the plan honest:
 *
 *  - steps may be added and removed while the work happens (a task discovers new
 *    steps as it goes; forcing an accurate plan up front only produces a fake
 *    plan),
 *  - but a step may not be marked done without saying what proves it, which is
 *    what stops "done" from being a synonym for "I would like this to be over".
 */

export type PlanStepStatus = 'todo' | 'doing' | 'done' | 'blocked';

export interface PlanStep {
  /** Stable id (`1.0`, `1.1`, `2.0`): parents are the prefix before the last dot. */
  id: string;
  title: string;
  status: PlanStepStatus;
  /** Why it is blocked, or what proves it is done. */
  note?: string;
  /** When the status last changed — the drift check reads this. */
  updatedAt?: number;
}

export const PLAN_STEP_LIMIT = 60;

const STATUSES: readonly PlanStepStatus[] = ['todo', 'doing', 'done', 'blocked'];

/** `1.2` → `1`; a top-level `1` → `1`. Used to nest sub-steps without a tree. */
export function stepParent(id: string): string | undefined {
  const cut = id.lastIndexOf('.');
  return cut > 0 ? id.slice(0, cut) : undefined;
}

export function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

/**
 * Coerce whatever a worker sent into a usable plan.
 *
 * Deliberately forgiving: a malformed step is dropped, not fatal. A plan is a
 * progress aid; refusing to save it because one row is wrong helps nobody.
 */
export function normalizePlan(raw: unknown, now = Date.now()): PlanStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const steps: PlanStep[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Partial<PlanStep>;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    if (!id || !title) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    steps.push({
      id,
      title: title.slice(0, 200),
      status: isPlanStepStatus(value.status) ? value.status : 'todo',
      ...(typeof value.note === 'string' && value.note.trim()
        ? { note: value.note.trim().slice(0, 300) }
        : {}),
      ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : { updatedAt: now }),
    });
    if (steps.length >= PLAN_STEP_LIMIT) break;
  }

  return steps.length ? steps : undefined;
}

export interface PlanProgress {
  total: number;
  done: number;
  doing: number;
  blocked: number;
  /** `done / total`, 0 when empty. */
  ratio: number;
  /** True when every step is done (an empty plan is not finished). */
  complete: boolean;
}

export function planProgress(plan: PlanStep[] | undefined): PlanProgress {
  const steps = plan ?? [];
  const total = steps.length;
  const done = steps.filter((step) => step.status === 'done').length;
  const doing = steps.filter((step) => step.status === 'doing').length;
  const blocked = steps.filter((step) => step.status === 'blocked').length;
  return {
    total,
    done,
    doing,
    blocked,
    ratio: total === 0 ? 0 : done / total,
    complete: total > 0 && done === total,
  };
}

/** The step currently being worked on, if any (first `doing`, else first `todo`). */
export function currentStep(plan: PlanStep[] | undefined): PlanStep | undefined {
  if (!plan?.length) return undefined;
  return plan.find((step) => step.status === 'doing') ?? plan.find((step) => step.status === 'todo');
}

/**
 * Has the plan stopped moving?
 *
 * `since` is the newest evidence of activity the caller trusts (the last plan
 * change, the last handoff, the last heartbeat). A plan that has not moved for
 * longer than `thresholdMs` while the task claims to be running is the
 * structural form of "the worker is no longer making progress".
 */
export function planStalled(
  plan: PlanStep[] | undefined,
  since: number,
  now: number,
  thresholdMs: number,
): boolean {
  if (!plan?.length) return false;
  if (planProgress(plan).complete) return false;
  return now - since >= thresholdMs;
}

/** Newest `updatedAt` across the plan, for the drift comparison. */
export function lastPlanChangeAt(plan: PlanStep[] | undefined): number {
  if (!plan?.length) return 0;
  return plan.reduce((newest, step) => Math.max(newest, step.updatedAt ?? 0), 0);
}

/**
 * Apply a step-level patch.
 *
 * Removing a step is allowed for steps that are not done: the work changed, and
 * keeping a stale row would make the plan disagree with the task. A finished
 * step stays, because it is the record of what was accomplished.
 */
export function applyPlanPatch(
  plan: PlanStep[] | undefined,
  patch: { id: string; status?: PlanStepStatus; title?: string; note?: string; remove?: boolean },
  now = Date.now(),
): { plan: PlanStep[]; changed: boolean; error?: string } {
  const steps = [...(plan ?? [])];
  const index = steps.findIndex((step) => step.id === patch.id);

  if (patch.remove) {
    if (index < 0) return { plan: steps, changed: false, error: `no such step: ${patch.id}` };
    if (steps[index]!.status === 'done') {
      return { plan: steps, changed: false, error: 'a finished step stays in the plan' };
    }
    steps.splice(index, 1);
    return { plan: steps, changed: true };
  }

  if (index < 0) {
    if (!patch.title) return { plan: steps, changed: false, error: 'a new step needs a title' };
    if (steps.length >= PLAN_STEP_LIMIT) {
      return { plan: steps, changed: false, error: `plan is limited to ${PLAN_STEP_LIMIT} steps` };
    }
    steps.push({
      id: patch.id,
      title: patch.title.slice(0, 200),
      status: patch.status ?? 'todo',
      ...(patch.note ? { note: patch.note.slice(0, 300) } : {}),
      updatedAt: now,
    });
    return { plan: steps, changed: true };
  }

  const previous = steps[index]!;
  const next: PlanStep = {
    ...previous,
    ...(patch.title ? { title: patch.title.slice(0, 200) } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.note !== undefined ? { note: patch.note.slice(0, 300) } : {}),
    updatedAt: now,
  };
  const changed =
    next.status !== previous.status ||
    next.title !== previous.title ||
    next.note !== previous.note;
  if (!changed) return { plan: steps, changed: false };
  steps[index] = next;
  return { plan: steps, changed: true };
}

/** Render the plan for the cold-start brief and for the task detail page. */
export function formatPlan(plan: PlanStep[] | undefined): string[] {
  if (!plan?.length) return [];
  return plan.map((step) => {
    const mark = step.status === 'done' ? 'x' : step.status === 'doing' ? '>' : step.status === 'blocked' ? '!' : ' ';
    const note = step.note ? ` — ${step.note}` : '';
    return `- ${step.id} [${mark}] ${step.title}${note}`;
  });
}
