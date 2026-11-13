/**
 * Three paths that the first two passes did not walk: startup recovery, the failure half of the
 * round counter, and settling a backlog that more than one task owns.
 *
 * Each one was wrong before this file existed, and each one is silent: nothing throws, the record
 * simply stops telling the truth.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-review3-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const recurring = (svc: TaskService, name = '每分钟问候'): Task =>
  svc.create({
    name,
    instruction: '每分钟发一次你好',
    supervisorSessionId: 'sess_sup',
    toolCallId: `call_${name}`,
    trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
    spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
  });

describe('startup recovery', () => {
  it('leaves a trigger claim for its own deadline instead of pausing the task', () => {
    // `pending:…` is not a session, so `sessionExists` is false by construction. The sweep used to
    // read that as 「the process disappeared」 and pause the task — and a paused task only
    // accumulates triggers, so the round the person was waiting for became a pause nobody released.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    const recovered = svc.recoverAfterRestart();

    expect(recovered).toEqual([]);
    const after = svc.get(task.id)!;
    expect(after.status).toBe('running');
    expect(after.stats?.lockSessionId?.startsWith('pending:')).toBe(true);
  })

  it('still pauses a task whose real worker session is gone', () => {
    // The guard must not swallow the case it exists for.
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_gone');

    const recovered = svc.recoverAfterRestart();

    expect(recovered.map((entry) => entry.id)).toEqual([task.id]);
    expect(svc.get(task.id)!.status).toBe('paused');
    expect(svc.get(task.id)!.pauseReason).toBe('process_lost');
  })
})

describe('the failure half of the round counter', () => {
  it('counts a run that ended badly', () => {
    // `rounds.ok` was written when a round closed, and nothing ever wrote `failed` — so a task that
    // died twice and worked twice reported 「worked twice」.
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.endRun(task.id, { ok: false, error: 'upstream 500' });

    expect(svc.get(task.id)!.stats?.rounds).toEqual({ ok: 0, failed: 1 });
  })

  it('does not count a clean end as a failure', () => {
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.endRun(task.id, { ok: true });

    expect(svc.get(task.id)!.stats?.rounds?.failed ?? 0).toBe(0);
  })
})

describe('settling a backlog belongs to the turn that saw it', () => {
  it('marks a backlog delivered only when it was put in a message', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    expect(svc.get(task.id)!.stats?.triggersDeliveredAt ?? 0).toBe(0);
    svc.markTriggersDelivered(task.id, 2000);
    expect(svc.get(task.id)!.stats?.triggersDeliveredAt).toBe(2000);
  })


  it('resets the delivered mark with the list, so the next round starts unseen', () => {
    // A stale mark survives into the next claim and makes it look already-delivered — the exact hole
    // the mark was introduced to close.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.markTriggersDelivered(task.id, 1500);
    svc.clearTriggers(task.id);

    svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:* * * * *' });

    const after = svc.get(task.id)!;
    expect(after.stats?.pendingTriggers?.length).toBe(1);
    expect(after.stats?.triggersDeliveredAt ?? 0).toBe(0);
  })

  it('keeps two tasks independent, so one report cannot settle the other', () => {
    // One supervisor lane, two recurring tasks: the turn that settles must not clear what it never
    // showed. Before the delivered mark, task B's triggers vanished with task A's reply and B was
    // never asked again.
    const svc = service();
    const a = recurring(svc, '任务A');
    const b = recurring(svc, '任务B');
    svc.claimTrigger(a.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.claimTrigger(b.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.markTriggersDelivered(a.id, 2000);

    // What settleTaskTriggers does, using the same predicate it filters on.
    const settleable = svc
      .list()
      .filter((task) => (task.stats?.pendingTriggers?.length ?? 0) > 0)
      .filter((task) => (task.stats?.triggersDeliveredAt ?? 0) > 0);

    expect(settleable.map((task) => task.id)).toEqual([a.id]);
    svc.clearTriggers(a.id);
    expect(svc.get(b.id)!.stats?.pendingTriggers?.length).toBe(1);
  })
})

describe('the end-of-round report carries the backlog', () => {
  it('includes it in the wake text and marks it delivered', async () => {
    const wakes: string[] = [];
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: (_id, text) => wakes.push(text),
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.startRun(task.id, 'sess_w1');
    // A second trigger lands mid-round: it can only reach the supervisor with this report.
    svc.claimTrigger(task.id, { kind: 'cron', at: 1500, detail: 'cron:* * * * *' });
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
      'sess_w1',
    );

    const text = wakes.at(-1) ?? '';
    expect(text).toContain('本轮期间累计的触发');
    expect(svc.get(task.id)!.stats?.triggersDeliveredAt).toBeGreaterThan(0);
  })
})
