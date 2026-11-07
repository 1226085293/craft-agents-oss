import { describe, expect, it } from 'bun:test';

import {
  applyPlanPatch,
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
  it('adds a step with a new id', () => {
    const result = applyPlanPatch([], { id: '1.0', title: '读现有实现' }, NOW);
    expect(result.changed).toBe(true);
    expect(result.plan[0]).toMatchObject({ id: '1.0', title: '读现有实现', status: 'todo' });
  });

  it('refuses to add a step without a title', () => {
    const result = applyPlanPatch([], { id: '1.0' }, NOW);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('title');
  });

  it('moves a step to done and stamps the change', () => {
    const start = normalizePlan([{ id: '1.0', title: 'a', status: 'todo' }], NOW - 1000);
    const result = applyPlanPatch(start, { id: '1.0', status: 'done', note: '测试通过' }, NOW);
    expect(result.changed).toBe(true);
    expect(result.plan[0]).toMatchObject({ status: 'done', note: '测试通过', updatedAt: NOW });
  });

  it('reports no change when nothing actually changed', () => {
    const start = normalizePlan([{ id: '1.0', title: 'a', status: 'todo' }], NOW);
    const result = applyPlanPatch(start, { id: '1.0', status: 'todo' }, NOW);
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
        { id: '1.0', title: '接口改造', status: 'done' },
        { id: '1.1', title: '改 handler', status: 'doing', note: '正在跑测试' },
        { id: '2.0', title: '补测试', status: 'blocked', note: '等接口定稿' },
      ],
      NOW,
    );
    const lines = formatPlan(plan);
    // The box comes first: this is a markdown task list, and the plan is both
    // written and read in that shape. The old assertion locked in
    // `- 1.0 [x] title`, which is not how anyone writes a checklist — the id
    // now trails the title so the box stays where the eye lands.
    expect(lines[0]).toBe('- [x] 接口改造 (1.0)');
    expect(lines[1]).toContain('[>]');
    expect(lines[1]).toContain('改 handler');
    expect(lines[2]).toContain('[!]');
  });

  it('renders the owner of each stage when one is recorded', () => {
    const plan = normalizePlan(
      [
        { id: '1.0', title: '设计', status: 'done', agent: 'architect' },
        { id: '2.0', title: '实现', status: 'doing', agent: 'coder' },
      ],
      NOW,
    );
    const lines = formatPlan(plan);
    expect(lines[0]).toBe('- [x] 设计 @architect (1.0)');
    expect(lines[1]).toContain('@coder');
  });
});
