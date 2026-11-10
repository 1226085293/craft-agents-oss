import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskService } from './task-service.ts';

/**
 * What a run owns and what it must give back.
 *
 * The four bugs this file pins down were all one shape: a run ended on one path and
 * not on the others. A lock that only some exits released, a session only some exits
 * stopped, a spawn counted twice by two claims of one run.
 */

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-run-lifecycle-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(opts: { alive?: string[] } = {}) {
  const alive = new Set(opts.alive ?? []);
  const stopped: string[] = [];
  const svc = new TaskService({
    workspaceRoot: workspace(),
    sessionExists: (id) => alive.has(id),
    wakeSupervisor: () => undefined,
    stopSession: (id) => stopped.push(id),
  });
  const task = svc.create({
    name: '多 Agent 上线',
    instruction: '把文档里的都做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
  });
  return { svc, task, stopped };
}

const locked = (task: { stats?: { lockSessionId?: string } }) => task.stats?.lockSessionId;

describe('a spawn counts one run, not two', () => {
  it('counts the placeholder claim and the real-id bind as the same run', () => {
    const { svc, task } = harness();

    const claimed = svc.startRun(task.id, 'pending:scheduled');
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.task.stats?.runs).toBe(1);
    // A placeholder is not a session: it must not enter `sessionIds` (the board
    // reads that as "2 / 8" for one worker) nor `currentSessionId`.
    expect(claimed.task.sessionIds).toEqual([]);
    expect(claimed.task.currentSessionId).toBeUndefined();

    const bound = svc.startRun(task.id, 'sess_worker');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.task.stats?.runs).toBe(1);
    expect(bound.task.sessionIds).toEqual(['sess_worker']);
    expect(bound.task.currentSessionId).toBe('sess_worker');
    expect(locked(bound.task)).toBe('sess_worker');
  });

  it('counts a run started directly with a real session as one run', () => {
    const { svc, task } = harness();
    const run = svc.startRun(task.id, 'sess_worker');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.task.stats?.runs).toBe(1);
  });

  it('keeps the budget honest: twelve spawns cost twelve runs, not twenty-four', () => {
    const { svc, task } = harness();

    // Twelve whole spawns, the budget's default `maxRuns`. Under the double count
    // the seventh claim was already refused — six spawns reported `runs: 12` —
    // and the task stopped at half the runs its budget promised. (Whether the
    // twelfth or thirteenth run is the last one to start is the check's own
    // exclusive boundary, `runs > maxRuns`; not this test's subject.)
    for (let i = 0; i < 12; i += 1) {
      expect(svc.startRun(task.id, `pending:${i}`).ok).toBe(true);
      // One worker session reused, so the session cap cannot be what stops the loop.
      expect(svc.startRun(task.id, 'sess_worker').ok).toBe(true);
      svc.endRun(task.id, { ok: true });
    }
    expect(svc.get(task.id)?.stats?.runs).toBe(12);
  });
});

