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
  /**
   * Which profile owns this step.
   *
   * A task can be handed between agents — one plans, another executes, a third
   * verifies. Without this the plan said what happens but never who does it, so
   * "during which stage is which agent responsible" had no answer anywhere.
   */
  agent?: string;
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

/** An outline item: `1`, `2`. Written before execution, coarse, rarely edited. */
export function isOutlineStep(id: string): boolean {
  return !id.includes('.');
}

/**
 * May this new outline be added to a plan the user agreed to?
 *
 * Returns an error message when it may not, undefined when it may. The plan contract
 * has always allowed steps to be discovered while the work happens — "forcing an
 * accurate plan up front only produces a fake plan" — so appending is fine. What must
 * not happen is the agreement being rewritten: a plan the user stated has an order they
 * will read, and inserting into it renumbers their plan behind their back.
 *
 * A plan the worker shaped itself is not marked `planAgreed` and never reaches here.
 */
export function checkAgreedPlanAppend(
  plan: PlanStep[] | undefined,
  newId: string,
  agreed: boolean | undefined,
): string | undefined {
  if (!agreed) return undefined;
  if (!isOutlineStep(newId)) return undefined;
  const steps = plan ?? [];
  if (steps.some((step) => step.id === newId)) return undefined;
  const ids = steps
    .filter((step) => isOutlineStep(step.id))
    .map((step) => Number(step.id))
    .filter((n) => Number.isFinite(n));
  const highest = ids.length ? Math.max(...ids) : 0;
  const wanted = Number(newId);
  if (Number.isFinite(wanted) && wanted > highest) return undefined;
  const listed = steps
    .filter((step) => isOutlineStep(step.id))
    .map((step) => `${step.id} ${step.title}`)
    .join('；');
  return `用户约定的大纲：${listed}。新步骤可以追加（如 ${highest + 1}），但不能插到它们前面或中间 —— 那会改掉用户已经认可的顺序。`;
}

/**
 * What an outline item's status actually is, given its sub-steps.
 *
 * The stored status is only what somebody last wrote; a section's real state is
 * its sub-steps' state. Without this, marking `1.1` as doing left `1` on the
 * "not started" icon, and finishing `1.1` and `1.2` never turned `1` green — the
 * outline looked untouched while the work underneath it was half finished.
 *
 * The rules follow the same logic the patch guard already enforces in the other
 * direction (an outline may not claim doing/done on its own): "section 1 is under
 * way" means some step of section 1 is, and "section 1 is done" means all are.
 */
export function deriveOutlineStatus(plan: PlanStep[], outline: PlanStep): PlanStepStatus {
  const kids = childrenOf(plan, outline.id);
  if (kids.length === 0) return outline.status;

  if (kids.every((kid) => kid.status === 'done')) {
    // All children closed — but a section may only read as closed when the next
    // one is executable, which is the same rule `applyPlanPatch` enforces on an
    // explicit patch. Deriving `done` without that check would let the view claim
    // a completion the rules refuse, and the worker would then never be told to
    // expand the next section: the plan would sit finished with nowhere to go.
    const outlines = plan.filter((step) => isOutlineStep(step.id));
    const at = outlines.findIndex((step) => step.id === outline.id);
    const next = at >= 0 ? outlines[at + 1] : undefined;
    if (!next || childrenOf(plan, next.id).length > 0) return 'done';
    return 'doing';
  }

  if (kids.some((kid) => kid.status === 'doing')) return 'doing';
  // Partly finished is still under way: `1` may not sit on "not started" while
  // one of its sub-steps is already closed.
  if (kids.some((kid) => kid.status === 'done')) return 'doing';
  if (kids.some((kid) => kid.status === 'blocked')) return 'blocked';
  return 'todo';
}

/**
 * The plan with every outline's status recomputed from its sub-steps.
 *
 * Applied on read and after every patch, so stored data converges without a
 * migration and files written by older versions still render truthfully.
 */
export function applyDerivedStatuses(plan: PlanStep[] | undefined): PlanStep[] {
  if (!plan?.length) return plan ?? [];
  let changed = false;
  const next = plan.map((step) => {
    if (!isOutlineStep(step.id)) return step;
    const status = deriveOutlineStatus(plan, step);
    if (status === step.status) return step;
    changed = true;
    return { ...step, status };
  });
  return changed ? next : plan;
}

/** Sub-steps of one outline item, in plan order. */
export function childrenOf(plan: PlanStep[] | undefined, id: string): PlanStep[] {
  return (plan ?? []).filter((step) => stepParent(step.id) === id);
}

