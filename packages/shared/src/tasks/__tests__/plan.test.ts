import { describe, expect, it } from 'bun:test';

import {
  applyPlanPatch,
  checkAgreedPlanAppend,
  currentStep,
  formatPlan,
  lastPlanChangeAt,
  normalizePlan,
  PLAN_STEP_LIMIT,
  planProgress,
  planStalled,
  stepParent,
} from '../plan.ts';

const NOW = 1_800_000_000_000;

describe('plan normalization', () => {
  it('keeps well-formed steps and drops broken ones', () => {
    const plan = normalizePlan(
      [
        { id: '1.0', title: '接口改造', status: 'doing' },
        { id: '', title: 'no id' },
        { id: '2.0', title: '' },
        { id: '3.0', title: '补测试' },
        'nonsense',
      ],
      NOW,
    );
    expect(plan?.map((step) => step.id)).toEqual(['1.0', '3.0']);
    expect(plan?.[0]?.status).toBe('doing');
    expect(plan?.[1]?.status).toBe('todo');
  });

  it('rejects unknown statuses instead of trusting them', () => {
    const plan = normalizePlan([{ id: '1.0', title: 'x', status: 'finished' }], NOW);
    expect(plan?.[0]?.status).toBe('todo');
  });

  it('drops duplicate ids and caps the total', () => {
    const many = Array.from({ length: PLAN_STEP_LIMIT + 10 }, (_, i) => ({
      id: `${i}.0`,
      title: `step ${i}`,
    }));
    const plan = normalizePlan([...many, { id: '0.0', title: 'dup' }], NOW);
    expect(plan).toHaveLength(PLAN_STEP_LIMIT);
  });

  it('returns undefined for an empty or invalid plan', () => {
    expect(normalizePlan([])).toBeUndefined();
    expect(normalizePlan('nope')).toBeUndefined();
  });
});

describe('plan progress', () => {
  it('counts each status and refuses to call an empty plan complete', () => {
    const plan = normalizePlan(
      [
        { id: '1.0', title: 'a', status: 'done' },
        { id: '1.1', title: 'b', status: 'doing' },
        { id: '1.2', title: 'c', status: 'blocked' },
        { id: '1.3', title: 'd', status: 'todo' },
      ],
      NOW,
    );
    const progress = planProgress(plan);
    expect(progress).toMatchObject({ total: 4, done: 1, doing: 1, blocked: 1, ratio: 0.25 });
    expect(progress.complete).toBe(false);
    expect(planProgress(undefined).complete).toBe(false);
  });

  it('reports complete when every step is done', () => {
    const plan = normalizePlan([{ id: '1.0', title: 'a', status: 'done' }], NOW);
    expect(planProgress(plan).complete).toBe(true);
  });

  it('picks the step being worked on, falling back to the next todo', () => {
    const doing = normalizePlan(
      [
        { id: '1.0', title: 'a', status: 'todo' },
        { id: '1.1', title: 'b', status: 'doing' },
      ],
      NOW,
    );
    expect(currentStep(doing)?.id).toBe('1.1');

    const noDoing = normalizePlan([{ id: '1.0', title: 'a', status: 'todo' }], NOW);
    expect(currentStep(noDoing)?.id).toBe('1.0');
    expect(currentStep(undefined)).toBeUndefined();
  });
});