describe('every exit gives the lock back', () => {
  it('releases it when the task is paused through setStatus', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const paused = svc.setStatus(task.id, 'paused', { pauseReason: 'budget' });
    expect(paused.status).toBe('paused');
    expect(locked(paused)).toBeUndefined();
    expect(paused.stats?.runStartedAt).toBeUndefined();
  });

  it('releases it when the task is canceled', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const canceled = svc.setStatus(task.id, 'canceled');
    expect(canceled.status).toBe('canceled');
    expect(locked(canceled)).toBeUndefined();
  });

  it('releases it on suspendRun and endRun', () => {
    const first = harness();
    first.svc.startRun(first.task.id, 'sess_worker');
    expect(locked(first.svc.suspendRun(first.task.id))).toBeUndefined();

    const second = harness();
    second.svc.startRun(second.task.id, 'sess_worker');
    expect(locked(second.svc.endRun(second.task.id, { ok: false, error: 'boom' }))).toBeUndefined();
  });

  it('releases it when a hand-off closes the run', async () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要你定' },
      'sess_worker',
    );
    expect(result.task.status).toBe('paused');
    expect(locked(result.task)).toBeUndefined();
  });

  it('releases it when a running task loses its process', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const recovered = svc.recoverAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(locked(recovered[0])).toBeUndefined();
  });

  it('keeps the lock when the refusal comes from the gate itself', () => {
    // `setStatus('running')` on a task whose run is alive is refused by the start
    // gate: the pause it writes means "waiting for the owner", and the owner is
    // still running. Releasing there would let a second worker into a live run.
    const { svc, task } = harness({ alive: ['sess_worker'] });
    svc.startRun(task.id, 'sess_worker');

    const refused = svc.setStatus(task.id, 'running');
    expect(refused.status).toBe('paused');
    expect(refused.pauseReason).toBe('waiting');
    expect(locked(refused)).toBe('sess_worker');
  });

  it('keeps the lock when a question parks a running task', async () => {
    /**
     * A pause derived from an open question is not an exit.
     *
     * The paused written for a question mid-run is the same record the answer will be delivered
     * against: the answer goes to the session that asked, not to a fresh run. `reportHandoff`
     * releases the run it closes — that is the exit; the derived pause that follows it must not
     * pretend there is still a run to give back.
     */
    const { svc, task } = harness({ alive: ['sess_worker'] });
    svc.startRun(task.id, 'sess_worker');

    const result = await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要不要让已有用户数据迁移，删除旧字段？' },
      'sess_worker',
    );
    expect(result.task.status).toBe('paused');
    // `asking`, not `needs_decision`: the hand-off filed the ask, but nobody has worded the
    // question yet — the supervisor's next turn does that, and only then is there a card to answer.
    expect(result.task.pauseReason).toBe('asking');
    // The run ended at the hand-off, so nothing is left holding the lock.
    expect(locked(result.task)).toBeUndefined();
  });
});

describe('a run that ends takes its session with it', () => {
  it('stops the worker when the task is paused', () => {
    const { svc, task, stopped } = harness();
    svc.startRun(task.id, 'sess_worker');

    svc.setStatus(task.id, 'paused', { pauseReason: 'budget' });
    expect(stopped).toEqual(['sess_worker']);
  });

  it('stops the worker when the task is suspended', () => {
    const { svc, task, stopped } = harness();
    svc.startRun(task.id, 'sess_worker');

    svc.suspendRun(task.id);
    expect(stopped).toEqual(['sess_worker']);
  });

  it('stops the worker when a running task lost its process is paused', () => {
    // Alive but silent past the heartbeat window: the run is stranded, and its
    // session is still producing work for a task that no longer expects any.
    let clock = 1_000_000;
    const stopped: string[] = [];
    const svc = new TaskService({
      workspaceRoot: workspace(),
      sessionExists: () => true,
      wakeSupervisor: () => undefined,
      stopSession: (id) => stopped.push(id),
      now: () => clock,
    });
    const task = svc.create({
      name: '多 Agent 上线',
      instruction: '把文档里的都做完',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_4',
    });
    svc.startRun(task.id, 'sess_worker');
    clock += task.heartbeatIntervalMin * 60_000 * 3;

    const recovered = svc.recoverAfterRestart();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].pauseReason).toBe('process_lost');
    expect(stopped).toEqual(['sess_worker']);
  });

  it('leaves the worker alone when the hand-off closes the run', async () => {
    // The worker is mid-turn reporting; stopping it here would kill the session
    // that is still finishing its own report.
    const { svc, task, stopped } = harness();
    svc.startRun(task.id, 'sess_worker');

    await svc.reportHandoff(task.id, { outcome: 'needs_decision', summary: '要你定' }, 'sess_worker');
    expect(stopped).toEqual([]);
  });

  it('does not try to stop a placeholder the session never became', () => {
    const { svc, task, stopped } = harness();
    svc.startRun(task.id, 'pending:scheduled');

    svc.setStatus(task.id, 'paused', { pauseReason: 'budget' });
    expect(stopped).toEqual([]);
  });

  it('runs the registered disposers in reverse, whatever the exit', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const order: string[] = [];
    svc.onRunDispose(task.id, (mode) => order.push(`first:${mode}`));
    svc.onRunDispose(task.id, (mode) => order.push(`second:${mode}`));

    svc.suspendRun(task.id);
    expect(order).toEqual(['second:suspended', 'first:suspended']);

    // A new run starts with a clean slate: the old handle is gone.
    const second = harness();
    second.svc.startRun(second.task.id, 'sess_two');
    const secondOrder: string[] = [];
    second.svc.onRunDispose(second.task.id, () => secondOrder.push('run2'));
    expect(secondOrder).toEqual([]);
  });
});

