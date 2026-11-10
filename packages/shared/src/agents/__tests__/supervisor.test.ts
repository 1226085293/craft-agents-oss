import { describe, expect, it } from 'bun:test';

import {
  assertDispatchAllowed,
  DispatchRefused,
  EventBacklog,
  formatBacklogNudge,
  MAX_DISPATCHES_PER_TURN,
  MAX_QUEUED_EVENTS,
  MAX_SPAWN_DEPTH,
  newGuardState,
  newTurnState,
  normalizeInstruction,
  similarity,
} from '../supervisor.ts';

describe('instruction normalization', () => {
  it('ignores whitespace and punctuation', () => {
    expect(normalizeInstruction('  跑一下 测试。 ')).toBe(normalizeInstruction('跑一下测试'));
  });

  it('treats different work as dissimilar', () => {
    expect(similarity(normalizeInstruction('改前端'), normalizeInstruction('补测试'))).toBeLessThan(0.5);
  });

  it('treats the same work as identical', () => {
    const a = normalizeInstruction('修一下 登录 报错');
    const b = normalizeInstruction('修一下登录报错！');
    expect(similarity(a, b)).toBe(1);
  });
});

describe('dispatch guards', () => {
  /** Each case gets its own guard state; the guard is what outlives turns. */
  const base = { spawnDepth: 0, targetKey: 'sess_a', instruction: '改前端样式', parallel: true };
  const withState = (state = newTurnState()) => ({ ...base, state, guard: newGuardState() });

  it('allows a normal dispatch and counts it', () => {
    const state = newTurnState();
    assertDispatchAllowed(withState(state));
    expect(state.dispatchesThisTurn).toBe(1);
  });

  it('refuses past the depth cap', () => {
    const state = newTurnState();
    expect(() => assertDispatchAllowed({ ...withState(state), spawnDepth: MAX_SPAWN_DEPTH })).toThrow(
      DispatchRefused,
    );
  });

  it('refuses a fourth parallel dispatch', () => {
    const state = newTurnState();
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN; i += 1) {
      assertDispatchAllowed({ ...withState(state), targetKey: `sess_${i}`, instruction: `任务 ${i}` });
    }
    expect(() => assertDispatchAllowed({ ...withState(state), targetKey: 'sess_x' })).toThrow(DispatchRefused);
  });

  it('does not count sequential dispatches against the parallel cap', () => {
    const state = newTurnState();
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN + 2; i += 1) {
      assertDispatchAllowed({ ...withState(state), parallel: false, targetKey: `sess_${i}`, instruction: `任务 ${i}` });
    }
    expect(state.dispatchesThisTurn).toBe(MAX_DISPATCHES_PER_TURN + 2);
  });

  it('refuses to send the same instruction twice (ping-pong guard)', () => {
    const state = newTurnState();
    const guard = newGuardState();
    assertDispatchAllowed({ ...base, state, guard, parallel: false });
    // Second identical send is tolerated (it may be a legitimate retry) …
    assertDispatchAllowed({ ...base, state, guard, parallel: false, instruction: '改前端样式！' });
    // … the third is refused.
    expect(() => assertDispatchAllowed({ ...base, state, guard, parallel: false })).toThrow(DispatchRefused);
  });

  it('resets the repeat counter when the instruction changes', () => {
    const state = newTurnState();
    const guard = newGuardState();
    assertDispatchAllowed({ ...base, state, guard, parallel: false });
    assertDispatchAllowed({ ...base, state, guard, parallel: false });
    assertDispatchAllowed({ ...base, state, guard, parallel: false, instruction: '换成改后端' });
    assertDispatchAllowed({ ...base, state, guard, parallel: false });
    expect(guard.repeatedSendCount.get('sess_a')).toBe(1);
  });

  /**
   * The reason the two kinds of state are separate.
   *
   * A supervisor that repeats itself usually does so once per turn — each turn looks reasonable
   * on its own. If the guard were reset with the turn counters, this loop would never be caught,
   * and before this split `beginTurn` had no callers at all: calling it would have retired the
   * guard.
   */
  it('keeps catching a repeat that spans turns', () => {
    const guard = newGuardState();
    // Two turns may repeat it — a retry is legitimate.
    for (let turn = 0; turn < 2; turn += 1) {
      const state = newTurnState();
      assertDispatchAllowed({ ...base, state, guard, parallel: false });
    }
    // The third turn is the loop, and it is a new turn in every respect except the guard.
    const third = newTurnState();
    expect(() => assertDispatchAllowed({ ...base, state: third, guard, parallel: false })).toThrow(
      DispatchRefused,
    );
  });

  it('forgets the fan-out count when a turn starts', () => {
    const state = newTurnState();
    const guard = newGuardState();
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN; i += 1) {
      assertDispatchAllowed({ ...base, state, guard, targetKey: `sess_${i}`, instruction: `任务 ${i}` });
    }
    // The cap is about one turn, so a new turn must be able to dispatch again.
    const next = newTurnState();
    assertDispatchAllowed({ ...base, state: next, guard, targetKey: 'sess_new', instruction: '新任务' });
    expect(next.dispatchesThisTurn).toBe(1);
  });
});

describe('event backlog', () => {
  it('dedupes by id and drains once', () => {
    const backlog = new EventBacklog();
    backlog.push({ id: 'e1', summary: '新邮件' });
    backlog.push({ id: 'e1', summary: '新邮件' });
    backlog.push({ id: 'e2', summary: 'CI 失败' });
    expect(backlog.size).toBe(2);

    const items = backlog.drain();
    expect(items).toHaveLength(2);
    expect(backlog.size).toBe(0);
  });

  it('stays bounded and reports the overflow', () => {
    const backlog = new EventBacklog();
    for (let i = 0; i < MAX_QUEUED_EVENTS + 5; i += 1) {
      backlog.push({ id: `e${i}`, summary: `事件 ${i}` });
    }
    expect(backlog.size).toBe(MAX_QUEUED_EVENTS);
    const items = backlog.drain();
    expect(items[0]?.summary).toContain('另有 5 条较早事件已合并');
  });

  it('formats a single nudge for a batch instead of one per event', () => {
    expect(formatBacklogNudge([{ id: 'e1', summary: '新邮件' }])).toContain('有一条未处理的事件');
    const many = formatBacklogNudge([
      { id: 'e1', summary: 'a' },
      { id: 'e2', summary: 'b' },
    ]);
    expect(many).toContain('有 2 条未处理的事件');
    expect(many).toContain('id: e2');
  });

  it('returns an empty string for an empty batch', () => {
    expect(formatBacklogNudge([])).toBe('');
  });
});

/**
 * There is no per-turn cap any more — see the note at the top of supervisor.ts.
 * What used to be here (`SUPERVISOR_TURN_TIMEOUT_MS`, the env override) asserted
 * the shape of a mechanism that no longer exists, so it went with it. The
 * behaviours that replaced it live in the server-core suites:
 * `supervisor-runtime.test.ts` pins "every wake path hands over the backlog".
 */
