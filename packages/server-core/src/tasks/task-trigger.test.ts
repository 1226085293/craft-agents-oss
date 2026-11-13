/**
 * A trigger asks the supervisor; it does not create a session.
 *
 * The old path spawned the worker directly (`spawnRun` → `spawnTaskRun` → worker session + task
 * brief), so the only reader that could decide 「这一轮还跑不跑 / 是不是不再需要了」 never saw the
 * round. Live result: 「每分钟发一次你好」 ran once, the worker reported `delivered`, the record closed
 * and minute two never happened — the trigger fired into a `completed` task and stopped there.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJournal, type Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';
import { expireTriggerClaims, runCronPass, type TaskRunnerDeps } from './task-scheduler.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-trigger-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const recurring = (svc: TaskService): Task =>
  svc.create({
    name: '每分钟问候',
    instruction: '每分钟发一次你好',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
    spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
  });

const deps = (svc: TaskService, woken: string[], busy = false): TaskRunnerDeps => ({
  listTasks: () => svc.list(),
  tasks: svc,
  // Must not be called by a trigger any more. If it is, the test below fails loudly.
  spawnRun: async (task) => {
    throw new Error(`spawnRun must not be used for a trigger: ${task.id}`);
  },
  triggerTask: async (task) => {
    woken.push(task.id);
    return { ok: true };
  },
  isBusy: () => busy,
});

describe('a fired trigger wakes the supervisor', () => {
  it('asks instead of spawning, and leaves a claim behind', async () => {
    const svc = service();
    const task = recurring(svc);
    const woken: string[] = [];

    await runCronPass(deps(svc, woken), new Date('2026-11-13T10:00:00Z'));

    expect(woken).toEqual([task.id]);
    const after = svc.get(task.id)!;
    // The claim is what stops two ticks from starting two rounds.
    expect(after.stats?.lockSessionId?.startsWith('pending:')).toBe(true);
    expect(after.stats?.lockDeadlineAt).toBeGreaterThan(0);
    // The trigger is on the record, which is what the supervisor's message summarises.
    expect(after.stats?.pendingTriggers?.length).toBe(1);
  });

  it('accumulates while a run is in flight, and does not wake anyone', async () => {
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_w1');
    const woken: string[] = [];

    await runCronPass(deps(svc, woken), new Date('2026-11-13T10:01:00Z'));

    expect(woken).toEqual([]);
    const after = svc.get(task.id)!;
    // A second wake would ask about a round that is already being worked on.
    expect(after.stats?.lockSessionId).toBe('sess_w1');
    expect(after.stats?.pendingTriggers?.length).toBe(1);
    expect(readJournal(root, task.id).some((entry) => entry.type === 'trigger_accumulated')).toBe(true);
  });


  it('records instead of claiming while the supervisor is mid-turn', async () => {
    // Live: the supervisor was stuck mid-turn (`isProcessing` true after its last message was a user
    // row). Every tick claimed the round, held the notice, expired three minutes later, and claimed
    // again — so the task held a lock nobody used and produced no rounds at all.
    const svc = service();
    const task = recurring(svc);
    const woken: string[] = [];

    await runCronPass(deps(svc, woken, true), new Date('2026-11-13T10:05:00Z'));

    const after = svc.get(task.id)!;
    expect(woken).toEqual([]);
    // Recorded, not claimed: no lock, and the trigger is on the record for the next turn.
    expect(after.stats?.lockSessionId).toBeUndefined();
    expect(after.stats?.pendingTriggers?.length).toBe(1);
  });

  it("accumulates while a person is deciding, because that question is not a timer's to answer", async () => {
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' });
    // The open, worded decision is what makes this a pause for a person. A pause label alone is not:
    // the derived `awaiting_dispatch` pause looks the same on the record and must not deadlock a
    // per-minute task (see `task-round-deadlock.test.ts`).
    svc.setDecisionWording(task.id, { question: '要继续吗？', options: ['继续', '停'] });
    const woken: string[] = [];

    await runCronPass(deps(svc, woken), new Date('2026-11-13T10:02:00Z'));

    expect(woken).toEqual([]);
    expect(svc.get(task.id)!.stats?.pendingTriggers?.length).toBe(1);
  });
});

describe('a claim that nobody picked up', () => {
  it('expires after the deadline instead of holding the round forever', () => {
    const svc = service();
    const task = recurring(svc);
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' })!;
    const deadline = claimed.stats!.lockDeadlineAt!;

    const expired = expireTriggerClaims(deps(svc, []), deadline + 1, { busy: () => false, claimMs: 180_000 });

    expect(expired).toBe(1);
    const after = svc.get(task.id)!;
    expect(after.stats?.lockSessionId).toBeUndefined();
    // The trigger is not lost: it stays owed to the supervisor.
    expect(after.stats?.pendingTriggers?.length).toBe(1);
    expect(after.stats?.wakeFailures).toBe(1);
  });

  it('waits for a supervisor that is still working', () => {
    const svc = service();
    const task = recurring(svc);
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' })!;
    const deadline = claimed.stats!.lockDeadlineAt!;

    const expired = expireTriggerClaims(deps(svc, [], true), deadline + 1, { busy: () => true, claimMs: 180_000 });

    // Pulling the lock out from under a turn that is about to dispatch would let a second turn
    // start on the same round.
    expect(expired).toBe(0);
    expect(svc.get(task.id)!.stats?.lockDeadlineAt).toBeGreaterThan(deadline);
    expect(svc.get(task.id)!.stats?.wakeFailures ?? 0).toBe(0);
  });
});

describe('the summary the supervisor reads', () => {
  it('counts by kind with a time range, not one line per trigger', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: Date.UTC(2026, 10, 13, 10, 0), detail: 'cron:* * * * *' });
    svc.claimTrigger(task.id, { kind: 'cron', at: Date.UTC(2026, 10, 13, 10, 1), detail: 'cron:* * * * *' });
    svc.claimTrigger(task.id, { kind: 'manual', at: Date.UTC(2026, 10, 13, 10, 2) });

    const summary = svc.triggerSummary(task.id);

    expect(summary).toContain('定时：2 次');
    expect(summary).toContain('手动：1 次');
    // A day of triggers must not become a day of lines.
    expect(summary.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('clears only when it is delivered', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    svc.clearTriggers(task.id);

    const after = svc.get(task.id)!;
    expect(after.stats?.pendingTriggers).toEqual([]);
    // The counter that decides 「三次没有最终回复就是故障」 resets with a clean delivery.
    expect(after.stats?.wakeFailures).toBe(0);
  });
});
