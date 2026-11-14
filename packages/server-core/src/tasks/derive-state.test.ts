import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';

/**
 * State is a function of the record.
 *
 * The pause reason used to be a claim each writer made at the moment it acted: true then, written
 * forever. Three of them are computable — budget spent, failures piling up, a dependency unfinished —
 * so they are derived now, and the derived label is also what the start gate answers. The label on
 * the card and the sentence a refusal speaks cannot be two different things.
 */

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-derive-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const svc = new TaskService({
    workspaceRoot: workspace(),
    sessionExists: () => true,
    wakeSupervisor: () => undefined,
    stopSession: () => undefined,
  });
  const make = (name: string, dependsOn?: string[]) =>
    svc.create({
      name,
      instruction: '做完',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_${name}`,
      ...(dependsOn ? { dependsOn } : {}),
    });
  return { svc, make };
}

describe('a pause reason the record can prove', () => {
  it('labels a pause for an unfinished dependency as waiting', () => {
    const { svc, make } = harness();
    const blocker = make('前置');
    const dependent = make('依赖', [blocker.id]);

    const paused = svc.setStatus(dependent.id, 'paused');
    expect(paused.pauseReason).toBe('waiting');
  });

  it('labels a pause whose budget is spent as budget', () => {
    const { svc, make } = harness();
    const task = make('超预算');
    // The budget counts the round now, so seeding history alone no longer trips it: these sessions
    // have to be the round's own for the cap to mean 「this round used another conversation」.
    for (let i = 0; i < 9; i += 1) svc.attachSession(task.id, `sess_${i}`, { round: true });

    expect(svc.setStatus(task.id, 'paused').pauseReason).toBe('budget');
  });

  it('labels a pause after the fuse tripped as failures', () => {
    const { svc, make } = harness();
    const task = make('熔断');
    for (let i = 0; i < 3; i += 1) svc.endRun(task.id, { ok: false, error: 'boom' });

    expect(svc.setStatus(task.id, 'paused').pauseReason).toBe('failures');
  });

  it('drops the label once the reason stops being true', () => {
    // The drift this replaces: the label was written once and stayed, so a task whose dependency
    // finished kept saying 「等待中」 and a card offered 继续 on a pause that no longer existed.
    const { svc, make } = harness();
    const blocker = make('前置');
    const dependent = make('依赖', [blocker.id]);
    svc.setStatus(dependent.id, 'paused');
    expect(svc.get(dependent.id)?.pauseReason).toBe('waiting');

    svc.setStatus(blocker.id, 'running');
    svc.setStatus(blocker.id, 'completed');

    expect(svc.setStatus(dependent.id, 'paused').pauseReason).toBeNull();
  });

  it('keeps the reasons a record cannot prove', () => {
    // `process_lost` is an event — the process is gone, and the lock that proved it is released.
    // `awaiting_release` is a person's declaration. Neither is derivable, so neither is touched.
    const { svc, make } = harness();
    const lost = make('丢了进程');
    svc.setStatus(lost.id, 'running');
    expect(svc.setStatus(lost.id, 'paused', { pauseReason: 'process_lost' }).pauseReason).toBe(
      'process_lost',
    );

    const released = make('按指示停');
    svc.setStatus(released.id, 'running');
    expect(
      svc.setStatus(released.id, 'paused', { pauseReason: 'awaiting_release' }).pauseReason,
    ).toBe('awaiting_release');
  });

  it('refuses the resume the label warns about, with the same reason', () => {
    // One function answers both: if the card says 「预算用尽」, the gate must refuse for the budget.
    const { svc, make } = harness();
    const task = make('超预算');
    for (let i = 0; i < 9; i += 1) svc.attachSession(task.id, `sess_${i}`, { round: true });

    const paused = svc.setStatus(task.id, 'paused');
    expect(paused.pauseReason).toBe('budget');
    const refused = svc.startRun(task.id, 'pending:scheduled');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('会话数 9/8');
  });
});

describe('a lost process is retried by the rule, not by the card', () => {
  it('is due once the grace has passed and not before', async () => {
    const { processLostRetryDue, MAX_PROCESS_LOST_RETRIES } = await import(
      '@craft-agent/shared/tasks'
    );
    const base = {
      status: 'paused' as const,
      pauseReason: 'process_lost' as const,
      updatedAt: 1_000,
      lastHeartbeatAt: 1_000,
      stats: { runs: 1, activeMs: 0, lostRetries: 0 },
    };

    expect(processLostRetryDue(base as never, 2_000, 5_000)).toBe(false);
    expect(processLostRetryDue(base as never, 7_000, 5_000)).toBe(true);
    // One retry, then a person decides.
    expect(
      processLostRetryDue(
        { ...base, stats: { ...base.stats, lostRetries: MAX_PROCESS_LOST_RETRIES } } as never,
        7_000,
        5_000,
      ),
    ).toBe(false);
    // And only for that pause: other pauses have their own recovery.
    expect(processLostRetryDue({ ...base, pauseReason: 'budget' } as never, 7_000, 5_000)).toBe(false);
  });
});

describe('completed means the plan closed', () => {
  it('refuses to complete a task with open steps', () => {
    // 「完成」and「停了」are different outcomes; the record already refuses the confusion, and this
    // pins it so no future writer can introduce a second path.
    const { svc, make } = harness();
    const task = make('半途');
    svc.updateSpec(task.id, {
      plan: [
        { id: '1', title: '调研' },
        { id: '1.1', title: '读文档', agent: 'worker-a' },
      ],
    } as never);
    svc.setStatus(task.id, 'running');

    expect(() => svc.setStatus(task.id, 'completed')).toThrow(/没完成/);
    expect(svc.get(task.id)?.status).toBe('running');
  });
});
