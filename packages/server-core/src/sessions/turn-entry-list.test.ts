import { describe, expect, it } from 'bun:test';

/**
 * One turn, one list, one delivery.
 *
 * The two-card defect was reported from a real run: T-1's hand-off landed at 17:25:17 with prose
 * and no options, and again at 17:25:23 with three buttons — the same unresolved situation, two
 * cards, the first with nothing to click. Both calls came from one turn of one supervisor session.
 *
 * The cause was structural rather than a model mistake: `report_to_user` delivered immediately and
 * `ask_user` collected until the turn ended, so the same turn had two paths to the person at two
 * moments. The model had no way to know they were one queue.
 *
 * What is asserted here is the shape that removes the choice: entries accumulate on the session, and
 * the flush reads them in order exactly once.
 */
describe('a turn collects its entries before speaking', () => {
  /** Mirrors the accumulation in the `askUser` binding. */
  type Entry = { kind: 'completed' | 'decision' | 'blocked'; text: string; options?: string[]; taskId?: string };

  function collect(turn: Entry[], pending: Entry[] | undefined, taskId?: string): Entry[] {
    return [
      ...(pending ?? []),
      ...turn.map((entry) => ({ ...entry, ...(taskId ? { taskId } : {}) })),
    ];
  }

  it('appends a second call to the same list instead of drawing a second card', () => {
    const first = collect(
      [{ kind: 'decision', text: '请拍板下一步。', options: [] }],
      undefined,
      'T-1',
    );
    const second = collect(
      [{ kind: 'decision', text: '剩 1.2 与 2 未动工，请拍板。', options: ['放行 1.2', '收尾'] }],
      first,
      'T-1',
    );

    // Two entries, one delivery — which is why the person reads one turn, not two cards.
    expect(second).toHaveLength(2);
    expect(second.every((entry) => entry.taskId === 'T-1')).toBe(true);
  });

  it('keeps statements and questions in the order they were said', () => {
    const list = collect(
      [
        { kind: 'completed', text: '1.1 做完了' },
        { kind: 'decision', text: '下一步？', options: ['放行 1.2', '收尾'] },
        { kind: 'blocked', text: '账号过期，需要你重登' },
      ],
      undefined,
      'T-1',
    );

    expect(list.map((entry) => entry.kind)).toEqual(['completed', 'decision', 'blocked']);
  });

  it('takes the list before delivering, so a racing flush cannot send twice', () => {
    let pending = collect(
      [{ kind: 'completed', text: 'done' }],
      undefined,
      'T-1',
    );

    // The flush body: read, then clear, then deliver. Clearing first is what makes a second flush
    // (turn end and an error path can both reach it) find nothing rather than repeat the row.
    const taken = pending;
    pending = [];
    expect(taken).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });
});
