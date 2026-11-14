import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';
import { inspectTasks, applyFindings, startWatchdog, type WatchdogDeps } from './task-watchdog.ts';

/**
 * The whole lifecycle, on one workspace, through the real services.
 *
 * Every other test file pins one rule. This one walks the path a task actually takes —
 * create → dispatch → work → hand-off → question → answer → resume → complete → restart — so a rule
 * that is right on its own but wrong in sequence shows up here instead of in production.
 *
 * The sessions are fakes on purpose: what is being tested is the bookkeeping around them (locks,
 * budgets, derived state, the watchdog's findings), not the model.
 */

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-lifecycle-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A workspace with a clock, a session table and a stop log the test can inspect. */
function world() {
  let clock = 1_700_000_000_000;
  const alive = new Set<string>();
  const stopped: string[] = [];
  const notices: Array<{ to: string; text: string }> = [];
  const root = workspace();
  const svc = new TaskService({
    workspaceRoot: root,
    sessionExists: (id) => alive.has(id),
    wakeSupervisor: (to, text) => notices.push({ to, text }),
    stopSession: (id) => stopped.push(id),
    now: () => clock,
  });
  return {
    root,
    svc,
    alive,
    stopped,
    notices,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('a task from creation to completion', () => {
  it('runs one worker, one run, and finishes with the plan closed', async () => {
    const w = world();
    const artifact = join(w.root, 'out.txt');
    writeFileSync(artifact, 'ok', 'utf-8');

    const task = w.svc.create({
      name: '把文档补完',
      instruction: '补齐 docs 下的说明',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_create',
      spec: { cwd: w.root } as never,
    });
    expect(task.status).toBe('backlog');

    // Dispatch: the scheduler claims with a placeholder, then binds the session it created.
    expect(w.svc.startRun(task.id, 'pending:trigger').ok).toBe(true);
    w.alive.add('sess_worker');
    expect(w.svc.startRun(task.id, 'sess_worker').ok).toBe(true);
    const running = w.svc.get(task.id)!;
    expect(running.status).toBe('running');
    expect(running.stats?.runs).toBe(1);
    expect(running.stats?.lockSessionId).toBe('sess_worker');
    // The placeholder is not a session and never becomes one in the record.
    expect(running.sessionIds).toEqual(['sess_worker']);

    // The worker writes the plan it will follow, then does the work.
    w.svc.updateSpec(task.id, {
      plan: [
        { id: '1', title: '补齐文档' },
        { id: '1.1', title: '写 docs/a.md', agent: 'worker-a' },
      ],
    } as never);
    w.svc.updatePlan(task.id, { id: '1.1', status: 'done' });
    expect(w.svc.heartbeatForSession('sess_worker')?.id).toBe(task.id);

    // Hand-off: artifacts exist, checks ran, the outcome is delivered.
    const result = await w.svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '文档补齐',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_worker',
    );
    expect(result.passed).toBe(true);
    // The round is over and the record is back in `backlog`; `completed` is the supervisor's call.
    expect(result.task.status).toBe('backlog');
    // The run is over: lock released, nothing left to dispose, and the supervisor told.
    expect(result.task.stats?.lockSessionId).toBeUndefined();
    expect(w.stopped).toEqual([]);
    expect(w.svc.get(task.id)?.stats?.runs).toBe(1);
  });
});

describe('a question in the middle of the work', () => {
  it('parks the task, survives the watchdog, and resumes after the answer', async () => {
    const w = world();
    const task = w.svc.create({
      name: '要不要迁移旧字段',
      instruction: '迁移数据',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_q',
      spec: { cwd: w.root } as never,
    });
    w.alive.add('sess_worker');
    w.svc.startRun(task.id, 'sess_worker');

    // The worker stops and asks.
    const asked = await w.svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要不要让已有用户数据迁移，删除旧字段？' },
      'sess_worker',
    );
    expect(asked.task.status).toBe('paused');
    expect(asked.task.pauseReason).toBe('asking');
    expect(asked.task.stats?.lockSessionId).toBeUndefined();

    // The supervisor words the question; the card is now answerable.
    w.svc.setDecisionWording(task.id, { label: '迁移方式', question: '删掉旧字段吗？' });
    expect(w.svc.get(task.id)?.pauseReason).toBe('needs_decision');

    /**
     * Nothing may wake it while the person is deciding.
     *
     * This is the bug that started this refactor: the board said 进行中, the watchdog saw 「nobody
     * working」 and woke the executor six minutes into the person's deliberation.
     */
    const deps: WatchdogDeps = {
      listTasks: () => w.svc.list(),
      now: w.now,
      sessionExists: (id) => w.alive.has(id),
      sessionWorking: () => false,
      sessionWaiting: () => false,
      sessionIdle: () => true,
      wakeSession: () => true,
      notify: (to, text) => w.notices.push({ to, text }),
      pause: () => undefined,
      denyDecision: () => undefined,
    };
    expect(inspectTasks(deps).map((finding) => finding.kind)).toEqual([]);

    // The person answers; the supervisor resumes the task with a fresh run.
    expect(w.svc.recordDecisionAnswer(task.id, '先不删，保留旧字段')?.decision?.answer?.text).toBe(
      '先不删，保留旧字段',
    );
    w.svc.resolveDecision(task.id, 'approved', '保留旧字段，分两步迁移');
    w.alive.add('sess_next');
    expect(w.svc.startRun(task.id, 'sess_next').ok).toBe(true);
    expect(w.svc.get(task.id)?.stats?.runs).toBe(2);
    expect(w.svc.get(task.id)?.stats?.lockSessionId).toBe('sess_next');
  });
});