describe('plan editing', () => {
  it('adds an outline item with a new id', () => {
    const result = applyPlanPatch([], { id: '1', title: '读现有实现' }, NOW);
    expect(result.changed).toBe(true);
    expect(result.plan[0]).toMatchObject({ id: '1', title: '读现有实现', status: 'todo' });
  });

  it('refuses to add a step without a title', () => {
    const result = applyPlanPatch([], { id: '1' }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('title');
  });

  it('moves a sub-step to done and stamps the change', () => {
    const start = normalizePlan(
      [
        { id: '1', title: '大纲', status: 'doing' },
        { id: '1.1', title: 'a', status: 'doing' },
      ],
      NOW - 1000,
    );
    const result = applyPlanPatch(start, { id: '1.1', status: 'done', note: '测试通过' }, NOW);
    expect(result.changed).toBe(true);
    expect(result.plan[1]).toMatchObject({ status: 'done', note: '测试通过', updatedAt: NOW });
  });

  it('reports no change when nothing actually changed', () => {
    const start = normalizePlan([{ id: '1', title: 'a', status: 'todo' }], NOW);
    const result = applyPlanPatch(start, { id: '1', status: 'todo' }, NOW);
    expect(result.changed).toBe(false);
  });

  it('removes an unfinished step but keeps a finished one as record', () => {
    const plan = normalizePlan(
      [
        { id: '1.0', title: 'a', status: 'done' },
        { id: '1.1', title: 'b', status: 'todo' },
      ],
      NOW,
    );
    expect(applyPlanPatch(plan, { id: '1.1', remove: true }, NOW).changed).toBe(true);

    const keep = applyPlanPatch(plan, { id: '1.0', remove: true }, NOW);
    expect(keep.changed).toBe(false);
    expect(keep.error).toContain('finished');
  });

  it('reports an unknown step id instead of silently doing nothing', () => {
    const result = applyPlanPatch([], { id: '9.9', remove: true }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('9.9');
  });
});

describe('drift detection', () => {
  it('is not stalled while steps are moving', () => {
    const plan = normalizePlan([{ id: '1.0', title: 'a', status: 'doing' }], NOW - 60_000);
    expect(planStalled(plan, lastPlanChangeAt(plan), NOW, 40 * 60_000)).toBe(false);
  });

  it('is stalled when nothing moved past the threshold', () => {
    const plan = normalizePlan([{ id: '1.0', title: 'a', status: 'doing' }], NOW - 41 * 60_000);
    expect(planStalled(plan, lastPlanChangeAt(plan), NOW, 40 * 60_000)).toBe(true);
  });

  it('never reports a finished plan as stalled', () => {
    const plan = normalizePlan([{ id: '1.0', title: 'a', status: 'done' }], NOW - 41 * 60_000);
    expect(planStalled(plan, lastPlanChangeAt(plan), NOW, 40 * 60_000)).toBe(false);
  });

  it('ignores an absent plan', () => {
    expect(planStalled(undefined, 0, NOW, 1000)).toBe(false);
    expect(lastPlanChangeAt(undefined)).toBe(0);
  });
});

describe('plan rendering', () => {
  it('nests ids by prefix without building a tree', () => {
    expect(stepParent('1.2')).toBe('1');
    expect(stepParent('1')).toBeUndefined();
  });

  it('renders the checklist the way the user writes it', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'done' },
        { id: '1.1', title: '改 handler', status: 'doing', note: '正在跑测试' },
        { id: '2', title: '补测试', status: 'blocked', note: '等接口定稿' },
      ],
      NOW,
    );
    const lines = formatPlan(plan);
    // The box comes first: this is a markdown task list, and the plan is both
    // written and read in that shape. The old assertion locked in
    // `- 1.0 [x] title`, which is not how anyone writes a checklist — the id
    // now trails the title so the box stays where the eye lands.
    expect(lines[0]).toBe('- [>] 接口改造 (1)');
    // Sub-steps are indented so an outline and its steps read as one thing.
    expect(lines[1]!.startsWith('  - [>] 改 handler')).toBe(true);
    expect(lines[2]).toBe('- [!] 补测试 (2) — 等接口定稿');
  });

  it('keeps an outline in step with its sub-steps', () => {
    // The reported bug: 1.1 said 执行中 but 1. still showed the 未执行 icon, and
    // finishing every sub-step never turned 1 green. Both were the same cause —
    // the outline's status was whatever somebody last wrote, and nothing updated
    // it when a child moved.
    const started = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'todo' },
        { id: '1.1', title: '改 handler', status: 'doing' },
      ],
      NOW,
    );
    expect(started?.find((step) => step.id === '1')?.status).toBe('doing');

    const finished = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'todo' },
        { id: '1.1', title: '改 handler', status: 'done', note: '测试通过' },
      ],
      NOW,
    );
    expect(finished?.find((step) => step.id === '1')?.status).toBe('done');
  })

  it('derives the outline on write, not just on read', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'todo' },
        { id: '1.1', title: '改 handler', status: 'todo' },
        { id: '2', title: '补测试', status: 'todo' },
        { id: '2.1', title: '写用例', status: 'todo' },
      ],
      NOW,
    );
    const afterStart = applyPlanPatch(plan, { id: '1.1', status: 'doing' }, NOW).plan;
    expect(afterStart.find((step) => step.id === '1')?.status).toBe('doing');
  })

  it('renders the owner of each stage when one is recorded', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '设计', status: 'done', agent: 'architect' },
        { id: '2', title: '实现', status: 'doing', agent: 'coder' },
      ],
      NOW,
    );
    const lines = formatPlan(plan);
    expect(lines[0]).toBe('- [x] 设计 @architect (1)');
    expect(lines[1]).toContain('@coder');
  });
});

