import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';

/**
 * A fact that changed is not a deadline that passed.
 *
 * The watchdog's sleep is derived from state — a heartbeat window, a decision
 * deadline, a stale plan — which answers 「when is this overdue」 and not 「this just
 * happened」. Every rule reads the record, so a write is the only reliable signal
 * that the record says something new; these tests pin that the write asks for a
 * pass, and that the one write which cannot create a finding does not.
 */

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-task-poke-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const pokes: number[] = [];
  const svc = new TaskService({
    workspaceRoot: workspace(),
    sessionExists: () => true,
    wakeSupervisor: () => undefined,
    stopSession: () => undefined,
    pokeWatchdog: () => {
      pokes.push(Date.now());
    },
  });
  const task = svc.create({
    name: '多 Agent 上线',
    instruction: '把文档里的都做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
  });
  /** Pokes caused by one action, not by the fixture's own writes. */
  const count = (action: () => unknown): number => {
    const before = pokes.length;
    action();
    return pokes.length - before;
  };
  const countAsync = async (action: () => Promise<unknown>): Promise<number> => {
    const before = pokes.length;
    await action();
    return pokes.length - before;
  };
  return { svc, task, count, countAsync };
}

describe('a write is the event', () => {
  it('asks for a pass when a decision is answered', async () => {
    const { svc, task, count } = harness();
    svc.startRun(task.id, 'sess_worker');
    // File a question the way a worker does; the decision is on the record once the
    // hand-off resolves.
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要不要删掉旧字段？' },
      'sess_worker',
    );
    expect(svc.get(task.id)?.decision).toBeTruthy();

    expect(count(() => svc.recordDecisionAnswer(task.id, '继续'))).toBeGreaterThan(0);
  });

  it('asks for a pass when a plan step moves', () => {
    const { svc, task, count } = harness();
    svc.setStatus(task.id, 'running');
    // A plan is a flat list whose hierarchy lives in the ids: 「1」 is the outline,
    // 「1.1」 the sub-step that names an owner.
    svc.updateSpec(task.id, {
      plan: [
        { id: '1', title: '调研' },
        { id: '1.1', title: '读文档', agent: 'worker-a' },
      ],
    } as never);

    expect(count(() => svc.updatePlan(task.id, { id: '1.1', status: 'done' }))).toBeGreaterThan(0);
  });

  it('asks for a pass when a hand-off is filed', async () => {
    const { svc, task, countAsync } = harness();
    svc.startRun(task.id, 'sess_worker');

    const pokes = await countAsync(() =>
      svc.reportHandoff(task.id, { summary: '做完了' }, 'sess_worker'),
    );
    expect(pokes).toBeGreaterThan(0);
    expect(svc.get(task.id)?.handoffs.length).toBe(1);
  });

  it('asks for a pass when a run starts or is paused', () => {
    const { svc, task, count } = harness();

    expect(count(() => svc.startRun(task.id, 'sess_worker'))).toBeGreaterThan(0);
    expect(count(() => svc.setStatus(task.id, 'paused', { pauseReason: 'budget' }))).toBeGreaterThan(0);
  });

  it('does not ask for a pass on a heartbeat', () => {
    // A heartbeat can only make a task look more alive: no rule starts matching
    // because of one, and it is the only write frequent enough to matter.
    const { svc, task, count } = harness();
    svc.startRun(task.id, 'sess_worker');

    expect(count(() => svc.heartbeat(task.id))).toBe(0);
  });
});
