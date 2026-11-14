import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildJudgePrompt, parseJudgeVerdict } from './task-judge.ts';
import { TaskService } from './task-service.ts';
import type { Handoff, Task } from '@craft-agent/shared/tasks';
import { readJournal } from '@craft-agent/shared/tasks';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-judge-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('judge verdict parsing', () => {
  it('accepts only an explicit PASS line', () => {
    expect(parseJudgeVerdict('看了，没问题\nVERDICT: PASS').pass).toBe(true);
  });

  it('treats a missing verdict as failure', () => {
    const verdict = parseJudgeVerdict('看起来还行吧');
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain('did not return a verdict');
  });

  it('carries the REASON line on failure', () => {
    const verdict = parseJudgeVerdict('REASON: 报告里没有结论\nVERDICT: FAIL');
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual(['报告里没有结论']);
  });

  it('is not fooled by PASS appearing mid-sentence', () => {
    expect(parseJudgeVerdict('I would say PASS if forced\nVERDICT: FAIL').pass).toBe(false);
  });
});

describe('judge prompt', () => {
  it('includes the requirement, the summary and the artifacts', () => {
    const task = {
      id: 'T-1',
      name: '审计',
      instruction: '审一遍依赖',
      verify: { enabled: true, maxIterations: 3, requirement: '报告必须列出高危依赖' },
    } as unknown as Task;
    const handoff: Handoff = {
      at: 1,
      fromSessionId: 'w1',
      outcome: 'delivered',
      summary: '写完了',
      artifacts: [{ path: 'report.md' }],
      verify: { ran: ['bun test'], passed: true },
    };
    const prompt = buildJudgePrompt(task, handoff);
    expect(prompt).toContain('报告必须列出高危依赖');
    expect(prompt).toContain('report.md');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('只读');
  });
});

describe('context rotation', () => {
  const service = (judge?: (t: Task, h: Handoff) => Promise<{ pass: boolean; reasons: string[] }>) =>
    new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: () => undefined,
      ...(judge ? { judgeHandoff: judge } : {}),
    });

  const create = (svc: TaskService) =>
    svc.create({
      name: '长任务',
      instruction: '一直做下去',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_1',
    });

  it('never rotates just because handoffs pile up', async () => {
    // Rotation was a context tool; compaction replaced it. Counting handoffs is
    // no longer a reason to start a new session — a task can legitimately hand
    // off a dozen times inside one window.
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = create(svc);
    svc.setStatus(task.id, 'running');

    const handoff = {
      outcome: 'handoff' as const,
      summary: '还有下一步',
      artifacts: [{ path: artifact }],
      verify: { ran: ['x'], passed: true },
    };

    const results = [];
    for (let i = 0; i < 6; i += 1) {
      svc.startRun(task.id, `sess_${i}`);
      results.push(await svc.reportHandoff(task.id, handoff, `sess_${i}`));
    }

    expect(results.every((r) => r.compactionPending === false)).toBe(true);
  });

  it('asks for a compaction once the context is nearly full', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_ctx');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'handoff',
        summary: '还有下一步',
        artifacts: [{ path: artifact }],
        verify: { ran: ['x'], passed: true },
      },
      'sess_ctx',
      { contextUtilization: 0.75 },
    );

    expect(result.compactionPending).toBe(true);
  });

  it('rotates immediately when the worker is nearly out of context', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_0');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'handoff',
        summary: '继续',
        artifacts: [{ path: artifact }],
        verify: { ran: ['x'], passed: true },
      },
      'sess_0',
      { contextUtilization: 0.82 },
    );
    expect(result.compactionPending).toBe(true);
  });

  it('does not rotate for a delivered task', async () => {
    const svc = service();
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_0');

    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['x'], passed: true },
      },
      'sess_0',
      { contextUtilization: 0.95 },
    );
    expect(result.passed).toBe(true);
    expect(result.compactionPending).toBe(false);
  });
});

describe('model acceptance layer', () => {
  const service = (judge: (t: Task, h: Handoff) => Promise<{ pass: boolean; reasons: string[] }>) =>
    new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: () => undefined,
      judgeHandoff: judge,
    });

  it('blocks completion when the judge rejects the handoff', async () => {
    const svc = service(async () => ({ pass: false, reasons: ['报告缺少结论'] }));
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');

    const task = svc.create({
      name: '有要求的任务',
      instruction: '做事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_j',
      spec: { acceptance: [{ id: 'a1', check: '报告必须有结论' }] },
    });
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_w');

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '做完了', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('报告缺少结论');
    expect(result.task.status).not.toBe('completed');
  });

  it('fails closed when the judge throws', async () => {
    const svc = service(async () => {
      throw new Error('model offline');
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');

    const task = svc.create({
      name: '判不了的任务',
      instruction: '做事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_k',
      spec: { acceptance: [{ id: 'a1', check: '要有结论' }] },
    });
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_w');

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '交了', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.join(' ')).toContain('judge unavailable');
  });
});