/**
 * The outline model.
 *
 * An outline is written first and stays coarse; its sub-steps are expanded just
 * before that section is worked on. Three rules make that hold:
 *
 *   1. a sub-step needs its outline,
 *   2. an outline is done only when its sub-steps are, and the next outline must
 *      already be broken down before this one closes,
 *   3. a finished step is frozen — rework is a new step, not an edit.
 */
describe('outline invariants', () => {
  it('refuses a sub-step whose outline does not exist', () => {
    const result = applyPlanPatch([], { id: '1.1', title: '改 handler' }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('大纲 1');
  });

  it('accepts a sub-step once its outline exists', () => {
    const withOutline = applyPlanPatch([], { id: '1', title: '接口改造' }, NOW).plan;
    const result = applyPlanPatch(withOutline, { id: '1.1', title: '改 handler' }, NOW);
    expect(result.changed).toBe(true);
    expect(result.plan.map((s) => s.id)).toEqual(['1', '1.1']);
  });

  it('will not start an outline that has no sub-steps', () => {
    const plan = normalizePlan([{ id: '1', title: '接口改造', status: 'todo' }], NOW);
    const result = applyPlanPatch(plan, { id: '1', status: 'doing' }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('还没有小节');
  });

  it('will not close an outline while a sub-step is unfinished', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'doing' },
        { id: '1.1', title: '改 handler', status: 'done' },
        { id: '1.2', title: '补类型', status: 'doing' },
      ],
      NOW,
    );
    const result = applyPlanPatch(plan, { id: '1', status: 'done' }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('1.2');
  });

  it('requires the next outline to be broken down before closing this one', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '接口改造', status: 'doing' },
        { id: '1.1', title: '改 handler', status: 'done' },
        { id: '2', title: '补测试', status: 'todo' },
      ],
      NOW,
    );
    const blocked = applyPlanPatch(plan, { id: '1', status: 'done' }, NOW);
    expect(blocked.changed).toBe(false);
    expect(blocked.error).toContain('2');

    const withNext = applyPlanPatch(plan, { id: '2.1', title: '写单测' }, NOW).plan;
    const allowed = applyPlanPatch(withNext, { id: '1', status: 'done' }, NOW);
    expect(allowed.changed).toBe(true);
  });

  it('closes the last outline without demanding a next one', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '唯一一节', status: 'doing' },
        { id: '1.1', title: '做完它', status: 'done' },
      ],
      NOW,
    );
    // The last outline has no successor to break down, so it is already complete
    // once its only child is: the derivation says so on read, which makes the
    // explicit close idempotent rather than refused. What matters is the state it
    // lands in, not whether the patch claimed to change something.
    const result = applyPlanPatch(plan, { id: '1', status: 'done' }, NOW);
    expect(result.error).toBeUndefined();
    expect(result.plan.find((step) => step.id === '1')?.status).toBe('done');
  });

  it('freezes a finished step against reopening, renaming and owner changes', () => {
    const plan = normalizePlan([{ id: '1', title: '做完了', status: 'done' }], NOW);
    expect(applyPlanPatch(plan, { id: '1', status: 'doing' }, NOW).changed).toBe(false);
    expect(applyPlanPatch(plan, { id: '1', title: '换个名字' }, NOW).changed).toBe(false);
    expect(applyPlanPatch(plan, { id: '1', agent: 'someone' }, NOW).changed).toBe(false);
    expect(applyPlanPatch(plan, { id: '1', remove: true }, NOW).changed).toBe(false);
  });

  it('still lets a finished step record what proved it', () => {
    const plan = normalizePlan([{ id: '1', title: '做完了', status: 'done' }], NOW);
    // Evidence may be added or corrected; the conclusion may not be erased.
    expect(applyPlanPatch(plan, { id: '1', note: 'bun test 全绿' }, NOW).changed).toBe(true);
    expect(applyPlanPatch(plan, { id: '1', note: '' }, NOW).changed).toBe(false);
  });

  it('counts leaves, so a decomposed outline is not counted twice', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '一节', status: 'done' },
        { id: '1.1', title: 'a', status: 'done' },
        { id: '1.2', title: 'b', status: 'todo' },
      ],
      NOW,
    );
    expect(planProgress(plan)).toMatchObject({ total: 2, done: 1, complete: false });
  });
});