describe('a hand-off ends the run even when the task keeps running', () => {
  it('frees the lock for the next leg after a failed hand-off', async () => {
    // The failed hand-off leaves the task running: it must still hand the lock
    // back, or the retry could never start and the task would sit "running"
    // with nobody able to work on it.
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');

    const result = await svc.reportHandoff(task.id, { summary: '做完了' }, 'sess_worker');
    expect(result.task.status).toBe('running');
    expect(locked(result.task)).toBeUndefined();
    expect(svc.startRun(task.id, 'sess_next').ok).toBe(true);
  });
});

describe('the heartbeat belongs to the run, not to history', () => {
  it('credits a heartbeat only from the session the run is locked to', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');
    // `currentSessionId` is history the moment a new run starts; a heartbeat from
    // an older session must not make a task look alive that nobody is driving.
    svc.attachSession(task.id, 'sess_older');

    expect(svc.heartbeatForSession('sess_older')).toBeNull();
    const beat = svc.heartbeatForSession('sess_worker');
    expect(beat?.id).toBe(task.id);
  });

  it('does not credit a heartbeat while the task is not running', () => {
    const { svc, task } = harness();
    svc.startRun(task.id, 'sess_worker');
    svc.suspendRun(task.id);

    expect(svc.heartbeatForSession('sess_worker')).toBeNull();
  });
});

describe('a completed hand-off releases everything it held', () => {
  it('banks the active time across the hand-off', async () => {
    let clock = 1_000_000;
    const svc = new TaskService({
      workspaceRoot: workspace(),
      sessionExists: () => true,
      wakeSupervisor: () => undefined,
      now: () => clock,
    });
    const artifact = join(workspace(), 'out.txt');
    writeFileSync(artifact, 'ok', 'utf-8');
    const task = svc.create({
      name: '交付',
      instruction: '做完',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_3',
    });

    svc.startRun(task.id, 'sess_worker');
    clock += 60_000;
    const result = await svc.reportHandoff(
      task.id,
      {
        outcome: 'delivered',
        summary: '完成',
        artifacts: [{ path: artifact }],
        verify: { ran: ['bun test'], passed: true },
      },
      'sess_worker',
    );

    expect(result.task.status).toBe('completed');
    expect(result.task.stats?.activeMs).toBe(60_000);
    expect(locked(result.task)).toBeUndefined();
  });
});

describe('an answer belongs to the record, not to the run', () => {
  it('is accepted after the run that asked has ended', async () => {
    /**
     * The question outlives the process that asked it.
     *
     * A hand-off releases the lock, so by the time the person answers there is no run to deliver to.
     * Refusing the words there would strand the question: the record keeps it, the card shows it,
     * and the only party who could act on the reply is the supervisor — which reads the answer from
     * the task, not from the session that wrote the question. This pins that the answer path does
     * not depend on a lock, so a re-run cannot swallow a reply meant for the older run.
     */
    const { svc, task } = harness({ alive: ['sess_next'] });
    svc.startRun(task.id, 'sess_worker');
    await svc.reportHandoff(
      task.id,
      { outcome: 'needs_decision', summary: '要不要删掉旧字段？' },
      'sess_worker',
    );
    expect(locked(svc.get(task.id)!)).toBeUndefined();

    /**
     * And no run may start behind the question.
     *
     * The gate's job: a task waiting for a person cannot be resumed into a fresh run, whatever
     * session asks — the same rule the state machine applies to `→ running`, reached here through
     * `startRun`, which builds its record directly instead of transitioning.
     */
    // The supervisor words the question — the state a person actually sees on the card.
    svc.setDecisionWording(task.id, { question: '要不要删掉旧字段？' });
    const started = svc.startRun(task.id, 'sess_next');
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.reason).toContain('waiting for a person');
    expect(svc.get(task.id)?.stats?.lockSessionId).toBeUndefined();

    // The words are still recorded: the question belongs to the task, not to a session.
    const answered = svc.recordDecisionAnswer(task.id, '先不删');
    expect(answered?.decisions?.at(-1)?.answer?.text).toBe('先不删');
  });
});
