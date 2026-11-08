import { describe, expect, it } from 'bun:test';

import { formatTaskBrief } from '../brief.ts';
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