describe('a sub-step inherits its section owner', () => {
  /**
   * Observed on a real run: outline 2 and its only sub-step both had no owner, so
   * the board displayed the assignee while routing saw nobody — one field, two
   * answers. A sub-step belongs to the section it lives in, so it takes that
   * section's owner unless it names its own.
   */
  it('takes the outline owner when none is given', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '创建', status: 'todo', agent: 'builtin-default' },
        { id: '1.1', title: '写文件', status: 'todo' },
      ],
      NOW,
    );
    const next = applyPlanPatch(plan, { id: '1.2', title: '读回' }, NOW).plan;
    expect(next.find((step) => step.id === '1.2')?.agent).toBe('builtin-default');
  })

  it('keeps an owner it was given', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '创建', status: 'todo', agent: 'builtin-default' },
        { id: '1.1', title: '写文件', status: 'todo' },
      ],
      NOW,
    );
    const next = applyPlanPatch(plan, { id: '1.2', title: '读回', agent: 'agent-ui' }, NOW).plan;
    expect(next.find((step) => step.id === '1.2')?.agent).toBe('agent-ui');
  })
})

describe('an agreed plan is not the worker\'s to rewrite', () => {
  /**
   * The user asked for two outlines — 「1 写文件」「2 收尾」. The worker wrote three of
   * its own (确认位置 / 创建 / 回报) and the board showed a plan nobody had asked for.
   *
   * `applyPlanPatch` stays permissive on purpose (a task with no plan lets the worker
   * shape one); the refusal at the tool boundary is what enforces agreement, and this
   * records the intent where the plan model lives.
   */
  it('lets a worker extend an agreed outline with sub-steps', () => {
    const plan = normalizePlan(
      [
        { id: '1', title: '写文件', status: 'todo' },
        { id: '2', title: '收尾', status: 'todo' },
      ],
      NOW,
    );
    const next = applyPlanPatch(plan, { id: '1.1', title: '创建 docs/a.md' }, NOW).plan;
    expect(next.find((step) => step.id === '1.1')?.title).toBe('创建 docs/a.md');
    expect(next.filter((step) => !step.id.includes('.')).map((s) => s.id)).toEqual(['1', '2']);
  })
})

describe('an agreed plan is append-only', () => {
  /**
   * The first cut refused *any* new outline, contradicting the plan contract:
   * "steps may be added and removed while the work happens; forcing an accurate plan
   * up front only produces a fake plan". A worker that found a missing step was told
   * it could only work under 1.1 — and because the refusal fired inside a batch, the
   * earlier steps had already been written, leaving a half-applied plan.
   */
  const plan = () =>
    normalizePlan(
      [
        { id: '1', title: '创建 docs/a.md', status: 'todo' },
        { id: '2', title: '验收检查（本轮不做）', status: 'todo' },
      ],
      NOW,
    )!

  it('allows appending after the agreed outlines', () => {
    expect(checkAgreedPlanAppend(plan(), '3', true)).toBeUndefined()
  })

  it('refuses inserting before the agreed order', () => {
    const blocked = checkAgreedPlanAppend(plan(), '0', true)
    expect(blocked).toContain('追加')
    expect(blocked).toContain('1 创建 docs/a.md')
  })

  it('refuses a gap that renumbers between agreed outlines', () => {
    const sparse = normalizePlan(
      [
        { id: '1', title: 'a', status: 'todo' },
        { id: '3', title: 'c', status: 'todo' },
      ],
      NOW,
    )!
    expect(checkAgreedPlanAppend(sparse, '2', true)).toContain('追加')
  })

  it('leaves sub-steps alone — that is where the worker works', () => {
    expect(checkAgreedPlanAppend(plan(), '1.1', true)).toBeUndefined()
  })

  it('leaves a worker-shaped plan completely free', () => {
    expect(checkAgreedPlanAppend(plan(), '0', undefined)).toBeUndefined()
  })
})