describe('terminal-only acceptance (C2′ + C4)', () => {
  const service = (
    judge: (t: Task, h: Handoff) => Promise<{ pass: boolean; reasons: string[] }>,
    wake?: (sessionId: string, message: string, subject: string) => void,
  ) =>
    new TaskService({
      workspaceRoot: root,
      sessionExists: () => false,
      wakeSupervisor: wake ?? (() => undefined),
      judgeHandoff: judge,
    });

  // A planned task with one step done and one open: any hand-off is an
  // intermediate one, so the terminal acceptance layer must not run.
  const plannedTask = (svc: TaskService, maxIterations = 3) => {
    const task = svc.create({
      name: '分段任务',
      instruction: '做事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_p',
      spec: {
        acceptance: [{ id: 'a1', check: '报告必须有结论' }],
        plan: [
          { id: '1', title: '写草稿', status: 'done', agent: 'a' },
          { id: '2', title: '定稿', status: 'todo', agent: 'a' },
        ],
      },
    });
    svc.setStatus(task.id, 'running');
    svc.startRun(task.id, 'sess_w');
    // The service reads the record from disk; the cap is not part of the create
    // input, so it is patched the same way a migration or config edit would.
    if (maxIterations !== 3) {
      const path = join(root, 'tasks', `${task.id}.json`);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Task;
      raw.verify.maxIterations = maxIterations;
      writeFileSync(path, JSON.stringify(raw), 'utf-8');
    }
    return task;
  };

  const finishPlan = (id: string) => {
    const path = join(root, 'tasks', `${id}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Task;
    raw.spec!.plan = (raw.spec!.plan ?? []).map((step) => ({ ...step, status: 'done' as const }));
    writeFileSync(path, JSON.stringify(raw), 'utf-8');
  };

  it('does not run the judge on an intermediate hand-off and leaves the verdict untouched', async () => {
    let judgeCalls = 0;
    const svc = service(async () => {
      judgeCalls += 1;
      return { pass: false, reasons: ['没写完'] };
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = plannedTask(svc);

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'handoff', summary: '草稿写好了', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );

    expect(judgeCalls).toBe(0);
    expect(result.passed).toBe(true);
    const current = svc.get(task.id)!;
    expect(current.verify.lastVerdict).toBeUndefined();
    expect(current.verifyRounds).toBe(0);
    expect(current.status).not.toBe('completed');
  });

  it('runs the judge once the plan is complete and writes the verdict', async () => {
    let judgeCalls = 0;
    const svc = service(async () => {
      judgeCalls += 1;
      return { pass: true, reasons: [] };
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = plannedTask(svc);
    finishPlan(task.id);

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '全部完成', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );

    expect(judgeCalls).toBe(1);
    expect(result.passed).toBe(true);
    const current = svc.get(task.id)!;
    /**
     * The verdict is read off `stats.lastRound`, not off `verify`.
     *
     * `verify.lastVerdict` and `verifyRounds` belong to the round that spent them: left on the record
     * they read as 「this round already passed」, and a fourth round would start at the acceptance cap
     * without a single judgement in it. So the round's acceptance is gone with the round.
     */
    expect(current.verifyRounds).toBe(0);
    expect(current.verify.lastVerdict).toBeUndefined();
    expect(current.stats?.lastRound?.round).toBe(1);
    expect(current.status).toBe('backlog');
  });

  it('pauses and escalates once terminal acceptance exceeds maxIterations', async () => {
    let judgeCalls = 0;
    const wakes: Array<{ message: string; subject: string }> = [];
    const svc = service(
      async () => {
        judgeCalls += 1;
        return { pass: false, reasons: ['还是缺结论'] };
      },
      (_sessionId, message, subject) => wakes.push({ message, subject }),
    );
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = plannedTask(svc, 1);
    finishPlan(task.id);

    // Round 1: the judge rejects, the round is recorded.
    const first = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '做完了', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(first.passed).toBe(false);
    expect(judgeCalls).toBe(1);
    expect(svc.get(task.id)!.verifyRounds).toBe(1);
    expect(svc.get(task.id)!.status).not.toBe('completed');

    // Round 2: the cap is spent — no judge, refused, paused, journaled, escalated.
    const second = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '又交了', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(second.passed).toBe(false);
    expect(second.reasons.join('；')).toContain('验收已跑满 1 轮');
    expect(judgeCalls).toBe(1);
    const current = svc.get(task.id)!;
    expect(current.status).toBe('paused');
    expect(current.pauseReason).toBe('verify_exhausted');
    expect(readJournal(root, task.id).some((entry) => entry.type === 'verify_limit_reached')).toBe(true);
    expect(wakes.some((w) => w.message.includes('终态验收已跑满'))).toBe(true);
  });

  it('setAcceptance resets the rounds so a new requirement gets a fresh cap', async () => {
    let judgeCalls = 0;
    const svc = service(async () => {
      judgeCalls += 1;
      return { pass: false, reasons: ['旧标准下没过'] };
    });
    const artifact = join(root, 'out.md');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = plannedTask(svc, 1);
    finishPlan(task.id);

    await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '第一次交', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(svc.get(task.id)!.verifyRounds).toBe(1);

    // The person rewords the acceptance: rounds against the old wording must
    // not count towards the cap on the new one, or the task could never close.
    svc.setAcceptance(task.id, [{ id: 'a1', check: '新标准' }]);
    expect(svc.get(task.id)!.verifyRounds).toBe(0);

    const retried = await svc.reportHandoff(
      task.id,
      { outcome: 'delivered', summary: '按新标准交', artifacts: [{ path: artifact }], verify: { ran: ['x'], passed: true } },
      'sess_w',
    );
    expect(judgeCalls).toBe(2);
    expect(retried.passed).toBe(false); // 判据本身不过，但轮数重新计算
    expect(svc.get(task.id)!.verifyRounds).toBe(1);
  });
});
