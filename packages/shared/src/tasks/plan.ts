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
  /**
   * When this step first entered `doing`. Never cleared.
   *
   * This is the line between a plan and a record. A step nobody started is still a
   * proposal: dropping it loses nothing. A step that was started *happened* — someone
   * read code, ran a command, made a decision — and deleting it leaves the next worker
   * with a plan that agrees with reality only by forgetting what went wrong. Observed:
   * a run 「cleared」 its plan by removing the steps it did not want to finish, and the
   * hand-off looked complete because the evidence had been deleted rather than refuted.
   *
   * A timestamp is used because it is checkable without reading anyone's prose: the
   * question is "was this ever picked up?", not "did the note say it was abandoned?".
   */
  startedAt?: number;
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
  if (kids.length === 0) {
    /**
     * A section with no sub-steps is either finished as one action, or it is where work goes next.
     *
     * The old rule did the opposite: it held a *finished* section at `doing` while the next one was
     * still a bare title, so 「写文件」 spun while every sub-step under it was green and the plan read
     * 3/3 done — 「子任务完成后大纲还是进行中状态」, reported from a screenshot. The signal is real,
     * but it belongs to the section that has not been broken down yet, not to the finished one.
     */
    return deriveUndecomposedStatus(plan, outline);
  }

  // Every child closed means this section is closed. Nothing about the next one changes that.
  if (kids.every((kid) => kid.status === 'done')) return 'done';

  if (kids.some((kid) => kid.status === 'doing')) return 'doing';
  // Partly finished is still under way: `1` may not sit on "not started" while
  // one of its sub-steps is already closed.
  if (kids.some((kid) => kid.status === 'done')) return 'doing';
  if (kids.some((kid) => kid.status === 'blocked')) return 'blocked';
  return 'todo';
}

/**
 * Status of a section that has not been split into sub-steps.
 *
 * Two facts decide it, in this order: a section already closed stays closed (the next section
 * must not reopen it), and the section the plan has arrived at reads as `doing` — that is what
 * 「现在在这一节」 looks like, and it is why the plan carries one section under way instead of a
 * spinner stuck on the section before it.
 */
function deriveUndecomposedStatus(plan: PlanStep[], outline: PlanStep): PlanStepStatus {
  if (outline.status === 'done' || outline.status === 'blocked') return outline.status;
  /**
   * 「Now」 only means something once the plan has begun.
   *
   * Without this, a plan written a second ago showed its first section as already under way before
   * anyone touched it — the same kind of lie as the spinner on a finished section, pointing the
   * other way. A section becomes the one being worked on when work has actually arrived at it,
   * which is visible from the closed steps before it.
   */
  const began = plan.some((step) => step.status === 'done');
  return began && isFrontierOutline(plan, outline) ? 'doing' : outline.status;
}

/** True when every section before this one is closed, so work has arrived here. */
function isFrontierOutline(plan: PlanStep[], outline: PlanStep): boolean {
  const outlines = outlineSteps(plan).sort((a, b) => Number(a.id) - Number(b.id));
  const at = outlines.findIndex((step) => step.id === outline.id);
  if (at < 0) return false;
  return outlines.slice(0, at).every((step) => step.status === 'done');
}

/**
 * The plan with every outline's status recomputed from its sub-steps.
 *
 * Applied on read and after every patch, so stored data converges without a
 * migration and files written by older versions still render truthfully.
 *
 * Walked in order rather than mapped: whether a section reads as `doing` depends on whether the
 * ones before it are closed, so each answer has to see the previous ones already derived. Mapping
 * over the input made a section sit one step behind its neighbour — the section that had just been
 * closed still `doing` meant the next one never got its turn.
 */
