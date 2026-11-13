/**
 * Three failures from one live 「周期问候翻倍」 task, each visible on its board card.
 *
 * The card said 「已运行 3 次」 with a paused state, and the record explained why:
 *  - the plan had grown by one outline per round (`1`, `2`, `3` …), because each round the supervisor
 *    appended a fresh step instead of advancing the existing one. A plan that never finishes cannot
 *    be delivered, so no round ever closed;
 *  - `verifyRounds` had reached 4 against a cap of 3, because it counted for the life of the task
 *    rather than per round — the fourth round of a healthy task paused for a person.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJournal, type Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-round-reset-'));
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

describe('a new round starts from the round plan, not from what the last one added', () => {
  it('drops the steps the previous round appended', () => {
    // The live shape: round two arrived as `2` + `2.1` beside the first step, round three as `3` +
    // `3.1`, and the plan grew a step a minute until it was stopped by hand.
    const svc = service();
    const task = recurring(svc);
    // Round one claims: the plan it saw becomes the baseline.
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    expect(svc.get(task.id)!.stats?.roundPlan?.map((step) => step.id)).toEqual(['1.1']);

    // The supervisor invents a second round as a new outline, then the run ends. Written straight to
    // the record because that is what `task_plan { steps: [...] }` does, and the read path is the
    // production one (`loadTask` on every access).
    const appendOutline = () => {
      const file = join(root, 'tasks', `${task.id}.json`);
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const spec = (raw.spec ?? {}) as Record<string, unknown>;
      const plan = [...((spec.plan ?? []) as Array<Record<string, unknown>>)];
      plan.push({ id: '2', title: '执行第 2 轮', status: 'todo', agent: 'builtin-default' });
      plan.push({ id: '2.1', title: '执行第 2 轮', status: 'todo', agent: 'builtin-default' });
      raw.spec = { ...spec, plan };
      writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');
    };
    appendOutline();
    svc.startRun(task.id, 'sess_w1');
    svc.endRun(task.id, { ok: true });

    // Next round: the baseline is restored, so the invented outline is gone.
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 60000, detail: 'cron:* * * * *' })!;
    const plan = svc.get(task.id)!.spec?.plan ?? [];

    expect(plan.map((step) => step.id)).toEqual(['1.1']);
    expect(plan[0]?.status).toBe('todo');
    expect(claimed.id).toBe(task.id);
    expect(readJournal(root, task.id).some((entry) => entry.type === 'round_plan_reset')).toBe(true);
  })

  it('keeps an intentional replan made between rounds', () => {
    // The reset must not fight a person or supervisor who deliberately changes the plan while the
    // task is idle; only additions made *inside* a round are dropped.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.startRun(task.id, 'sess_w1');
    svc.endRun(task.id, { ok: true });

    // Between rounds: add a step, then record it as the new baseline the way a deliberate replan does.
    const file = join(root, 'tasks', `${task.id}.json`);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const spec = (raw.spec ?? {}) as Record<string, unknown>;
    const plan = [...((spec.plan ?? []) as Array<Record<string, unknown>>)];
    plan.push({ id: '1.2', title: '补一句', status: 'todo', agent: 'builtin-default' });
    raw.spec = { ...spec, plan };
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');
    svc.adoptRoundPlan(task.id);

    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 60000, detail: 'cron:* * * * *' })!;

    expect(claimed.spec?.plan?.map((step) => step.id)).toEqual(['1.1', '1.2']);
  })
})

describe('verification is judged per round', () => {
  it('does not accumulate verify rounds across rounds', () => {
    // Live: `verifyRounds` reached 4 with a cap of 3 and the task paused as
    // 「验收已跑满 3 轮，需要人工介入」 on what was really its fourth healthy round.
    const svc = service();
    const task = recurring(svc);

    for (let round = 1; round <= 4; round += 1) {
      svc.claimTrigger(task.id, { kind: 'cron', at: round * 60_000, detail: 'cron:* * * * *' });
      // Pretend the round's acceptance ran and count it.
      svc.startRun(task.id, `sess_w${round}`);
      svc.setStatus(task.id, 'running', { verifyRounds: 1 } as never);
      svc.endRun(task.id, { ok: true });
    }

    const after = svc.claimTrigger(task.id, { kind: 'cron', at: 5 * 60_000, detail: 'cron:* * * * *' })!;
    expect(after.verifyRounds ?? 0).toBe(0);
  })
})
