import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildJudgePrompt, parseJudgeVerdict } from './task-judge.ts';
import { TaskService } from './task-service.ts';
import type { Handoff, Task } from '@craft-agent/shared/tasks';

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

  it('asks for a fresh session once the handoff count piles up', async () => {
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
    for (let i = 0; i < 4; i += 1) {
      svc.startRun(task.id, `sess_${i}`);
      results.push(await svc.reportHandoff(task.id, handoff, `sess_${i}`));
    }

    expect(results.slice(0, 3).every((r) => r.rotationPending === false)).toBe(true);
    expect(results[3].rotationPending).toBe(true);
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
    expect(result.rotationPending).toBe(true);
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
    expect(result.rotationPending).toBe(false);
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
