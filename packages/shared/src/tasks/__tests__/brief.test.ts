import { describe, expect, it } from 'bun:test';

import { formatDispatchTaskContext, formatPlanRuleBlock, formatTaskBrief } from '../brief.ts';
import type { Task } from '../types.ts';

const NOW = 1_800_000_000_000;

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'T-1',
  name: '状态图标验证',
  instruction: '创建 docs/a.md',
  status: 'running',
  pauseReason: null,
  supervisorSessionId: 'sup',
  sessionIds: ['s1'],
  currentSessionId: 's1',
  dependsOn: [],
  priority: 1,
  budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
  handoffs: [],
  verify: { enabled: false, maxIterations: 2 },
  lifecycle: { errorCount: 0, consecutiveFailures: 0 },
  origin: { supervisorSessionId: 'sup', toolCallId: 'c1' },
  heartbeatIntervalMin: 10,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('the brief always states the current plan', () => {
  /**
   * "No plan field" and "an empty plan" read identically unless the empty case is said
   * out loud. A worker that cannot tell whether anything has been agreed writes its own
   * outlines — which is how a second 「读回确认」 appeared beside the one already in 1.2.
   */
  it('says the plan is empty when nothing has been written', () => {
    const text = formatTaskBrief(task());
    expect(text).toContain('## 当前执行计划');
    expect(text).toContain('还没有任何步骤');
  })

  it('lists the steps when a plan exists', () => {
    const text = formatTaskBrief(
      task({
        spec: {
          plan: [
            { id: '1', title: '写文件', status: 'done' },
            { id: '2', title: '收尾', status: 'todo' },
          ],
        },
      }),
    )
    expect(text).toContain('## 当前执行计划');
    expect(text).toContain('写文件');
    expect(text).not.toContain('还没有任何步骤')
  })

  it('marks the appended-only rule for an agreed plan', () => {
    const text = formatTaskBrief(
      task({
        spec: {
          planAgreed: true,
          plan: [{ id: '1', title: '写文件', status: 'todo' }],
        },
      }),
    )
    expect(text).toContain('末尾追加');
  })

  it('tells the worker not to plan the same thing twice', () => {
    // The rule needs a criterion, not an adjective: one action, one id.
    const text = formatTaskBrief(task())
    expect(text).toContain('同一件事只能有一个 id')
  })
})

describe('the plan is a record, not a draft', () => {
  /**
   * Rule 1 used to say 「先用一次 task_plan 写下大纲：3–7 条」 unconditionally — so a worker
   * whose task already had an agreed plan was told to write a new one anyway. One worker
   * resolved that conflict by writing outline `2 读回确认` and then `1.2 读回确认` in the
   * same turn. Steps change because the plan was wrong or something is missing, never
   * because work is starting.
   */
  it('tells a worker with no plan to write one', () => {
    const text = formatPlanRuleBlock({ planExists: false });
    expect(text).toContain('计划还没有');
    expect(text).toContain('3–7 条');
  })

  it('tells a worker with a plan not to rewrite it', () => {
    const text = formatPlanRuleBlock({ planExists: true });
    expect(text).toContain('不要重写');
    expect(text).not.toContain('先写');
    // The criterion, not an adjective: two reasons to change a step.
    expect(text).toContain('写错了');
    expect(text).toContain('漏了一步');
  })

  it('ships the plan with the rules when dispatching', () => {
    const text = formatDispatchTaskContext({
      spec: { plan: [{ id: '1', title: '写文件', status: 'todo' }] } as never,
    });
    // Rules that say 「不要重写计划」 are useless without the plan to not rewrite.
    expect(text).toContain('当前执行计划');
    expect(text).toContain('写文件');
    expect(text).toContain('不要重写');
  })

  it('still gives the rules when the task has no plan yet', () => {
    const text = formatDispatchTaskContext({ spec: undefined });
    expect(text).not.toContain('当前执行计划');
    expect(text).toContain('计划还没有');
  })
})