function outlineSteps(plan: PlanStep[] | undefined): PlanStep[] {
  return (plan ?? []).filter((step) => isOutlineStep(step.id));
}

/**
 * The outline item being worked on: the first one that is not finished.
 *
 * This is the anchor the "you may edit what comes next" rule is measured from —
 * everything before it is history, everything after it is still a plan.
 */
export function currentOutline(plan: PlanStep[] | undefined): PlanStep | undefined {
  return outlineSteps(plan).find((step) => step.status !== 'done');
}

/** The outline item directly after `id`, if the plan has one. */
function outlineAfter(plan: PlanStep[], id: string): PlanStep | undefined {
  const outlines = outlineSteps(plan);
  const at = outlines.findIndex((step) => step.id === id);
  return at >= 0 ? outlines[at + 1] : undefined;
}

/**
 * Steps that carry work — sub-steps, and outlines nobody decomposed.
 * Progress counts these, so an outline is never counted twice.
 */
function leafSteps(plan: PlanStep[] | undefined): PlanStep[] {
  return (plan ?? []).filter((step) => childrenOf(plan, step.id).length === 0);
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
      ...(typeof value.agent === 'string' && value.agent.trim()
        ? { agent: value.agent.trim().slice(0, 60) }
        : {}),
      ...(typeof value.note === 'string' && value.note.trim()
        ? { note: value.note.trim().slice(0, 300) }
        : {}),
      ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : { updatedAt: now }),
    });
    if (steps.length >= PLAN_STEP_LIMIT) break;
  }

  return steps.length ? applyDerivedStatuses(steps) : undefined;
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
  // Leaves only: an outline that was decomposed reports through its sub-steps,
  // otherwise "3 of 8 done" would count a parent and its children twice.
  const steps = leafSteps(plan);
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
export interface PlanPatchScope {
  /**
   * Step ids the person authorised for this run.
   *
   * `spec.scope` already says it in prose — 「完成 1.2 后暂停，不执行步骤 2」 — and nothing
   * read it. Observed on a real run: the boundary was written down in those words, and the
   * worker went on to mark 1.2, 2 and 2.1 done and delivered the whole task. A sentence
   * cannot stop a tool call; a list can.
   */
  authorizedSteps?: string[];
  /** The highest id allowed, e.g. `1.2` — may name a step that does not exist yet. */
  authorizedUpTo?: string;
}

