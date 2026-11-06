import { describe, expect, it } from 'bun:test';

import {
  assertDispatchAllowed,
  DispatchRefused,
  EventBacklog,
  formatBacklogNudge,
  getSupervisorTurnTimeoutMs,
  MAX_DISPATCHES_PER_TURN,
  MAX_QUEUED_EVENTS,
  MAX_SPAWN_DEPTH,
  newTurnState,
  normalizeInstruction,
  similarity,
  SUPERVISOR_TURN_TIMEOUT_MS,
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
  const base = { spawnDepth: 0, targetKey: 'sess_a', instruction: '改前端样式', parallel: true };

  it('allows a normal dispatch and counts it', () => {
    const state = newTurnState();
    assertDispatchAllowed({ ...base, state });
    expect(state.dispatchesThisTurn).toBe(1);
  });

  it('refuses past the depth cap', () => {
    const state = newTurnState();
    expect(() => assertDispatchAllowed({ ...base, state, spawnDepth: MAX_SPAWN_DEPTH })).toThrow(
      DispatchRefused,
    );
  });

  it('refuses a fourth parallel dispatch', () => {
    const state = newTurnState();
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN; i += 1) {
      assertDispatchAllowed({ ...base, state, targetKey: `sess_${i}`, instruction: `任务 ${i}` });
    }
    expect(() => assertDispatchAllowed({ ...base, state, targetKey: 'sess_x' })).toThrow(DispatchRefused);
  });

  it('does not count sequential dispatches against the parallel cap', () => {
    const state = newTurnState();
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN + 2; i += 1) {
      assertDispatchAllowed({ ...base, state, parallel: false, targetKey: `sess_${i}`, instruction: `任务 ${i}` });
    }
    expect(state.dispatchesThisTurn).toBe(MAX_DISPATCHES_PER_TURN + 2);
  });

  it('refuses to send the same instruction twice (ping-pong guard)', () => {
    const state = newTurnState();
    assertDispatchAllowed({ ...base, state, parallel: false });
    // Second identical send is tolerated (it may be a legitimate retry) …
    assertDispatchAllowed({ ...base, state, parallel: false, instruction: '改前端样式！' });
    // … the third is refused.
    expect(() => assertDispatchAllowed({ ...base, state, parallel: false })).toThrow(DispatchRefused);
  });

  it('resets the repeat counter when the instruction changes', () => {
    const state = newTurnState();
    assertDispatchAllowed({ ...base, state, parallel: false });
    assertDispatchAllowed({ ...base, state, parallel: false });
    assertDispatchAllowed({ ...base, state, parallel: false, instruction: '换成改后端' });
    assertDispatchAllowed({ ...base, state, parallel: false });
    expect(state.repeatedSendCount.get('sess_a')).toBe(1);
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

describe('turn cap', () => {
  it('leaves a supervisor enough time to read an event and answer', () => {
    // 90s was a performance target in disguise: a turn that had to read two
    // events and reply was thrown away every time on a slow channel.
    expect(SUPERVISOR_TURN_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });

  it('can be tuned per machine', () => {
    expect(getSupervisorTurnTimeoutMs({ CRAFT_SUPERVISOR_TURN_MS: '600000' } as NodeJS.ProcessEnv)).toBe(600_000);
  });

  it('ignores nonsense and falls back to the default', () => {
    for (const raw of ['', 'abc', '0', '-5']) {
      expect(getSupervisorTurnTimeoutMs({ CRAFT_SUPERVISOR_TURN_MS: raw } as NodeJS.ProcessEnv)).toBe(
        SUPERVISOR_TURN_TIMEOUT_MS,
      );
    }
    expect(getSupervisorTurnTimeoutMs({} as NodeJS.ProcessEnv)).toBe(SUPERVISOR_TURN_TIMEOUT_MS);
  });
});
