import { describe, expect, it } from 'bun:test';

import { handleListQuestions } from './agent-tools.ts';
import type { SessionToolContext } from '../context.ts';

/**
 * The reader for the question queue.
 *
 * It exists because deciding whether two phrasings are one question is interpretation. The old
 * answer was `normalizeQuestion`, which compared the sentences a person would read with
 * punctuation stripped — it could only catch a literal repeat, and a supervisor that re-read the
 * task and rewrote the question produced two cards for one unresolved situation. Giving the asker
 * the list replaces a guess the code could only lose with a fact it can read.
 */
type Row = {
  taskId: string;
  id: string;
  question: string;
  options?: string[];
  label?: string;
  askedAt: number;
};

function ctx(rows: Row[], seen: Array<{ taskId?: string }>) {
  return {
    agentTools: {
      listQuestions: async (payload: { taskId?: string }) => {
        seen.push(payload);
        return rows;
      },
    },
  } as unknown as SessionToolContext;
}

const textOf = (result: { content?: Array<{ text?: string }> }): string =>
  (result.content ?? []).map((part) => part.text ?? '').join('');

const row = (over: Partial<Row> = {}): Row => ({
  taskId: 'T-1',
  id: 'd-1',
  question: '要不要做 2？',
  askedAt: 1,
  ...over,
});

describe('list_questions', () => {
  /**
   * An empty list means 「nothing new to ask」, not 「nothing was ever asked」.
   *
   * The turn-end flush clears the list, so this is also the state the next turn starts in — which
   * is what stops the same batch of questions going out twice.
   */
  it('says the list is empty when nothing is waiting to be sent', async () => {
    const result = await handleListQuestions(ctx([], []), {});
    expect(textOf(result)).toContain('The question list is empty');
  });

  it('names the task and the options, so an answer can be given from the list alone', async () => {
    const result = await handleListQuestions(
      ctx([row({ options: ['做', '不做'], label: '需要拍板' })], []),
      {},
    );

    const text = textOf(result);
    expect(text).toContain('[T-1]');
    expect(text).toContain('要不要做 2？');
    expect(text).toContain('做 / 不做');
    expect(text).toContain('需要拍板');
  });

  it('marks every row as still to be sent — a shown question has left the list', async () => {
    const text = textOf(await handleListQuestions(ctx([row()], []), {}));
    expect(text).toContain('本轮结束时发出');
    expect(text).not.toContain('已发给用户');
  });

  it('passes a named task through and omits it otherwise', async () => {
    const seen: Array<{ taskId?: string }> = [];
    await handleListQuestions(ctx([], seen), { taskId: ' T-2 ' });
    await handleListQuestions(ctx([], seen), {});

    expect(seen[0]).toEqual({ taskId: 'T-2' });
    expect(seen[1]).toEqual({});
  });

  it('numbers the rows, so a reply can point at one', async () => {
    const result = await handleListQuestions(
      ctx([row(), row({ id: 'd-2', question: '验收标准要改吗？' })], []),
      {},
    );
    const text = textOf(result);
    expect(text).toContain('1. [T-1]');
    expect(text).toContain('2. [T-1]');
  });
});
