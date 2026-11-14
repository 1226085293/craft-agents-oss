/**
 * The edges of a trigger claim, found by reading the implementation back against the design.
 *
 * Each case here is a way a claim could end other than the happy path — and each one was wrong in
 * the first cut:
 *  - a release left the record `running` with no lock (nobody running it, board saying it runs);
 *  - clearing the backlog after a reply left the `pending:` claim behind with its deadline erased,
 *    so nothing could expire it and no later trigger could start a round;
 *  - the expiry pass asked whether `pending:…` was busy, which is not a session, so the answer was
 *    always no and a turn still working lost its claim mid-flight.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';
import { expireTriggerClaims, type TaskRunnerDeps } from './task-scheduler.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-claim-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const recurring = (svc: TaskService): Task =>
  svc.create({
    name: '每分钟问候',
    instruction: '每分钟发一次你好',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    trigger: { kind: 'cron', expr: '* * * * *', enabled: true },
    spec: { plan: [{ id: '1.1', title: '发问候', status: 'todo', agent: 'builtin-default' }] },
  });

const deps = (svc: TaskService, busy: string[] = []): TaskRunnerDeps => ({
  listTasks: () => svc.list(),
  tasks: svc,
  spawnRun: async () => {
    throw new Error('a trigger must not spawn a worker');
  },
  triggerTask: async () => ({ ok: true }),
  isBusy: (sessionId) => busy.includes(sessionId),
});

describe('a claim that ends without a round', () => {
  it('returns the record to backlog, not to a running-but-unlocked limbo', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    expect(svc.get(task.id)!.status).toBe('running');

    svc.releaseTriggerClaim(task.id, 'wake failed');

    const after = svc.get(task.id)!;
    expect(after.status).toBe('backlog');
    expect(after.stats?.lockSessionId).toBeUndefined();
    // The trigger is still owed — a release is «this attempt failed», not «forget it».
    expect(after.stats?.pendingTriggers?.length).toBe(1);
  })

  it('gives the claim back when the supervisor answers', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    svc.clearTriggers(task.id);

    const after = svc.get(task.id)!;
    // The answer 「这一轮不派」 ends the claim. Leaving the lock behind held the round forever.
    expect(after.stats?.lockSessionId).toBeUndefined();
    expect(after.stats?.pendingTriggers).toEqual([]);
    expect(after.status).toBe('backlog');
  })


  it('does not free a worker that is mid-round when the backlog is cleared', () => {
    // The dangerous shape: the supervisor turn that ends is also the turn that dispatched. Clearing
    // the backlog must not release the lock the dispatch just bound, or a second round starts on top
    // of a running one.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    svc.startRun(task.id, 'sess_worker');

    svc.clearTriggers(task.id);

    const after = svc.get(task.id)!;
    expect(after.stats?.lockSessionId).toBe('sess_worker');
    expect(after.status).toBe('running');
    expect(after.stats?.pendingTriggers).toEqual([]);
  })

  it('counts a wake with no reply but does not lose the trigger', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });

    expect(svc.noteWakeWithoutReply(task.id)).toBe(1);
    expect(svc.noteWakeWithoutReply(task.id)).toBe(2);

    const after = svc.get(task.id)!;
    expect(after.stats?.wakeFailures).toBe(2);
    expect(after.stats?.pendingTriggers?.length).toBe(1);
  })
})

describe('expiry asks the right session whether it is busy', () => {
  it('extends the claim while the supervisor is still working', () => {
    const svc = service();
    const task = recurring(svc);
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' })!;
    const deadline = claimed.stats!.lockDeadlineAt!;

    const expired = expireTriggerClaims(deps(svc, ['sess_sup']), deadline + 1, {
      busy: (t) => Boolean(t.supervisorSessionId && ['sess_sup'].includes(t.supervisorSessionId)),
      claimMs: 180_000,
    });

    expect(expired).toBe(0);
    expect(svc.get(task.id)!.stats?.lockDeadlineAt).toBeGreaterThan(deadline);
  })

  it('expires when the supervisor is idle, and leaves the round startable', () => {
    const svc = service();
    const task = recurring(svc);
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' })!;
    const deadline = claimed.stats!.lockDeadlineAt!;

    const expired = expireTriggerClaims(deps(svc), deadline + 1, {
      busy: () => false,
      claimMs: 180_000,
    });

    expect(expired).toBe(1);
    const after = svc.get(task.id)!;
    expect(after.status).toBe('backlog');
    // Nothing ran, so the next tick must be able to claim again immediately.
    expect(svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:* * * * *' })).not.toBeNull();
  })
})

describe('the summary', () => {
  it('prints local clock times, not UTC', () => {
    const svc = service();
    const task = recurring(svc);
    const at = Date.UTC(2026, 10, 13, 10, 5);
    svc.claimTrigger(task.id, { kind: 'cron', at, detail: 'cron:* * * * *' });

    const expected = new Date(at).toTimeString().slice(0, 5);
    expect(svc.triggerSummary(task.id)).toContain(expected);
  })
})

describe('a placeholder claim keeps its deadline until it binds', () => {
  /**
   * Live, this cost a per-minute task every round after the first.
   *
   * `startRun` cleared `lockDeadlineAt` unconditionally — 「a real claim is not pending any more」 —
   * but a `pending:…` claim reaches the same line, and it erased the three minutes `claimTrigger`
   * had just set. Six `run_started` placeholders, one `run_bound`: the lock could never expire, so
   * every later dispatch was refused with 「运行已经由 … 持有」, no worker was spawned, and the round
   * never closed.
   */
  it('keeps the 3 minutes the claim just set', () => {
    const svc = service();
    const task = recurring(svc);
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    expect(claimed).not.toBeNull();
    const lockId = claimed!.stats?.lockSessionId;
    const deadline = claimed!.stats?.lockDeadlineAt;

    expect(lockId?.startsWith('pending:')).toBe(true);
    expect(deadline).toBeGreaterThan(0);
  })

  it('clears it on the bind, because liveness is the heartbeat\'s job then', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:* * * * *' });
    expect(svc.get(task.id)!.stats?.lockDeadlineAt).toBeGreaterThan(0);

    const bound = svc.startRun(task.id, 'sess_worker');
    expect(bound.ok).toBe(true);
    expect(svc.get(task.id)!.stats?.lockSessionId).toBe('sess_worker');
    expect(svc.get(task.id)!.stats?.lockDeadlineAt).toBeUndefined();
  })
})