describe('a process that died', () => {
  it('is retried once by the rule, then left to the person', () => {
    const w = world();
    const task = w.svc.create({
      name: '跑到一半进程没了',
      instruction: '继续跑',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_lost',
      spec: { cwd: w.root } as never,
    });
    w.alive.add('sess_worker');
    w.svc.startRun(task.id, 'sess_worker');

    // The app restarts: the session table is empty, the record still says running.
    w.alive.clear();
    const recovered = w.svc.recoverAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('paused');
    expect(recovered[0].pauseReason).toBe('process_lost');
    expect(recovered[0].stats?.lockSessionId).toBeUndefined();

    // The rule picks it up once the grace window passes.
    const deps: WatchdogDeps = {
      listTasks: () => w.svc.list(),
      now: w.now,
      sessionExists: (id) => w.alive.has(id),
      sessionWorking: () => false,
      sessionIdle: () => true,
      wakeSession: () => true,
      notify: (to, text) => w.notices.push({ to, text }),
      pause: () => undefined,
      denyDecision: () => undefined,
    };
    // Not before the grace window: a process still coming up is not a dead one.
    expect(inspectTasks(deps).map((finding) => finding.kind)).toEqual([]);
    w.advance(10_000);
    const findings = inspectTasks(deps);
    expect(findings.map((finding) => finding.kind)).toEqual(['resume_lost']);
    applyFindings(deps, findings);

    // One retry is spent; the second loss is a person's call.
    w.svc.recordLostRetry(task.id, 1);
    expect(inspectTasks(deps).map((finding) => finding.kind)).toEqual([]);
  });
});

describe('the watchdog loop itself', () => {
  it('starts, reports a pass, and stops with the scope', async () => {
    // The loop is the only part that owns a timer; this covers start/dispose so a workspace that
    // closes does not leave a timer waking up against a store that no longer exists.
    const w = world();
    w.svc.create({
      name: '空转',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_idle',
      spec: { cwd: w.root } as never,
    });
    const deps: WatchdogDeps = {
      listTasks: () => w.svc.list(),
      now: w.now,
      sessionExists: () => true,
      notify: () => undefined,
      pause: () => undefined,
    };
    const loop = startWatchdog(deps, 5_000);
    expect(typeof loop.wake).toBe('function');
    loop.wake();
    loop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.svc.list()).toHaveLength(1);
  });
});
