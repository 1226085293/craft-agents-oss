/**
 * A recurring task finishes a round, not the task.
 *
 * What this pins down, from a live run of 「每分钟发一次你好」: one round ran, the worker reported
 * `delivered`, the record was written `completed` — and `completed` is where every trigger stops
 * (`task-scheduler.ts` skips completed/canceled). Minute two never happened. The person asked for a
 * loop and received one greeting.
 *
 * The reset also has to make the next round *possible*: `dispatch` refuses a step already recorded
 * as done (`supervisor-runtime.ts:484`) and refuses a task whose plan is finished (`:587`), so a
 * round that left 1.1 `done` made the next dispatch unreachable from both directions.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatTaskBrief, readJournal, type Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-round-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({
    workspaceRoot: root,
    sessionExists: () => false,
    wakeSupervisor: () => undefined,
  });

const createRecurring = (svc: TaskService): Task =>
  svc.create({
    name: '每分钟问候',
    instruction: '每分钟发一次你好',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
    spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
  });

const deliver = (svc: TaskService, id: string, artifact: string, from = 'sess_w1', summary = '已发出「你好」') =>
  svc.reportHandoff(
    id,
    {
      outcome: 'delivered',
      summary,
      stepId: '1.1',
      artifacts: [{ path: artifact }],
      // The gate requires evidence of something actually run; a report without it is refused.
      verify: { ran: ['echo hello'], passed: true },
    },
    from,
  );

describe('a recurring round ends, not the task', () => {
  it('returns to backlog instead of completing', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = createRecurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });

    await deliver(svc, task.id, artifact);

    const after = svc.get(task.id)!;
    expect(after.status).toBe('backlog');
    // The reason `completed` was wrong: it is where triggers stop.
    expect(after.status).not.toBe('completed');
  });

  it('resets the plan so the next round can be dispatched', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = createRecurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    expect(svc.get(task.id)!.spec?.plan?.[0]?.status).toBe('done');

    await deliver(svc, task.id, artifact);

    const plan = svc.get(task.id)!.spec?.plan ?? [];
    expect(plan.map((step) => step.status)).toEqual(['todo']);
    // Ownership survives the reset — the plan is the record of who does what, and clearing it
    // would leave the next round's step unassigned.
    expect(plan[0]?.agent).toBe('builtin-default');
  });


  it('keeps the evidence note with the step it proved', async () => {
    // The reset exists to make the next round dispatchable, not to erase why this one counted.
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = createRecurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done', note: 'ran pnpm test, 12 passed' });

    await deliver(svc, task.id, artifact);

    const step = svc.get(task.id)!.spec?.plan?.[0]
    expect(step?.status).toBe('todo')
    expect(step?.note).toContain('12 passed')
  })

  it('keeps what the round did in the journal, because the plan no longer shows it', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = createRecurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });

    await deliver(svc, task.id, artifact);

    const reset = readJournal(root, task.id).find((entry) => entry.type === 'round_reset');
    expect(reset).toBeTruthy();
    const data = (reset!.data ?? {}) as { round?: number; plan?: Array<{ id: string; title: string; status: string }> };
    expect(data.round).toBe(1);
    // The snapshot is the only remaining answer to 「so what did that round do」.
    expect(data.plan).toEqual([{ id: '1.1', title: '发问候', status: 'done' } as never]);
  });

  it('counts rounds and remembers only the latest one', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'hello', 'utf-8');
    const task = createRecurring(svc);

    for (let round = 1; round <= 2; round += 1) {
      svc.startRun(task.id, `sess_w${round}`);
      svc.updatePlan(task.id, { id: '1.1', status: 'done' });
      await deliver(svc, task.id, artifact, `sess_w${round}`, `第 ${round} 轮：已发出「你好」`);
    }

    const after = svc.get(task.id)!;
    expect(after.stats?.rounds).toEqual({ ok: 2, failed: 0 });
    expect(after.stats?.lastRound?.round).toBe(2);
    expect(after.stats?.lastRound?.summary).toContain('你好');
    // Still recurring: two rounds in, the task is waiting for the third trigger.
    expect(after.status).toBe('backlog');
  });

  it('still completes a one-shot task', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'done', 'utf-8');
    const task = svc.create({
      name: '一次性',
      instruction: '写一个文件',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_2',
      spec: { plan: [{ id: '1.1', title: '写文件', status: 'todo', agent: 'builtin-default' }] },
    });
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });

    await deliver(svc, task.id, artifact);

    // No enabled trigger → this really was the end.
    expect(svc.get(task.id)!.status).toBe('completed');
  });


  it('announces a finished task once, not on every later write', () => {
    // `save` is the only write path, so 「is terminal」 fired on heartbeats and plan edits too — the
    // host re-ran its archiving each time. The transition is the fact worth announcing.
    const announced: string[] = []
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: () => undefined,
      onTaskTerminal: (task) => announced.push(task.id),
    })
    const task = createRecurring(svc)

    svc.setStatus(task.id, 'completed')
    svc.setStatus(task.id, 'completed')
    svc.updatePlan(task.id, { id: '1.1', status: 'done' })

    expect(announced).toEqual([task.id])
  })


  it('carries the round delivery into the next round brief', async () => {
    // What the person asked for: 「每分钟发个你好+0，后面的数字每次累加」. The number cannot live in the
    // supervisor's context — one lost turn restarts it. It has to be on the record, and the next
    // round's brief has to read it.
    const svc = service();
    const artifact = join(root, 'greeting-3.md');
    writeFileSync(artifact, 'hello+3', 'utf-8');
    const task = createRecurring(svc);
    svc.startRun(task.id, 'sess_w1');
    svc.updatePlan(task.id, { id: '1.1', status: 'done' });

    await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '已发出 你好+3（下一句是 你好+4）',
        stepId: '1.1',
        artifacts: [{ path: artifact }],
        verify: { ran: ['cat greeting-3.md'], passed: true },
      },
      'sess_w1',
    );

    const after = svc.get(task.id)!;
    // The delivery record survives the reset ...
    expect(after.stats?.lastRound?.summary).toContain('你好+3');
    expect(after.stats?.lastRound?.result?.artifacts?.[0]).toContain('greeting-3.md');
    expect(after.stats?.lastRound?.result?.verify?.passed).toBe(true);

    // ... and the next round's brief is where it gets read.
    const brief = formatTaskBrief(after, { reason: 'cron:* * * * *' })
    expect(brief).toContain('## Previous round (#1)')
    expect(brief).toContain('你好+3')
    expect(brief).toContain('carry its numbers and state forward')
  })

  it('lets the supervisor close a recurring task from backlog', () => {
    // The decision 「not needed any more」 arrives after a round, when the record is `backlog`.
    // Without this edge the only way to close it would be to reopen it first.
    const svc = service();
    const task = createRecurring(svc);

    const closed = svc.setStatus(task.id, 'completed');

    expect(closed.status).toBe('completed');
  });
});