export function applyDerivedStatuses(plan: PlanStep[] | undefined): PlanStep[] {
  if (!plan?.length) return plan ?? [];
  let changed = false;
  const next = [...plan];
  for (let at = 0; at < next.length; at += 1) {
    const step = next[at]!;
    if (!isOutlineStep(step.id)) continue;
    const status = deriveOutlineStatus(next, step);
    if (status === step.status) continue;
    changed = true;
    next[at] = { ...step, status };
  }
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
/**
 * Sub-steps that name no owner.
 *
 * A sub-step is the unit of assignment: 「1.1 创建 docs/a.md」 is handed to somebody, and a row with
 * no owner was handed to nobody. `applyPlanPatch` refuses to create one — but `task_create` writes a
 * whole `spec.plan` at once, and that path had no such check, so plans could arrive with every owner
 * missing and the page showed bare titles.
 *
 * The answer is to refuse, not to fill the gap with the task's assignee. The assignee is who the
 * task went to, not a decision about which profile fits this section — stamping it records a choice
 * nobody made, and once the record looks complete nothing ever puts the question to the model that
 * should have answered it.
 *
 * Outlines are exempt: a section is a stage, and its sub-steps may go to different profiles.
 */
export function unownedSubSteps(plan: PlanStep[] | undefined): PlanStep[] {
  return (plan ?? []).filter(
    (step) =>
      step.id.includes('.') &&
      !step.agent?.trim() &&
      /**
       * A finished step is a record, not an assignment.
       *
       * Refusing it would be asking for an owner after the work is over — the only way to satisfy
       * that is to invent one, which is the thing this check exists to prevent. What has to be
       * assigned is the work that is still ahead.
       */
      step.status !== 'done',
  );
}

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
      // Carried across a reload, or the "was this ever started?" question resets to "no"
      // every time the workspace is re-read and started steps become deletable again.
      ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
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
export function applyPlanPatch(
  plan: PlanStep[] | undefined,
  patch: { id: string; status?: PlanStepStatus; title?: string; note?: string; agent?: string; remove?: boolean },
  now = Date.now(),
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
    /**
     * A step that was started is a record, not a draft.
     *
     * Nothing below `doing` is history yet — an unstarted step is a proposal nobody acted
     * on, so dropping it costs nothing but a line. Once picked up, the step has changed
     * the world: code was read, a command ran, a decision was taken. Removing it does not
     * undo any of that, it just removes the only place that says it happened, and the next
     * worker inherits a plan that looks clean. The way out is to record the outcome, not to
     * delete the evidence.
     *
     * `startedAt` rather than `status`: a step taken out of `doing` and put back to `todo`
     * would otherwise become deletable again, which is the same erasure one click later.
     */
    if (removing.startedAt) {
      return {
        plan: steps,
        changed: false,
        error:
          `${removing.id} 已经开工过，是发生过的事，不能删。` +
          '不做它了就把状态改成 blocked 并写明原因（卡在哪、为什么放弃），' +
          '下一个接手的人得知道这里发生过什么；要换方向就在后面加大纲，不要抹掉已经发生的事。',
      };
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
    return { plan: applyDerivedStatuses(steps), changed: true };
  }

  /**
   * An outline's status is an observation, not an instruction.
   *
   * It is already recomputed from the sub-steps on every read and after every patch
   * (`applyDerivedStatuses`), so writing it was never more than a suggestion that the very
   * next read overwrote. Accepting the write and then discarding it is worse than either
   * refusing or ignoring: the caller is told nothing and the value it reads back disagrees
   * with what it just sent.
   *
   * Rejected rather than silently dropped so the caller learns the model in one turn: an
   * outline says *what stage this is*, a sub-step says *what to do* — "section 2 is under
   * way" is a statement about 2.1, 2.2, and it stops being true by itself when they close.
   */
  if (isOutlineStep(patch.id) && patch.status) {
    const kids = childrenOf(steps, patch.id);
    /**
     * A section nobody split up is one action, and one action can be finished.
     *
     * Everything else about a status written on an outline is still refused — the value is derived
     * from the sub-steps on every read, so accepting it would be a suggestion the next read
     * overwrites. But 「收尾」 style sections exist: a plan may end in a single step that nobody
     * wants to split into 2.1 for its own sake. Refusing `done` for those closed both doors at
     * once — the section could not be completed, and no sub-step could be created either — which is
     * how a finished task ended up unable to close its last row.
     *
     * The evidence requirement is what keeps this honest: a `done` here has to say what proves it,
     * exactly like a sub-step.
     */
    if (patch.status === 'done' && kids.length === 0) {
      if (!(patch.note ?? steps[index]?.note)?.trim()) {
        return {
          plan: steps,
          changed: false,
          error:
            `大纲 ${patch.id} 没有小节，要标记完成就得说明做完了什么（note）；` +
            `或者把它拆成小节（如 ${patch.id}.1）再标小节的状态。`,
        };
      }
      // Falls through to the normal status write below.
    } else {
      return {
        plan: steps,
        changed: false,
        error:
          `大纲 ${patch.id} 的状态不用写，它由小节派生（小节开工则进行中，小节全完成则完成）。` +
          (kids.length === 0
            ? `先把 ${patch.id} 拆成可执行的小节（如 ${patch.id}.1），标小节的状态；或者直接标 done 并在 note 里写明证据。`
            : `要推进就标小节：${kids.map((kid) => kid.id).join('、')}。`),
      };
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
     * A sub-step names its owner when it is created.
     *
     * Inheritance from the outline used to fill this in, which is why the field could be
     * left blank and still look filled. It also meant one value answered two questions:
     * the section's agent and the task's agent. Observed: outline 2 and its only sub-step
     * both carried no owner, so the board displayed the assignee while routing saw nobody —
     * two answers from one field. Now that outlines carry no owner at all, a sub-step is
     * the only thing that can say who does the work, so it has to say it.
     */
    if (parent) {
      const parentStep = steps.find((step) => step.id === parent);
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
      if (!patch.agent?.trim()) {
        return {
          plan: steps,
          changed: false,
          error:
            `小节 ${patch.id} 要写明谁做（agent）。可用的分工写在这份简报的「可用分工」一节里；` +
            '小节是派活的单位，没有负责人的小节等于没有派出去。',
        };
      }
    }
    steps.push({
      id: patch.id,
      title: patch.title.slice(0, 200),
      status: patch.status ?? 'todo',
      ...(patch.agent ? { agent: patch.agent.slice(0, 60) } : {}),
      ...(patch.note ? { note: patch.note.slice(0, 300) } : {}),
      ...(patch.status === 'doing' ? { startedAt: now } : {}),
      updatedAt: now,
    });
    syncOutlineOf(patch.id);
    return { plan: applyDerivedStatuses(steps), changed: true };
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
      /**
       * A section nobody split up is one step, and one step can be finished.
       *
       * This used to refuse outright, demanding sub-steps first. A plan ending in 「收尾」 then could
       * not close it without inventing 「2.1」 for a single action, and the section showed as `doing`
       * for as long as nobody did. The frontier section reads as `doing` by derivation, so accepting
       * that write is a no-op rather than a claim; the one thing still refused is closing a section
       * that has children — that answer comes from them, below.
       */
      if (patch.status === 'done' && !(patch.note ?? previous.note)?.trim()) {
        return {
          plan: steps,
          changed: false,
          error: `大纲 ${previous.id} 没有小节，直接标记完成需要写明做完了什么（note）`,
        };
      }
    } else if (patch.status === 'done') {
      const unfinished = kids.filter((step) => step.status !== 'done');
      if (unfinished.length > 0) {
        return {
          plan: steps,
          changed: false,
          error: `大纲 ${previous.id} 还有 ${unfinished.length} 个小节未完成（${unfinished.map((s) => s.id).join(', ')}）`,
        };
      }
    }
  }

  /**
   * Walking away from a started step must say why.
   *
   * Two different things can end a run: it finished, or it did not. The first is `done`
   * and needs proof, which the note already carries. The second — blocked, or quietly
   * put back to `todo` — used to need nothing, so a step could be picked up, abandoned,
   * and left looking exactly like one nobody ever touched. The next worker then either
   * redoes it or skips it, and neither of them is a decision anybody can audit.
   */
  if (
    previous.status === 'doing' &&
    patch.status &&
    patch.status !== 'doing' &&
    patch.status !== 'done' &&
    !patch.note?.trim()
  ) {
    return {
      plan: steps,
      changed: false,
      error:
        `${previous.id} 正在做，改成 ${patch.status} 要写明原因（note）：卡在哪里、为什么放弃、下一步靠什么接上。` +
        '没写原因就停下的步骤，接手的人分不清是没做还是做失败了。',
    };
  }

  const next: PlanStep = {
    ...previous,
    ...(patch.title ? { title: patch.title.slice(0, 200) } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.agent ? { agent: patch.agent.slice(0, 60) } : {}),
    ...(patch.note !== undefined ? { note: patch.note.slice(0, 300) } : {}),
    // First time only: later `doing` writes must not move the line that says
    // "this step is history now".
    ...(patch.status === 'doing' && !previous.startedAt ? { startedAt: now } : {}),
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
  /**
   * Hand back a plan whose outlines already agree with their sub-steps.
   *
   * `syncOutlineOf` only fixes the parent of the step that changed, so closing the last sub-step
   * of 1 left 1 reading `doing` in the returned array — correct on the next read (the store derives
   * on load) but wrong in the value the caller renders straight back to the worker. Observed by a
   * test that asserted the returned plan, which is the same value `task_plan` prints.
   */
  return { plan: applyDerivedStatuses(steps), changed: true };
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

/**
 * Where execution stands: a step to work on, or a section to expand first.
 *
 * These were one `undefined` before, and that is why "expand the next outline" never
 * happened. `nextLeg` returned `undefined` for "this section has no sub-steps yet" as well as
 * for "nothing is left", so no caller could tell a gap in the plan from a finished plan, and
 * the only instruction to expand was a sentence in the brief that the worker could skip.
 *
 * Making the two states different *types* means every caller has to decide what an unexpanded
 * section means — and the brief can say it out loud.
 */
export type NextLeg =
  | {
      kind: 'step';
      /** The step that should be worked on next. */
      step: PlanStep;
      /** The outline it belongs to. */
      outline: PlanStep;
      /** Who should do it: the step's own owner, else the task's assignee. */
      agent?: string;
    }
  | {
      kind: 'expand';
      /** The section that has no sub-steps yet, so nothing under it can start. */
      outline: PlanStep;
    };

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
/**
 * Is this step inside what the person authorised?
 *
 * There used to be an answer here — a list of ids, plus a numeric ceiling. It was wrong in a
 * way no bug fix could reach: the boundary was written in a coordinate system the worker
 * itself generates. Outlines are numbered when the task starts, but sub-steps are invented
 * later, per section, from whatever the code turns out to say. So 「做到 2 就停」 was a promise
 * about a namespace that did not exist yet, and 「把那个登录问题修完」 — the shape people
 * actually talk in — cannot be expressed as an id at all, because the work may span two
 * outlines and half of a third.
 *
 * It was also self-defeating. The party being gated could mint ids, so it could satisfy the
 * gate by renaming: add the same work under an authorised id, or remove the steps it did not
 * want to finish (one run did exactly that and reported the task done). A guard that the
 * guarded can rewrite is friction for the honest and decoration for the dishonest.
 *
 * So the boundary is now the model's job — read `spec.directive` and the plan, decide what
 * the person meant. The code's job is what only code can do: keep times, so that 「someone
 * read the reply and wrote down what to do」 is a fact rather than an assumption, and keep a
 * started step from being deleted out of the record.
 */

/**
 * The steps a reader still has to do something about.
 *
 * An outline whose sub-steps are all closed is finished, so it is not on this list — but the
 * four places that computed "remaining" did `status !== 'done'` on flat entries, so a finished
 * section still counted while its stored status lagged one render behind. Observed: the
 * supervisor asked the person to 「放行剩余步骤 1、2」 when every sub-step of 1 was complete.
 */
export function openSteps(plan: PlanStep[] | undefined): PlanStep[] {
  const steps = plan ?? [];
  return steps.filter((step) => {
    if (step.status === 'done') return false;
    // An outline is only open if something under it is.
    const kids = childrenOf(steps, step.id);
    if (kids.length === 0) return true;
    return kids.some((kid) => kid.status !== 'done');
  });
}

/** What a restructure asks for: replace the tail of the outline list. */
export interface RestructureRequest {
  /** The first outline to replace. It and everything after it must be untouched work. */
  fromId: string;
  /**
   * The replacement outlines, in order.
   *
   * Titles only. Sub-steps are expanded later, one section at a time, by `applyPlanPatch` —
   * because that is the only way a section's sub-steps can reflect what the *previous* section
   * actually produced. Generating them all now would re-create the guesswork this is meant to
   * remove.
   */
  outlines: Array<{ id?: string; title: string }>;
}

/**
 * Replace the not-yet-started tail of the outline list.
 *
 * A plan written up front is a guess about work that has not happened. When the first sections
 * show the guess was wrong, the only repair available was `applyPlanPatch`, one step at a time —
 * so in practice nobody repaired it and the plan kept being executed as written. The brief even
 * said 「不要重写」, because there was no safe way to write.
 *
 * Safe here means: only sections that have not started can be replaced. A section with sub-steps
 * is started (they were written because it was about to be worked on), and a `done`/`doing`
 * section is history. Both are refused by name, so a refused restructure tells the worker what
 * it actually tried to overwrite.
 */
export function restructurePlan(
  plan: PlanStep[] | undefined,
  request: RestructureRequest,
  now: number,
): { plan: PlanStep[]; changed: boolean; error?: string } {
  const steps = plan ?? [];
  const from = request.fromId.trim();
  if (!isOutlineStep(from)) {
    return { plan: steps, changed: false, error: `只能从某条大纲开始重排（如 2），收到的是 ${from || '空'}` };
  }
  const titles = request.outlines ?? [];
  if (titles.length === 0) {
    return { plan: steps, changed: false, error: '重排至少要给出一条大纲' };
  }
  for (const [index, item] of titles.entries()) {
    if (!item.title?.trim()) {
      return { plan: steps, changed: false, error: `outlines[${index}] 缺少标题` };
    }
  }

  const fromNum = Number(from);
  const outlines = steps
    .filter((step) => isOutlineStep(step.id))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const replacing = outlines.filter((step) => Number(step.id) >= fromNum);

  for (const step of replacing) {
    if (step.status === 'done') {
      return { plan: steps, changed: false, error: `大纲 ${step.id} 已完成，是记录，不能重排；要改就新开一条` };
    }
    /**
     * 「Can this be rewritten」 is answered by `startedAt`, not by the status.
     *
     * `doing` is derived for the section the plan has arrived at, so the next section that has not
     * been broken down yet reads as `doing` from the moment the one before it closes. Reading that
     * as 「正在做」 refused to restructure a tail nobody had touched — the display convention was
     * being mistaken for history. What actually happened is `startedAt`, and a section with
     * sub-steps was written because it was about to be worked on.
     */
    if (step.startedAt) {
      return {
        plan: steps,
        changed: false,
        error: `大纲 ${step.id} 已经开工过，不能重排；它下面发生的事是记录，要换方向就在后面加大纲`,
      };
    }
    const kids = childrenOf(steps, step.id);
    if (kids.length > 0) {
      return {
        plan: steps,
        changed: false,
        error: `大纲 ${step.id} 已经拆出小节（${kids.map((s) => s.id).join('、')}），说明它已经开工；只能重排还没拆的大纲`,
      };
    }
  }

  /**
   * Ids default to consecutive numbers from `fromId`, which keeps the common case (rewrite the
   * remaining sections, same count) a matter of sending titles.
   */
  const resolved: PlanStep[] = [];
  for (const [index, item] of titles.entries()) {
    const wanted = item.id?.trim() || String(fromNum + index);
    if (!isOutlineStep(wanted)) {
      return { plan: steps, changed: false, error: `大纲 id 必须是数字（如 2），收到 ${wanted}` };
    }
    if (Number(wanted) < fromNum) {
      return { plan: steps, changed: false, error: `大纲 id ${wanted} 在 ${from} 之前，不能这样重排` };
    }
    if (resolved.some((step) => step.id === wanted)) {
      return { plan: steps, changed: false, error: `大纲 id ${wanted} 重复` };
    }
    resolved.push({ id: wanted, title: item.title.trim(), status: 'todo', updatedAt: now });
  }
  const order = resolved.map((step) => Number(step.id));
  for (let i = 1; i < order.length; i += 1) {
    if (order[i]! <= order[i - 1]!) {
      return { plan: steps, changed: false, error: '大纲 id 必须递增' };
    }
  }

  const replacedIds = new Set(replacing.map((step) => step.id));
  const kept = steps.filter((step) => !replacedIds.has(step.id));
  const next = [...kept, ...resolved].sort((a, b) => {
    const left = a.id.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const right = b.id.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const d = (left[i] ?? 0) - (right[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  if (next.length > PLAN_STEP_LIMIT) {
    return { plan: steps, changed: false, error: `计划最多 ${PLAN_STEP_LIMIT} 条` };
  }
  return { plan: next, changed: true };
}

export function nextLeg(plan: PlanStep[] | undefined): NextLeg | undefined {
  if (!plan?.length) return undefined;
  const outlines = plan
    .filter((step) => isOutlineStep(step.id))
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (const outline of outlines) {
    if (outline.status === 'done') continue;
    const kids = childrenOf(plan, outline.id);
    /**
     * A section with no sub-steps stops here, and says so.
     *
     * It is not "nothing to do": it is the point where the worker is supposed to check whether
     * this section and its sub-steps are still right before starting them. Returning
     * `undefined` made that indistinguishable from a finished plan.
     */
    if (kids.length === 0) return { kind: 'expand', outline };
    const step = kids.find((kid) => kid.status !== 'done');
    if (step) return { kind: 'step', step, outline, ...(step.agent ? { agent: step.agent } : {}) };
  }
  return undefined;
}