describe('a trigger claim is handed over, not defended', () => {
  /**
   * Live: every round after the first of a per-minute task was dead.
   *
   * The cron fired, claimed `pending:cron:…` so the next minute would bank instead of starting a
   * second round, and woke the supervisor. The supervisor dispatched the step — and
   * `assertDispatchCanStart` read that claim as 「someone else is already running」 and refused.
   * Six `run_started` placeholders, one `run_bound`, `hello-2.md` never written, and the trigger
   * spent on a round that could not begin.
   *
   * The lock stops two rounds running at once; it must not stop a round from starting.
   */
  it('lets the dispatch take over what the trigger claimed', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    expect(svc.get(task.id)!.stats?.lockSessionId?.startsWith('pending:cron')).toBe(true);

    const takeover = svc.startRun(task.id, 'pending:dispatch');
    expect(takeover.ok).toBe(true);
    expect(svc.get(task.id)!.stats?.lockSessionId).toBe('pending:dispatch');

    const bind = svc.startRun(task.id, 'sess_worker');
    expect(bind.ok).toBe(true);
    expect(svc.get(task.id)!.stats?.lockSessionId).toBe('sess_worker');
  })

  it('counts the whole hand-over as one run, because `runs` is the budget\'s clock', () => {
    // Two writes describe one round (trigger claim, dispatch takeover) and a third ends it (bind).
    // Counting all three made `runs` climb by two per round, and `runs > maxRuns` is the budget —
    // so a task that promised twelve rounds stopped at six.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'pending:dispatch');
    svc.startRun(task.id, 'sess_worker');
    expect(svc.get(task.id)!.stats?.runs).toBe(1);
  })
})
