/**
 * The whole loop, three rounds deep.
 *
 * This is the behaviour 「每分钟发一次你好」 asked for and did not get: the first round delivered and
 * the record closed, so minute two fired into a `completed` task and stopped. Each test below pins
 * one link in the chain that now holds instead:
 *
 *   cron tick → claim → wake the supervisor → dispatch (a run) → work → `delivered`
 *             → reset the plan, return to `backlog` → next tick
 *
 * Nothing here simulates a model: `triggerTask` stands in for the supervisor turn and does exactly
 * what the prompt tells it to do — dispatch one step, then file the report.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';
import { runCronPass, type TaskRunnerDeps } from './task-scheduler.ts';

let root: string;
let artifact: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-loop-'));
  artifact = join(root, 'greeting.md');
  writeFileSync(artifact, 'hello', 'utf-8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

/**
 * A supervisor turn, reduced to its effects: write this round's step, do the work, report delivered.
 *
 * The worker session is reused across rounds — that is what a recurring task does — so the run lock
 * and the session id stay the same and the plan is what changes. The plan is written every round on
 * purpose: a recurring round ends by clearing its plan, so a supervisor that assumed last round's step
 * was still there would dispatch nothing on minute two. That assumption is exactly what this test
 * exists to catch, so the stand-in does what the prompt tells a real one to do.
 */
const supervisorTurn = (svc: TaskService, rounds: Array<{ rounds: number; status: string }>) => {
  let session = 'sess_worker';
  return async (task: Task): Promise<{ ok: boolean }> => {
    svc.startRun(task.id, session);
    // Round N's plan is written by round N: the outline first, then the step under it.
    if ((svc.get(task.id)?.spec?.plan?.length ?? 0) === 0) {
      svc.updatePlan(task.id, { id: '1', title: '每轮执行' });
      svc.updatePlan(task.id, { id: '1.1', title: '发一句问候', agent: 'builtin-default' });
    }
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '已发出「你好」',
        stepId: '1.1',
        artifacts: [{ path: artifact }],
        verify: { ran: ['echo hello'], passed: true },
      },
      session,
    );
    const after = svc.get(task.id)!;
    rounds.push({ rounds: after.stats?.rounds?.ok ?? 0, status: after.status });
    return { ok: true };
  };
};

const deps = (svc: TaskService, triggerTask: TaskRunnerDeps['triggerTask']): TaskRunnerDeps => ({
  listTasks: () => svc.list(),
  tasks: svc,
  spawnRun: async () => {
    throw new Error('a trigger must not spawn a worker');
  },
  triggerTask,
  isBusy: () => false,
});

describe('a per-minute task keeps running minute after minute', () => {
  it('runs three rounds and never closes itself', async () => {
    const svc = service();
    const task = svc.create({
      name: '每分钟问候',
      instruction: '每分钟发一次你好',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_1',
      trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
      spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
    });
    const seen: Array<{ rounds: number; status: string }> = [];
    const d = deps(svc, supervisorTurn(svc, seen));

    // Three consecutive minutes. Each tick must find a dispatchable task.
    for (let minute = 0; minute < 3; minute += 1) {
      await runCronPass(d, new Date(Date.UTC(2026, 10, 13, 10, minute)));
    }

    expect(seen.map((entry) => entry.rounds)).toEqual([1, 2, 3]);
    // The link that was broken: every round ends in `backlog`, never `completed`.
    expect(seen.map((entry) => entry.status)).toEqual(['backlog', 'backlog', 'backlog']);
    expect(svc.get(task.id)!.status).toBe('backlog');
  });

  it('stops when the supervisor closes it, and does not run again', async () => {
    const svc = service();
    const task = svc.create({
      name: '每分钟问候',
      instruction: '每分钟发一次你好',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_1',
      trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
      spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
    });
    const seen: Array<{ rounds: number; status: string }> = [];
    const d = deps(svc, supervisorTurn(svc, seen));

    await runCronPass(d, new Date(Date.UTC(2026, 10, 13, 10, 0)));
    // The decision being closed is the supervisor's, after the round — not a consequence of it.
    svc.setStatus(task.id, 'completed');
    await runCronPass(d, new Date(Date.UTC(2026, 10, 13, 10, 1)));

    expect(seen.length).toBe(1);
    expect(svc.get(task.id)!.status).toBe('completed');
  });

  it('a trigger that arrives mid-round waits instead of starting a second worker', async () => {
    const svc = service();
    const task = svc.create({
      name: '每分钟问候',
      instruction: '每分钟发一次你好',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_1',
      trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
      spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
    });
    let turns = 0;
    // A supervisor turn that never finishes: the round is still in flight on the next tick.
    const d = deps(svc, async (t) => {
      turns += 1;
      svc.startRun(t.id, 'sess_worker');
      return { ok: true };
    });

    await runCronPass(d, new Date(Date.UTC(2026, 10, 13, 10, 0)));
    await runCronPass(d, new Date(Date.UTC(2026, 10, 13, 10, 1)));

    // One wake, two recorded triggers: the first tick's trigger is claimed (and queued for the
    // report), the second tick's trigger arrives during the round and waits. Neither is dropped —
    // 「minute two fired」 is a fact, even though nothing started because of it.
    expect(turns).toBe(1);
    expect(svc.get(task.id)!.stats?.pendingTriggers?.length).toBe(2);
  });
});
