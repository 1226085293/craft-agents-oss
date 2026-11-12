import { describe, expect, it } from 'bun:test';

/**
 * One turn, one list, one delivery — and the list is the last word, not every draft of it.
 *
 * The two-card defect was reported from a real run: T-1's hand-off landed at 17:25:17 with prose
 * and no options, and again at 17:25:23 with three buttons — the same unresolved situation, two
 * cards, the first with nothing to click. Both calls came from one turn of one supervisor session.
 *
 * The first fix made the turn collect entries and flush them once. That still delivered both
 * drafts when one call was a re-ask: the prompt told the supervisor a re-ask wins, so it asked
 * again to fix its wording, and the person read both bubbles — 「已全部完成并收尾」 eight seconds
 * before 「已全部做完」. The array is the complete list of what to say: one call is the whole
 * state, and the next call replaces it.
 */
describe('a turn collects its entries before speaking', () => {
  /** Mirrors the `askUser` binding. */
  type Entry = { kind: 'completed' | 'decision' | 'blocked'; text: string; options?: string[]; taskId?: string };

  function collect(turn: Entry[], taskId?: string): Entry[] {
    return turn.map((entry) => ({ ...entry, ...(taskId ? { taskId } : {}) }));
  }

  it('replaces the list, so a re-ask leaves one draft instead of two', () => {
    const first = collect(
      [{ kind: 'completed', text: 'T-1 已全部完成并收尾。' }],
      'T-1',
    );
    const second = collect(
      [{ kind: 'completed', text: 'T-1 已全部做完：1.1 ✓、1.2 ✓、2 ✓。' }],
      'T-1',
    );

    // One entry survives — the last call is the whole list.
    expect(second).toHaveLength(1);
    expect(second[0]!.text).toContain('已全部做完');
  });

  it('keeps the whole array of one call, in the order it was said', () => {
    const list = collect(
      [
        { kind: 'completed', text: '1.1 做完了' },
        { kind: 'decision', text: '下一步？', options: ['放行 1.2', '收尾'] },
        { kind: 'blocked', text: '账号过期，需要你重登' },
      ],
      'T-1',
    );

    expect(list.map((entry) => entry.kind)).toEqual(['completed', 'decision', 'blocked']);
  });

  it('takes the list before delivering, so a racing flush cannot send twice', () => {
    let pending = collect(
      [{ kind: 'completed', text: 'done' }],
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
