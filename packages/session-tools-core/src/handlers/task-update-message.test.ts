import { describe, expect, it } from 'bun:test';

import { handleTaskUpdate } from './agent-tools.ts';
import type { SessionToolContext } from '../context.ts';

/**
 * `task_update` has to say what it wrote AND whether the status moved.
 *
 * The old answer was `Task T-1 → paused.` and nothing else. A supervisor that had only stored the
 * user's authorisation read that as 「I paused the task」 and told the person so — while the task had
 * been paused for a different reason all along. Observed on T-1 at 14:29:41: the directive was
 * written, the status never changed, and the sentence named only the second fact.
 */
function ctx(update: (id: string, patch: Record<string, unknown>) => Promise<{ status: string; previousStatus: string }>) {
  return {
    taskTools: {
      update: async (id: string, patch: Record<string, unknown>) => update(id, patch),
    },
  } as unknown as SessionToolContext;
}

const textOf = (result: { content?: Array<{ text?: string }> }): string =>
  (result.content ?? []).map((part) => part.text ?? '').join('');

describe('task_update message', () => {
  it('says what was written and that the status did not move', async () => {
    const result = await handleTaskUpdate(
      ctx(async () => ({ status: 'paused', previousStatus: 'paused' })),
      { identifier: 'T-1', directive: '只做 1.2，做完停下' },
    );

    const text = textOf(result);
    expect(text).toContain('授权指令');
    expect(text).toContain('状态未变，仍是 paused');
    // The reader must not be left thinking this call caused the pause.
    expect(text).not.toMatch(/→ paused/);
  });

  it('names both ends when the status did move', async () => {
    const result = await handleTaskUpdate(
      ctx(async () => ({ status: 'running', previousStatus: 'paused' })),
      { identifier: 'T-1', status: 'running' },
    );

    const text = textOf(result);
    expect(text).toContain('状态 paused → running');
    expect(text).not.toContain('状态未变');
  });

  it('points at dispatch when an annotation left the task paused', async () => {
    const result = await handleTaskUpdate(
      ctx(async () => ({ status: 'paused', previousStatus: 'paused' })),
      { identifier: 'T-1', scope: '创建 docs/a.md' },
    );

    expect(textOf(result)).toContain('dispatch');
  });

  it('lists every field it wrote, so nothing looks silently dropped', async () => {
    const result = await handleTaskUpdate(
      ctx(async () => ({ status: 'paused', previousStatus: 'paused' })),
      {
        identifier: 'T-1',
        directive: '继续做完',
        scope: '收尾',
        pauseReason: 'awaiting_release',
        acceptance: [{ check: 'docs/a.md 非空' }],
      },
    );

    const text = textOf(result);
    for (const part of ['授权指令', '范围', '暂停原因 awaiting_release', '验收项']) {
      expect(text).toContain(part);
    }
  });

  it('says so when the patch carried nothing writable', async () => {
    const result = await handleTaskUpdate(
      ctx(async () => ({ status: 'backlog', previousStatus: 'backlog' })),
      { identifier: 'T-1' },
    );

    expect(textOf(result)).toContain('没有可写入的字段');
  });
});
