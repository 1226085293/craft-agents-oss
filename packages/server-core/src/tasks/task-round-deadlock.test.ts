/**
 * The deadlock a live per-minute task hit, in three parts.
 *
 * The task's plan was finished (1.1 + 1.2 done), the worker filed `handoff` — correctly, because its
 * brief calls a partial part a hand-off — and then nothing happened: `rounds` stayed empty, the record
 * derived a pause with no reason, and every later trigger was told 「accumulate only」. The person got
 * one greeting and three triggers piled up behind a pause nobody owed an answer to.
 *
 * Each test pins one link: a finished plan ends the round whatever word the worker used; the wake text
 * stops asking for a dispatch once the round is closed; and a pause with nothing refusing it does not
 * block the next round.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-deadlock-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = (wakes: string[] = []) =>
  new TaskService({
    workspaceRoot: root,
    sessionExists: () => false,
    wakeSupervisor: (_id, text) => wakes.push(text),
  });

const recurring = (svc: TaskService): Task =>
  svc.create({
    name: '每分钟你好循环',
    instruction: '每分钟发一句你好+N',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_loop',
    trigger: { kind: 'cron', expr: '*/1 * * * *', timezone: 'Asia/Shanghai', enabled: true },
    spec: {
      plan: [
        { id: '1.1', title: '发出问候', status: 'todo', agent: 'builtin-default' },
        { id: '1.2', title: '记录结果', status: 'todo', agent: 'builtin-default' },
      ],
    },
  });

describe('a finished plan ends the round, whichever word the worker used', () => {
  it('closes the round on handoff when every step is done', async () => {
    const wakes: string[] = [];
    const svc = service(wakes);
    const task = recurring(svc);
    const artifact = join(root, 'round-1.md');
    writeFileSync(artifact, 'hello+1', 'utf-8');

    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    svc.updatePlan(task.id, { id: '1.2', status: 'done' });
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'handoff',
        summary: '第1轮完成：你好+1',
        stepId: '1.2',
        artifacts: [{ path: artifact }],
        verify: { ran: ['cat round-1.md'], passed: true },
        roundResult: { n: 1, result: 2 },
      },
      'sess_w1',
    );

    const after = svc.get(task.id)!;
    // The live failure: plan finished, hand-off accepted, and `rounds` stayed empty forever.
    expect(after.stats?.rounds?.ok).toBe(1);
    expect(after.status).toBe('backlog');
    expect(after.spec?.plan?.map((step) => step.status)).toEqual(['todo', 'todo']);
    expect(after.stats?.lastRound?.summary).toContain('你好+1');
    expect((after.stats?.lastRound?.result?.data as { result: number }).result).toBe(2);

    // And the wake text must not ask for a dispatch it would refuse.
    const text = wakes.at(-1) ?? '';
    expect(text).toContain('本轮到此结束')
    expect(text).not.toContain('下一步 1.2')
  })
})

describe('a pause with nothing refusing it does not block the next round', () => {
  it('starts a round on a paused task that the gate would allow', () => {
    // The derived pause (`awaiting_dispatch`) is not a question for a person. Treating it as one left
    // three triggers accumulating behind it while the plan sat finished.
    const svc = service();
    const task = recurring(svc);
    svc.setStatus(task.id, 'paused', { pauseReason: 'awaiting_dispatch' });

    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });

    expect(claimed).not.toBeNull();
    expect(svc.get(task.id)!.status).toBe('running');
  })

  it('still only accumulates while a person is deciding', () => {
    // The rule that must survive: a real question is not something a timer may answer.
    const svc = service();
    const task = recurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' });
    // An open, worded decision blocks the round.
    svc.setDecisionWording(task.id, { question: '要继续吗？', options: ['继续', '停'] });

    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });

    expect(claimed).toBeNull();
    expect(svc.get(task.id)!.stats?.pendingTriggers?.length).toBe(1);
  })
})

describe('a closed round does not wait for the next tick', () => {
  it('asks the scheduler to look now', async () => {
    // Measured live: 66 seconds of idle per round between 「round closed」 and 「next claim」, because
    // the scheduler only looks once a minute. That idle is the difference between the one-minute
    // cadence the person set and the two-minute one they saw.
    let poked = 0;
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: () => undefined,
      pokeScheduler: () => {
        poked += 1;
      },
    });
    const task = recurring(svc);
    const artifact = join(root, 'round.md');
    writeFileSync(artifact, 'hello', 'utf-8');

    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    svc.updatePlan(task.id, { id: '1.2', status: 'done' });
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '本轮完成',
        stepId: '1.2',
        artifacts: [{ path: artifact }],
        verify: { ran: ['cat round.md'], passed: true },
      },
      'sess_w1',
    );

    expect(poked).toBe(1);
  })
})