export function applyPlanPatch(
  plan: PlanStep[] | undefined,
  patch: { id: string; status?: PlanStepStatus; title?: string; note?: string; agent?: string; remove?: boolean },
  now = Date.now(),
  scope: PlanPatchScope = {},
): { plan: PlanStep[]; changed: boolean; error?: string } {
  const steps = [...(plan ?? [])];
  const index = steps.findIndex((step) => step.id === patch.id);

  /**
   * Keep an outline in step with its children after any child-level change.
   *
   * Done here rather than in the caller because every write path to a plan goes
   * through this function; syncing at only one of them is how the two halves of
   * a plan drift apart in the first place.
   */
  const syncOutlineOf = (childId: string): void => {
    const parentId = stepParent(childId);
    if (!parentId) return;
    const parentIndex = steps.findIndex((step) => step.id === parentId);
    if (parentIndex < 0) return;
    const parent = steps[parentIndex]!;
    const status = deriveOutlineStatus(steps, parent);
    if (status === parent.status) return;
    steps[parentIndex] = { ...parent, status, updatedAt: now };
  };

  if (patch.remove) {
    if (index < 0) return { plan: steps, changed: false, error: `no such step: ${patch.id}` };
    const removing = steps[index]!;
    if (removing.status === 'done') {
      return { plan: steps, changed: false, error: 'a finished step stays in the plan' };
    }
    const kids = childrenOf(steps, removing.id);
    if (kids.length > 0) {
      return {
        plan: steps,
        changed: false,
        error: `${removing.id} 还有 ${kids.length} 个小节（${kids.map((s) => s.id).join(', ')}），先移除它们`,
      };
    }
    steps.splice(index, 1);
    return { plan: steps, changed: true };
  }

  /**
   * Refuse to work past the authorised slice.
   *
   * Only status moves are gated: writing a note or renaming is harmless, but marking a
   * step `doing` or `done` claims work that was never authorised. The refusal names the
   * boundary and the way out, because a wall without an exit is what makes a worker
   * pretend — one previous run "cleared" the plan by removing the steps instead.
   */
  const authorized = scope.authorizedSteps
  const ceiling = scope.authorizedUpTo
  const moving = patch.status === 'doing' || patch.status === 'done'
  /**
   * Allowed if the step is in the explicit list, or at or below the ceiling.
   *
   * The ceiling is what makes 「完成 1.2 后暂停」 enforceable before 1.2 has been planned: the
   * id does not have to exist to be the place to stop at.
   */
  const keyOf = (id: string) => (id.match(/\d+(?:\.\d+)*/g) ?? ['0'])[0]
  const cmp = (a: string, b: string): number => {
    const left = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
    const right = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const d = (left[i] ?? 0) - (right[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  }
  const withinCeiling = ceiling ? cmp(keyOf(patch.id), keyOf(ceiling)) <= 0 : false
  if (authorized && authorized.length > 0 && moving && !authorized.includes(patch.id) && !withinCeiling) {
    const allowed = steps.filter((step) => authorized.includes(step.id)).map((step) => step.id)
    return {
      plan: steps,
      changed: false,
      error:
        `${patch.id} 不在本次授权范围内（授权：${allowed.join('、') || '无'}）。` +
        '不要把它标成完成，也不要移除它——保持原样，用 `report_result`（outcome 用 handoff）交接，' +
        '由督导决定是否扩大范围。',
    }
  }

  if (index < 0) {
    if (!patch.title) return { plan: steps, changed: false, error: 'a new step needs a title' };
    if (steps.length >= PLAN_STEP_LIMIT) {
      return { plan: steps, changed: false, error: `plan is limited to ${PLAN_STEP_LIMIT} steps` };
    }
    // A sub-step without its outline is a step nobody agreed to. It also makes
    // "do the current section" unanswerable, because there is no section.
    const parent = stepParent(patch.id);
    /**
     * Who owns a sub-step nobody named.
     *
     * Leaving it blank made the plan unable to answer "whose work is this": on a
     * real run outline 2 and its only sub-step both carried no owner, so the board
     * fell back to the assignee for display while the routing logic saw "nobody" —
     * two different answers from one field. A sub-step inherits the owner of the
     * section it belongs to, which is the same rule the display was already implying.
     */
    let inheritedAgent: string | undefined;
    if (parent) {
      const parentStep = steps.find((step) => step.id === parent);
      inheritedAgent = parentStep?.agent;
      if (!parentStep) {
        return {
          plan: steps,
          changed: false,
          error: `小节 ${patch.id} 没有对应的大纲 ${parent}：先写大纲，再展开它的小节`,
        };
      }
      if (parentStep.status === 'done') {
        return {
          plan: steps,
          changed: false,
          error: `大纲 ${parent} 已完成并冻结，不能再往它下面加小节；返工请新开一条大纲`,
        };
      }
    }
    steps.push({
      id: patch.id,
      title: patch.title.slice(0, 200),
      status: patch.status ?? 'todo',
      ...(patch.agent
        ? { agent: patch.agent.slice(0, 60) }
        : inheritedAgent
          ? { agent: inheritedAgent }
          : {}),
      ...(patch.note ? { note: patch.note.slice(0, 300) } : {}),
      updatedAt: now,
    });
    syncOutlineOf(patch.id);
    return { plan: steps, changed: true };
  }

  const previous = steps[index]!;

  // Frozen: a finished step is a record of what happened, not a draft. Rewriting
  // it would make the plan disagree with the journal, which already says it was
  // done. Rework is a new step; erasing is not editing.
  if (previous.status === 'done') {
    if (patch.status && patch.status !== 'done') {
      return {
        plan: steps,
        changed: false,
        error: `${previous.id} 已完成并冻结，不能改回 ${patch.status}；要返工就新开一条小节`,
      };
    }
    if (patch.title && patch.title.trim() !== previous.title) {
      return { plan: steps, changed: false, error: `${previous.id} 已完成并冻结，标题不能再改` };
    }
    if (patch.agent && patch.agent !== previous.agent) {
      return { plan: steps, changed: false, error: `${previous.id} 已完成并冻结，负责的 agent 不能再改` };
    }
    if (patch.note !== undefined && !patch.note.trim()) {
      return { plan: steps, changed: false, error: `${previous.id} 已完成并冻结，它的完成证据不能被清空` };
    }
  }

  // An outline earns `doing`/`done` only through its sub-steps: "section 2 is
  // under way" means some step of section 2 is, and "section 2 is done" means
  // all of them are.
  if (isOutlineStep(previous.id) && (patch.status === 'doing' || patch.status === 'done')) {
    const kids = childrenOf(steps, previous.id);
    if (kids.length === 0) {
      return {
        plan: steps,
        changed: false,
        error: `大纲 ${previous.id} 还没有小节。先把它拆成可执行的步骤（如 ${previous.id}.1），再开始`,
      };
    }
    if (patch.status === 'done') {
      const unfinished = kids.filter((step) => step.status !== 'done');
      if (unfinished.length > 0) {
        return {
          plan: steps,
          changed: false,
          error: `大纲 ${previous.id} 还有 ${unfinished.length} 个小节未完成（${unfinished.map((s) => s.id).join(', ')}）`,
        };
      }
      // Lookahead: the next section must already be broken down, or the moment
      // this one closes there is nothing executable to pick up. Enforcing it here
      // (rather than telling the worker to do it next) means the plan is never
      // observed in a state where execution has nowhere to go.
      const next = outlineAfter(steps, previous.id);
      if (next && childrenOf(steps, next.id).length === 0) {
        return {
          plan: steps,
          changed: false,
          error: `完成 ${previous.id} 之前，先把下一条大纲 ${next.id} 的小节建出来 —— 否则下一条开工时没有可执行的步骤`,
        };
      }
    }
  }

  const next: PlanStep = {
    ...previous,
    ...(patch.title ? { title: patch.title.slice(0, 200) } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.agent ? { agent: patch.agent.slice(0, 60) } : {}),
    ...(patch.note !== undefined ? { note: patch.note.slice(0, 300) } : {}),
    updatedAt: now,
  };
  const changed =
    next.status !== previous.status ||
    next.title !== previous.title ||
    next.note !== previous.note ||
    next.agent !== previous.agent;
  if (!changed) return { plan: steps, changed: false };
  steps[index] = next;
  syncOutlineOf(next.id);
  return { plan: steps, changed: true };
}

/**
 * Render the plan as a checklist.
 *
 * The mark comes first — `- [x] title` — because that is the form the plan is
 * written and read in: it is a markdown task list, and every checkbox renderer
 * (and every human) reads the box before the text. The id trails the title so a
 * step can still be addressed by `task_plan`, without pushing the box off the
 * part of the line the eye lands on.
 */
export function formatPlan(plan: PlanStep[] | undefined): string[] {
  if (!plan?.length) return [];
  return plan.map((step) => {
    const mark = step.status === 'done' ? 'x' : step.status === 'doing' ? '>' : step.status === 'blocked' ? '!' : ' ';
    const owner = step.agent ? ` @${step.agent}` : '';
    const note = step.note ? ` — ${step.note}` : '';
    // Indent by depth so an outline and its sub-steps read as one thing; the
    // box still comes first because this is a task list.
    const indent = '  '.repeat(step.id.split('.').length - 1);
    return `${indent}- [${mark}] ${step.title}${owner} (${step.id})${note}`;
  });
}

export interface NextLeg {
  /** The step that should be worked on next. */
  step: PlanStep;
  /** The outline it belongs to. */
  outline: PlanStep;
  /** Who should do it: the step's own owner, else the task's assignee. */
  agent?: string;
}

/**
 * Which step comes next, and who should do it.
 *
 * Pure on purpose. Handing work to the next section must not cost a model call
 * and must not go through the supervisor's conversation: with several tasks
 * running, every hand-off would queue a message in front of the user's own, and
 * the user's next sentence would wait behind bookkeeping. The plan already says
 * what comes next and who owns it — reading it is a lookup, not a judgement.
 *
 * Returns undefined when there is nothing scheduled: every section finished, or
 * the current section has not been broken down yet (in which case a human set the
 * plan aside mid-flight, and guessing would be worse than waiting).
 */
export function nextLeg(plan: PlanStep[] | undefined): NextLeg | undefined {
  if (!plan?.length) return undefined;
  const outlines = plan
    .filter((step) => isOutlineStep(step.id))
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const outline of outlines) {
    if (outline.status === 'done') continue;
    const kids = childrenOf(plan, outline.id);
    // A section with no sub-steps has not been expanded; the worker owns that.
    if (kids.length === 0) return undefined;
    const step = kids.find((kid) => kid.status !== 'done');
    if (step) return { step, outline, ...(step.agent ? { agent: step.agent } : {}) };
  }
  return undefined;
}
