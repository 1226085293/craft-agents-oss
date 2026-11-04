import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-task-svc-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(root: string, opts: { alive?: string[]; now?: () => number } = {}) {
  const wakes: Array<{ sessionId: string; text: string }> = [];
  const alive = new Set(opts.alive ?? []);
  const svc = new TaskService({
    workspaceRoot: root,
    sessionExists: (id) => alive.has(id),
    wakeSupervisor: (sessionId, text) => wakes.push({ sessionId, text }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { svc, wakes };
}

const create = (svc: TaskService) =>
  svc.create({
    name: '多 Agent 上线',
    instruction: '把文档里的都做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
  });

describe('task creation', () => {
  it('creates a backlog task with a human id', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    expect(task.id).toBe('T-1');
    expect(task.status).toBe('backlog');
  });

  it('dedupes on the originating tool call', () => {
    const { svc } = service(workspace());
    const first = create(svc);
    const again = create(svc);
    expect(again.id).toBe(first.id);
    expect(svc.list()).toHaveLength(1);
  });
});

describe('status transitions', () => {
  it('starts and pauses a task', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    expect(svc.setStatus(task.id, 'running').status).toBe('running');
    expect(svc.setStatus(task.id, 'paused', { pauseReason: 'waiting' }).pauseReason).toBe('waiting');
  });

  it('refuses an illegal transition', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.setStatus(task.id, 'completed');
    expect(() => svc.setStatus(task.id, 'running')).toThrow();
  });
});

describe('handoff gate', () => {
  it('fails a handoff with no artifacts and keeps the task running', () => {
    const { svc, wakes } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_worker');

    const result = svc.reportHandoff(task.id, { summary: '做完了' }, 'sess_worker');
    expect(result.passed).toBe(false);
    expect(result.task.status).toBe('running');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(wakes[0]?.text).toContain('交接未通过');
  });

  it('passes when artifacts exist and verification ran', () => {
    const ws = workspace();
    const artifact = join(ws, 'out.txt');
    writeFileSync(artifact, 'ok', 'utf-8');

    const { svc } = service(ws);
    const task = create(svc);
    svc.setStatus(task.id, 'running');

    const result = svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_worker',
    );
    expect(result.passed).toBe(true);
    expect(result.task.status).toBe('completed');
  });

  it('pauses on a needs_decision handoff', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    const result = svc.reportHandoff(task.id, { outcome: 'needs_decision', summary: '要你定' }, 'sess_w');
    expect(result.task.status).toBe('paused');
    expect(result.task.pauseReason).toBe('needs_decision');
  });

  it('trips the fuse after three rejected handoffs', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    for (let i = 0; i < 3; i += 1) {
      svc.reportHandoff(task.id, { summary: `第 ${i} 次` }, 'sess_w');
    }
    const final = svc.get(task.id);
    expect(final?.status).toBe('paused');
    expect(final?.pauseReason).toBe('failures');
  });
});

describe('budget guard', () => {
  it('pauses when the session cap is exceeded', () => {
    const { svc } = service(workspace());
    const task = create(svc);
    for (let i = 0; i < 9; i += 1) svc.attachSession(task.id, `sess_${i}`);
    const paused = svc.setStatus(task.id, 'running');
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toBe('budget');
  });
});

describe('restart recovery', () => {
  it('pauses a running task whose session disappeared', () => {
    const ws = workspace();
    const { svc } = service(ws);
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_gone');

    const recovered = svc.recoverAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('paused');
    expect(recovered[0].pauseReason).toBe('process_lost');
  });

  it('leaves a task alone while its session is alive', () => {
    const ws = workspace();
    const { svc } = service(ws, { alive: ['sess_alive'] });
    const task = create(svc);
    svc.setStatus(task.id, 'running');
    svc.attachSession(task.id, 'sess_alive');
    svc.heartbeat(task.id);

    expect(svc.recoverAfterRestart()).toHaveLength(0);
  });
});
