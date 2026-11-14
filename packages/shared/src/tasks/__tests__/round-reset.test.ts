/**
 * What a finished round leaves behind — pinned entry by entry.
 *
 * The table in `plans/round-lifecycle-redesign.md` §4 is the contract; this file is the executable
 * copy of it. Every row is asserted separately because the cost of one wrong entry is silent: a field
 * cleared that should survive loses the person's history, and a field kept that should be cleared
 * corrupts the next round's judgement (the live case: `verifyRounds` carried across rounds until the
 * fourth one paused for 「验收轮数耗尽」 without a single judgement in it).
 */
import { describe, expect, it } from 'bun:test';
import { resetRoundState } from '../round-reset.ts';
import type { Task } from '../types.ts';

const NOW = 1_700_000_000_000;

/** A task that has just finished its third round, with every field the reset has an opinion about. */
function finishedRound(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    name: '每分钟你好N问候',
    instruction: '每分钟发一次你好+N',
    status: 'running',
    priority: 2,
    supervisorSessionId: 'sess_sup',
    sessionIds: ['sess_r1', 'sess_r2a', 'sess_r2b', 'sess_r3'],
    roundSessionIds: ['sess_r2a', 'sess_r2b'],
    currentSessionId: 'sess_r2b',
    handoffs: [
      { at: NOW - 1000, fromSessionId: 'sess_r2a', outcome: 'handoff', summary: '第2轮 1.1', round: 3 },
      { at: NOW, fromSessionId: 'sess_r2b', outcome: 'delivered', summary: '第2轮完成', round: 3 },
    ],
    triggers: [{ kind: 'cron', expr: '* * * * *', enabled: true }],
    budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120 },
    verify: { enabled: true, maxIterations: 3, lastVerdict: 'pass', lastVerifiedRevision: 'rev-1' },
    verifyRounds: 2,
    lifecycle: {
      errorCount: 1,
      consecutiveFailures: 2,
      lastError: '上一轮失败了',
      lastPausedAt: NOW - 5000,
    },
    spec: {
      plan: [{ id: '1.1', title: '发问候', status: 'done', agent: 'builtin-default' }],
    } as Task['spec'],
    stats: {
      runs: 3,
      activeMs: 90_000,
      rounds: { ok: 2, failed: 1 },
      lastRound: { round: 2, finishedAt: NOW - 60_000, outcome: 'delivered', summary: '你好+2', result: { data: { nextN: 4 } } },
      lockSessionId: 'sess_r2b',
      lockDeadlineAt: NOW + 180_000,
      runStartedAt: NOW - 90_000,
      lastHeartbeatAt: NOW - 1000,
      wakeAttempts: 2,
      lastWakeAt: NOW - 2000,
      lostRetries: 1,
      unwordedRetries: 1,
      handoffsRound: 3,
      lastTriggeredAt: NOW - 60_000,
      pendingTriggers: [{ kind: 'cron', at: NOW - 30_000, detail: 'cron:* * * * *' }],
      triggersDeliveredAt: NOW - 40_000,
      wakeFailures: 1,
      announcedPauseAt: NOW - 3000,
    },
    createdAt: NOW - 600_000,
    updatedAt: NOW,
    ...overrides,
  } as Task;
}

const reset = (over: Partial<Task> = {}) => resetRoundState(finishedRound(over), { now: NOW });

describe('what survives a round (kept on purpose)', () => {
  it('keeps the three things a person asked for: runs, rounds, last result', () => {
    const { task } = reset();
    expect(task.stats?.runs).toBe(3);
    expect(task.stats?.rounds).toEqual({ ok: 2, failed: 1 });
    expect(task.stats?.lastRound?.summary).toBe('你好+2');
    expect((task.stats?.lastRound?.result?.data as { nextN: number }).nextN).toBe(4);
  });

  it('keeps the failure fuse, which spans rounds by definition', () => {
    // Resetting it every round would let a task that fails every time run forever.
    const { task } = reset();
    expect(task.lifecycle?.consecutiveFailures).toBe(2);
    expect(task.lifecycle?.errorCount).toBe(1);
  });

  it('keeps the trigger backlog and the delivery watermark', () => {
    // These describe the scheduler, not the round: dropping the backlog loses firings the person
    // asked for, and dropping the watermark makes the next turn re-deliver or over-clear.
    const { task } = reset();
    expect(task.stats?.pendingTriggers?.length).toBe(1);
    expect(task.stats?.triggersDeliveredAt).toBe(NOW - 40_000);
    expect(task.stats?.lastTriggeredAt).toBe(NOW - 60_000);
    expect(task.stats?.wakeFailures).toBe(1);
    expect(task.stats?.announcedPauseAt).toBe(NOW - 3000);
  });

  it('keeps the whole-life session list, because deleting the task needs it', () => {
    const { task } = reset();
    expect(task.sessionIds).toEqual(['sess_r1', 'sess_r2a', 'sess_r2b', 'sess_r3']);
  });

  it('keeps the task itself: identity, instruction, schedule, budget', () => {
    const { task } = reset();
    expect(task.id).toBe('T-1');
    expect(task.instruction).toContain('每分钟');
    expect((task.triggers?.[0] as { expr?: string })?.expr).toBe('* * * * *');
    expect(task.budget.maxSessions).toBe(8);
  });
});

