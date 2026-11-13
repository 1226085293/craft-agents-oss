import { describe, expect, it } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { handleAskUser, handleTaskPlan } from './agent-tools.ts';

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

type Payload = { entries: Array<{ kind: string; text: string; options?: string[] }>; taskId?: string };

function askCtx(seen: Payload[]): SessionToolContext {
  return {
    sessionId: 'sess-1',
    agentTools: {
      askUser: async (payload: Payload) => {
        seen.push(payload);
      },
    },
  } as unknown as SessionToolContext;
}

describe('ask_user is the one channel to the person', () => {
  /**
   * There used to be two tools and the code called them 「two spellings of one thing」.
   *
   * A supervisor picked the one whose shape read like 「汇报」 and called it twice in one turn for
   * one unresolved situation — 17:25:17 with prose and no options, 17:25:23 with three buttons —
   * and the person got two cards for one question, the first with nothing to click.
   */
  it('takes the whole turn as one list', async () => {
    const seen: Payload[] = [];
    const result = await handleAskUser(askCtx(seen), {
      entries: [
        { kind: 'completed', text: '1.1 做完了' },
        { kind: 'decision', text: '下一步？', options: ['放行 1.2', '收尾'] },
      ],
      taskId: 'T-1',
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.entries).toHaveLength(2);
    expect(seen[0]!.taskId).toBe('T-1');
    expect(textOf(result)).toContain('1 条问题');
    expect(textOf(result)).toContain('1 条汇报');
  });

  /**
   * A decision with no buttons is a question waiting to be misread — it is what makes the model
   * come back a second time with the answers it had not thought of yet.
   */
  it('refuses a decision with nothing to click', async () => {
    const seen: Payload[] = [];
    const result = await handleAskUser(askCtx(seen), {
      entries: [{ kind: 'decision', text: '请拍板下一步。' }],
    } as never);

    expect(seen).toHaveLength(0);
    expect(textOf(result)).toContain('needs `options`');
  });

  it('refuses options on a statement', async () => {
    const seen: Payload[] = [];
    const result = await handleAskUser(askCtx(seen), {
      entries: [{ kind: 'completed', text: 'done', options: ['a'] }],
    } as never);

    expect(seen).toHaveLength(0);
    expect(textOf(result)).toContain('take no options');
  });

  it('refuses to say the same thing twice, once as prose and once as a button', async () => {
    const seen: Payload[] = [];
    const result = await handleAskUser(askCtx(seen), {
      entries: [
        {
          kind: 'decision',
          text: '请拍板：放行剩余步骤，把任务做完，或者到此为止。',
          options: ['放行剩余步骤，把任务做完', '到此为止，结束任务'],
        },
      ],
    } as never);

    expect(seen).toHaveLength(0);
    expect(textOf(result)).toContain('Do not repeat the options inside');
  });

  /**
   * The count refusal outlived the schema's own `max(2)` by accident, and a supervisor that hit it
   * wrote 「第 3 个因为工具单次最多承载 2 个，我默认按不加处理」 — a decision taken on the person's
   * behalf because of our limit. No cap means no cap anywhere.
   */
  it('takes more entries than the old limit of two', async () => {
    const seen: Payload[] = [];
    const result = await handleAskUser(askCtx(seen), {
      entries: [
        { kind: 'decision', text: '第一个？', options: ['a', 'b'] },
        { kind: 'decision', text: '第二个？', options: ['c', 'd'] },
        { kind: 'decision', text: '第三个？', options: ['e', 'f'] },
        { kind: 'blocked', text: '账号过期，需要你重登' },
      ],
    } as never);

    expect(seen[0]!.entries).toHaveLength(4);
    expect(textOf(result)).toContain('3 条问题');
  });


  /**
   * A periodic message is not a question.
   *
   * Live: 「每分钟发个你好+0，数字每次累加」 was delivered as `decision` cards — the only kind that could
   * carry text without ending the task — so every round asked 「shall I stop?」, and because one turn's
   * ask_user replaces the previous one, 「你好+1」 was overwritten by 「你好+2」 and never arrived.
   */
  it('accepts a notice and does not count it as a question', async () => {
    const seen: Payload[] = []
    const result = await handleAskUser(askCtx(seen), {
      entries: [{ kind: 'notice', text: '你好+1' }],
    } as never)

    expect(seen[0]!.entries).toEqual([{ kind: 'notice', text: '你好+1' }])
    expect(textOf(result)).not.toContain('条问题')
  })

  it('refuses options on a notice, which is a statement', async () => {
    const seen: Payload[] = []
    const result = await handleAskUser(askCtx(seen), {
      entries: [{ kind: 'notice', text: '你好+1', options: ['停', '继续'] }],
    } as never)

    expect(textOf(result)).toContain('take no options')
    expect(seen).toHaveLength(0)
  })

  it('rejects an empty list and blank text', async () => {
    const seen: Payload[] = [];
    expect(textOf(await handleAskUser(askCtx(seen), { entries: [] } as never))).toContain('at least one');
    expect(
      textOf(await handleAskUser(askCtx(seen), { entries: [{ kind: 'completed', text: '  ' }] } as never)),
    ).toContain('non-empty');
    expect(seen).toHaveLength(0);
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

describe('task_plan can be read, not only written', () => {
  /**
   * A worker looking at the plan called `task_plan({identifier})` and got `id is required`,
   * then `task_plan({identifier, id:'2'})` and got `a new step needs a title`. Two failed
   * writes to answer one read. Reading costs nothing and cannot corrupt a plan.
   */
  const ctx = (plan: Array<{ id: string; title: string; status: string }>) =>
    ({
      sessionId: 'sess-1',
      taskTools: {
        get: async () => ({ spec: { plan } }),
        updatePlan: async () => ({ ok: true, plan }),
      },
    }) as unknown as SessionToolContext;

  it('returns the whole plan when called with only an identifier', async () => {
    const result = await handleTaskPlan(
      ctx([
        { id: '1', title: '写文件', status: 'done' },
        { id: '1.1', title: '创建 docs/a.md', status: 'done' },
        { id: '2', title: '收尾', status: 'todo' },
      ]),
      { identifier: 'T-1' } as never,
    );
    const text = textOf(result);
    expect(text).toContain('1 写文件');
    expect(text).toContain('2 收尾');
    expect(text).not.toContain('id is required');
  })

  it('says so when the plan is still empty', async () => {
    const result = await handleTaskPlan(ctx([]), { identifier: 'T-1' } as never);
    expect(textOf(result)).toContain('还没有任何步骤');
  })

  it('reports an unknown task instead of an empty plan', async () => {
    const missing = {
      sessionId: 's',
      taskTools: { get: async () => null, updatePlan: async () => ({ ok: false }) },
    };
    const result = await handleTaskPlan(missing as unknown as SessionToolContext, {
      identifier: 'T-9',
    } as never);
    expect(textOf(result)).toContain('not found');
  })
})
