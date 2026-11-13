/**
 * What a round is, as the system now behaves.
 *
 * A round is one whole execution of the task: the supervisor decides what this round's work is and
 * writes it as steps, the worker does them, and the round is delivered when they are done. So each
 * round generating its own steps is the intended shape — what must hold is that a finished round
 * leaves nothing behind (the plan resets) and that acceptance is judged per round rather than per
 * task.
 *
 * Both halves come from one live task: `verifyRounds` reached 4 against a cap of 3, so the fourth
 * healthy round paused as 「验收已跑满 3 轮」.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJournal, type Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-round-shape-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const recurring = (svc: TaskService): Task =>
  svc.create({
    name: '周期问候',
    instruction: '每分钟发一句你好+N',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_round',
    trigger: { kind: 'cron', expr: '* * * * *', timezone: 'Asia/Shanghai', enabled: true },
    spec: { plan: [{ id: '1.1', title: '发一句问候', status: 'todo', agent: 'builtin-default' }] },
  });

describe('a round plans its own steps', () => {
  it("does not carry the previous round's steps into the next one when the round closed", async () => {
    // The reset is what keeps rounds independent: after a delivered round the plan is `todo` again,
    // so the next round's supervisor writes the steps it wants rather than inheriting a checklist.
    const svc = service();
    const task = recurring(svc);
    const artifact = join(root, 'greeting.md');
    writeFileSync(artifact, 'hello+1', 'utf-8');

    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '发了一句',
        stepId: '1.1',
        artifacts: [{ path: artifact }],
        verify: { ran: ['cat greeting.md'], passed: true },
      },
      'sess_w1',
    );

    const after = svc.get(task.id)!;
    expect(after.status).toBe('backlog');
    expect(after.spec?.plan?.map((step) => step.status)).toEqual(['todo']);
    expect(after.stats?.lastRound?.round).toBe(1);
  })

  it("leaves a round's own steps alone while it is running", () => {
    // No baseline, no restore: the supervisor is allowed to write the steps this round needs.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    expect(svc.get(task.id)!.spec?.plan?.map((step) => step.id)).toEqual(['1.1']);
  })
})

describe('verification is judged per round', () => {
  it('does not accumulate verify rounds across rounds', () => {
    // Live: `verifyRounds` reached 4 against a cap of 3 and the task paused as
    // 「验收已跑满 3 轮，需要人工介入」 on what was really its fourth healthy round.
    const svc = service();
    const task = recurring(svc);

    for (let round = 1; round <= 4; round += 1) {
      svc.claimTrigger(task.id, { kind: 'cron', at: round * 60_000, detail: 'cron:* * * * *' });
      svc.startRun(task.id, `sess_w${round}`);
      svc.setStatus(task.id, 'running', { verifyRounds: 1 } as never);
      svc.endRun(task.id, { ok: true });
    }

    const after = svc.claimTrigger(task.id, { kind: 'cron', at: 5 * 60_000, detail: 'cron:* * * * *' })!;
    expect(after.verifyRounds ?? 0).toBe(0);
  })
})
