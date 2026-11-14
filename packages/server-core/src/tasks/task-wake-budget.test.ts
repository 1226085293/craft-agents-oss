/**
 * A resumed run gets its wake budget back.
 *
 * `wakeAttempts` counts 「this run was woken and did not move」, and the idle rule pauses the task
 * when it reaches `MAX_IDLE_WAKES`. It used to be cleared only when a ROUND closed, so a one-off
 * task — where a round never closes — carried the counter at its cap forever. Every resume was then
 * paused again by the very next pass, and pausing stops the worker session, so the turn died with no
 * message.
 *
 * Measured 2026-11-14 on 261115-broad-puma: `idle_wake` at 00:50:33 and 00:57:59, pause at 00:58:14,
 * resumed at 00:58:32, paused again 28 seconds later. The transcript ends on a tool call with
 * `aborted: true` and no reply — 「静默中止无报错」.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-wake-budget-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => true, wakeSupervisor: () => undefined });

const task = (svc: TaskService): Task =>
  svc.create({
    name: '一次性任务',
    instruction: '把这件事做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: { plan: [{ id: '1.1', title: '做事', status: 'todo', agent: 'builtin-default' }] },
  });

describe('a new run restores the wake budget', () => {
  it('clears wakeAttempts when a fresh run starts', () => {
    const svc = service();
    const created = task(svc);

    svc.startRun(created.id, 'sess_worker_a');
    svc.noteWake(created.id);
    svc.noteWake(created.id);
    expect(svc.get(created.id)!.stats?.wakeAttempts).toBe(2);

    // The task is paused (idle gave up) and then resumed: new run, new budget.
    svc.setStatus(created.id, 'paused', { pauseReason: 'process_lost' });
    svc.startRun(created.id, 'sess_worker_b');

    expect(svc.get(created.id)!.stats?.wakeAttempts).toBeUndefined();
  });

  it('keeps the budget through the bind that belongs to the same run', () => {
    // A placeholder claim and the bind of its real session are one run. Refilling the budget there
    // would make the counter unable to ever reach its cap.
    const svc = service();
    const created = task(svc);

    svc.startRun(created.id, 'pending:dispatch');
    svc.noteWake(created.id);
    expect(svc.get(created.id)!.stats?.wakeAttempts).toBe(1);

    svc.startRun(created.id, 'sess_worker_a');

    expect(svc.get(created.id)!.stats?.wakeAttempts).toBe(1);
  });
});
