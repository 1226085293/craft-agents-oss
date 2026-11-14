/**
 * A task that parks for a question must actually stop its worker.
 *
 * `setDecisionWording` releases the run and calls `disposeRun('suspended')`, which stops the
 * session — but only while the run still has a handle. An ordinary hand-off ends one first:
 * `reportHandoff` calls `disposeRun('ended')`, and that deletes the handle. So a question asked
 * after a slice was delivered parked the task on the record while the worker kept running.
 *
 * Measured 2026-11-14 on T-1: asked at 05:17:00, the worker edited the plan at 05:19:01 and filed
 * another hand-off at 05:19:10. That hand-off woke the supervisor, which tried to dispatch into a
 * paused task, was refused, and asked the same question again at 05:19:52. The duplicate decision
 * could never be answered, and it held the person's reply undelivered.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
const stopped: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-park-stop-'));
  stopped.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => undefined,
    stopSession: (sessionId) => { stopped.push(sessionId); },
  });

const task = (svc: TaskService): Task =>
  svc.create({
    name: '一次性任务',
    instruction: '把这件事做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: { plan: [{ id: '1.1', title: '做事', status: 'doing', agent: 'builtin-default' }] },
  });

describe('a question parks the run it interrupts', () => {
  it('stops the working session even when the run handle is already gone', () => {
    const svc = service();
    const created = task(svc);
    svc.startRun(created.id, 'sess_worker');

    // What an ordinary hand-off does before the supervisor asks anything: the run ends and its
    // handle is deleted. This is the state the live task was in at 05:17:00.
    ;(svc as unknown as { disposeRun: (id: string, mode: string) => void })
      .disposeRun(created.id, 'ended');
    stopped.length = 0;

    svc.setDecisionWording(created.id, { question: '第③项移植 main 还是自己实现？' });

    expect(svc.get(created.id)!.status).toBe('paused');
    expect(stopped).toContain('sess_worker');
  });

  it('stops it once, not once per writer', () => {
    const svc = service();
    const created = task(svc);
    svc.startRun(created.id, 'sess_worker');

    svc.setDecisionWording(created.id, { question: '第一个问题？' });

    expect(stopped).toEqual(['sess_worker']);
  });
});