describe('what a round takes with it (cleared)', () => {
  it('clears the round list and hands it back for archiving', () => {
    const { task, archivedSessionIds } = reset();
    expect(archivedSessionIds).toEqual(['sess_r2a', 'sess_r2b']);
    expect(task.roundSessionIds).toEqual([]);
  });

  it('clears the executor, so the next dispatch opens a fresh conversation', () => {
    const { task } = reset();
    expect(task.currentSessionId).toBeUndefined();
    expect(task.stats?.lockSessionId).toBeUndefined();
    expect(task.stats?.lockDeadlineAt).toBeUndefined();
  });

  it('clears the hand-off timeline; the summary already moved to lastRound', () => {
    const { task } = reset();
    expect(task.handoffs).toEqual([]);
    expect(task.stats?.handoffsRound).toBeUndefined();
  });

  it('clears the round plan when asked', () => {
    expect(resetRoundState(finishedRound(), { now: NOW, clearPlan: true }).task.spec?.plan).toEqual([]);
  });

  it('resets the acceptance counter with the round it was spent on', () => {
    // Live: round 1 judged three times, round 4 started at the cap and paused for 「验收轮数耗尽」
    // with no judgement in that round at all.
    const { task } = reset();
    expect(task.verifyRounds).toBe(0);
  });

  it('clears the last verdict, which was about the previous round\'s work', () => {
    expect(reset().task.verify?.lastVerdict).toBeUndefined();
    expect(reset().task.verify?.lastVerifiedRevision).toBeUndefined();
    // The requirement itself is the task's, not the round's.
    expect(reset().task.verify?.enabled).toBe(true);
    expect(reset().task.verify?.maxIterations).toBe(3);
  });

  it('clears the previous round\'s pause reason', () => {
    // Left in place, `deriveGateReason` reads it back as 「this round is paused because of that」.
    const { task } = reset();
    expect(task.lifecycle?.lastError).toBeUndefined();
    expect(task.lifecycle?.lastPausedAt).toBeUndefined();
  });

  it('clears the wake bookkeeping, which counts nudges within one round', () => {
    const { task } = reset();
    expect(task.stats?.wakeAttempts).toBeUndefined();
    expect(task.stats?.lastWakeAt).toBeUndefined();
    expect(task.stats?.lostRetries).toBeUndefined();
    expect(task.stats?.unwordedRetries).toBeUndefined();
    expect(task.stats?.runStartedAt).toBeUndefined();
    expect(task.stats?.lastHeartbeatAt).toBeUndefined();
  });
});

describe('what the reset must not touch', () => {
  it('leaves decisions alone — a close never happens while one is open', () => {
    // §3.3: an unanswered question means the round is not finished, so the caller never closes it.
    // Clearing here as well would be a second place to get that rule wrong.
    const decisions = [
      { id: 'd-1', question: '继续吗', askedAt: NOW - 1000, category: 'choice' },
    ] as Task['decisions'];
    const { task } = reset({ decisions });
    expect(task.decisions).toEqual(decisions);
  });

  it('is idempotent, because a crash replay can close the same round twice', () => {
    const once = resetRoundState(finishedRound(), { now: NOW, clearPlan: true });
    const twice = resetRoundState(once.task, { now: NOW, clearPlan: true });
    expect(twice.task.roundSessionIds).toEqual([]);
    expect(twice.archivedSessionIds).toEqual([]);
    expect(twice.task.stats?.runs).toBe(3);
    expect(twice.task.stats?.lastRound?.summary).toBe('你好+2');
  });

  it('falls back to currentSessionId for records written before roundSessionIds existed', () => {
    const legacy = finishedRound({ roundSessionIds: undefined });
    const { archivedSessionIds } = resetRoundState(legacy, { now: NOW });
    expect(archivedSessionIds).toEqual(['sess_r2b']);
  });
});

describe('the report survives the round that filed it', () => {
  /**
   * `handoffs` empties when a round closes — the next round must not inherit this round's attempts.
   * But the watchdog asked 「did THIS run file?」 through that array, so every closed round looked
   * unreported until the next hand-off arrived: live, T-1 closed round 5 and the supervisor was told
   * 「T-1 的执行者已停止但没交作业」 about the session that had just reported it.
   */
  it('stamps the accepted report so the question stays answerable after the clear', () => {
    const { task } = reset()
    expect(task.handoffs).toEqual([])
    expect(task.stats?.lastHandoffAt).toBe(NOW)
    expect(task.stats?.lastHandoffSessionId).toBe('sess_r2b')
  })

  it('ignores a refused attempt, because a rejection is not a report', () => {
    const refused = finishedRound({
      handoffs: [
        { at: NOW - 2000, fromSessionId: 'sess_r2a', outcome: 'handoff', summary: '被拒', round: 3, passed: false },
      ] as Task['handoffs'],
    })
    const { task } = resetRoundState(refused, { now: NOW })
    expect(task.stats?.lastHandoffAt).toBeUndefined()
  })
})
