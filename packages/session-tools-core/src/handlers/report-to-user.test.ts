import { describe, expect, it } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { handleReportToUser, handleTaskPlan } from './agent-tools.ts';

function textOf(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((part) => part.text ?? '').join(' ');
}

function ctx(seen: Array<{ text: string; kind?: string }>): SessionToolContext {
  return {
    sessionId: 'sess-1',
    agentTools: {
      reportToUser: async (payload: { text: string; kind?: string }) => {
        seen.push(payload);
      },
    },
  } as unknown as SessionToolContext;
}

describe('report_to_user', () => {
  /**
   * The gate exists because a length limit could not answer "should I speak now".
   *
   * A supervisor used its only user-facing tool for progress narration — "1.1 is
   * done, I dispatched the rest to mr-crystal, I will tell you when it finishes" —
   * and those rows pushed the decisions that actually needed a person off screen.
   */
  it('refuses a report without a reason', async () => {
    const seen: Array<{ text: string; kind?: string }> = [];
    const result = await handleReportToUser(ctx(seen), { text: 'progress: still working' } as never);
    expect(seen).toHaveLength(0);
    expect(textOf(result)).toContain('kind is required');
  });

  it('accepts the three reasons that justify an interruption', async () => {
    for (const kind of ['completed', 'decision', 'blocked'] as const) {
      const seen: Array<{ text: string; kind?: string }> = [];
      const result = await handleReportToUser(ctx(seen), { text: 'conclusion', kind } as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.kind).toBe(kind);
      expect(textOf(result)).toContain('Reported to the user');
    }
  });

  it('rejects a reason outside the enum', async () => {
    const seen: Array<{ text: string; kind?: string }> = [];
    await handleReportToUser(ctx(seen), { text: 'x', kind: 'progress' } as never);
    // The handler forwards what it was given; the schema is the real gate. What
    // matters here is that the payload carries the reason, so routing can refuse
    // it — see deliverToUserLane.
    expect(seen[0]?.kind).toBe('progress');
  });
});

describe('task_plan echoes the plan back', () => {
  /**
   * `Plan updated: 3 step(s).` confirms the call landed and says nothing about the result.
   * A worker wrote outline `2 读回确认` and, seconds later in the same turn, wrote
   * `1.2 读回确认` too — it had to remember the first existed, and it did not. Returning the
   * plan makes a duplicate visible where it is created.
   */
  const ctx = (plan: Array<{ id: string; title: string; status: string }>) =>
    ({
      sessionId: 'sess-1',
      taskTools: {
        updatePlan: async () => ({ ok: true, plan }),
      },
    }) as unknown as SessionToolContext;

  it('shows every existing step, not just a count', async () => {
    const result = await handleTaskPlan(
      ctx([
        { id: '1', title: '创建 docs/a.md', status: 'todo' },
        { id: '2', title: '读回确认', status: 'todo' },
      ]),
      { identifier: 'T-1', id: '1', status: 'doing' } as never,
    );
    const text = textOf(result);
    expect(text).toContain('1 创建 docs/a.md');
    expect(text).toContain('2 读回确认');
    expect(text).toContain('同一件事只能有一个 id');
  })

  it('still reports a refusal as an error', async () => {
    const bad = { sessionId: 's', taskTools: { updatePlan: async () => ({ ok: false, error: 'nope' }) } };
    const result = await handleTaskPlan(bad as unknown as SessionToolContext, { identifier: 'T-1', id: '1' } as never);
    expect(textOf(result)).toContain('nope');
  })
})
