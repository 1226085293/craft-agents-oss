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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

describe('the backlog a lock banks is released with it', () => {
  /**
   * The design: a firing that arrives while the task is locked is banked, and released when the
   * lock goes. Banked was implemented; released was not.
   *
   * `releaseRunRecord` dropped the lock but not the status, so a run that ended without a hand-off
   * left the task at `running` with nobody running it. The scheduler saw a task still claiming to
   * run, so those banked firings had nothing to release them — live, `pendingTriggers` reached three
   * and stayed there with the task stuck at `running`.
   */
  it('banks firings while locked, then parks the task and pokes the scheduler', () => {
    let pokes = 0;
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      wakeSupervisor: () => undefined,
      pokeScheduler: () => {
        pokes += 1;
      },
    });
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'pending:dispatch');
    svc.startRun(task.id, 'sess_w');

    // Two firings arrive while the round is live: banked, not started.
    expect(svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:*/1 * * * *' })).toBeNull();
    expect(svc.claimTrigger(task.id, { kind: 'cron', at: 3000, detail: 'cron:*/1 * * * *' })).toBeNull();
    expect(svc.get(task.id)!.stats?.lockSessionId).toBe('sess_w');

    const before = pokes;
    svc.endRun(task.id, { ok: false, error: 'boom' });

    const after = svc.get(task.id)!;
    expect(after.status).toBe('backlog');
    expect(after.stats?.lockSessionId).toBeUndefined();
    // The banked firings stay: they are what the next round is for.
    expect(after.stats?.pendingTriggers?.length).toBe(3);
    expect(pokes).toBeGreaterThan(before);
  })
})

describe('one round is one run, even when a firing lands mid-round', () => {
  /**
   * `runs` is the budget's clock (`runs > maxRuns`), so counting a round twice halves the rounds a
   * task gets. Live, a per-minute task showed `runs: 8` against `rounds.ok: 6`.
   *
   * The window: `reportHandoff` releases the lock *before* the verdict decides what happens next, so
   * between a worker's delivery and the round's close the record says `running` with no lock and no
   * session. A firing that landed there claimed a second round for the same one.
   */
  it('banks the firing while the round is still open, lock or no lock', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'pending:dispatch');
    svc.startRun(task.id, 'sess_w');
    expect(svc.get(task.id)!.stats?.runs).toBe(1);

    /**
     * The window `reportHandoff` opens: `releaseRunRecord` drops the lock *before* the verdict
     * decides what happens next, so for a moment the record reads `running` with nobody holding it.
     * Rebuilt directly, because that window is internal to `reportHandoff`.
     */
    const raw = JSON.parse(readFileSync(join(root, 'tasks', `${task.id}.json`), 'utf8'))
    raw.status = 'running'
    raw.stats = { ...raw.stats, lockSessionId: undefined, lockDeadlineAt: undefined }
    writeFileSync(join(root, 'tasks', `${task.id}.json`), JSON.stringify(raw))
    expect(svc.get(task.id)!.status).toBe('running')
    expect(svc.get(task.id)!.stats?.lockSessionId).toBeUndefined()

    // A firing in that window must bank, not start a second round.
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:*/1 * * * *' })
    expect(claimed).toBeNull()
    expect(svc.get(task.id)!.stats?.runs).toBe(1)
  })

  it('still claims once the round is over', () => {
    // The other half: a `backlog` task must start, or the loop stops.
    const svc = service();
    const task = recurring(svc);
    expect(svc.get(task.id)!.status).toBe('backlog')
    const claimed = svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' })
    expect(claimed).not.toBeNull()
    expect(svc.get(task.id)!.stats?.runs).toBe(1)
  })
})

describe('run counting survives the lock being released mid-round', () => {
  /**
   * The lock alone cannot answer 「is this a new run」, because a round releases it before it closes.
   * `reportHandoff` drops the lock and lets the verdict decide what happens next — deliberately, so a
   * hand-off ends the worker's run whatever the verdict says. A claim inside that window then looked
   * like a new round and counted a second run (live: `runs: 8` against `rounds.ok: 6`).
   *
   * `runsCountedFor` is what survives: it records the value `runs` reached for this round, so a
   * second claim of the same round sees its own stamp and reuses the count.
   */
  it('does not count a second run for a claim inside the window', () => {
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'pending:dispatch');
    svc.startRun(task.id, 'sess_1');
    expect(svc.get(task.id)!.stats?.runs).toBe(1);

    // The window: still running, lock released (what `reportHandoff` leaves behind).
    const path = join(root, 'tasks', `${task.id}.json`)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.status = 'running'
    raw.stats = { ...raw.stats, lockSessionId: undefined, lockDeadlineAt: undefined }
    writeFileSync(path, JSON.stringify(raw))

    svc.startRun(task.id, 'pending:dispatch')
    svc.startRun(task.id, 'sess_2')
    expect(svc.get(task.id)!.stats?.runs).toBe(1)
  })

  it('counts the next round, because closing it drops the stamp', () => {
    // The other half: without this the counter never moves and the budget check is meaningless.
    const svc = service();
    const task = recurring(svc);
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' });
    svc.startRun(task.id, 'pending:dispatch');
    svc.startRun(task.id, 'sess_1');
    svc.setStatus(task.id, 'backlog');
    expect(svc.get(task.id)!.stats?.runStartedAt).toBeUndefined()

    svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:*/1 * * * *' })
    expect(svc.get(task.id)!.stats?.runs).toBe(2)
  })
})

describe('a repeating task plans one round', () => {
  /**
   * Live, one per-minute task wrote outline `1`, then `1`+`2`, then `3`+`4`, then `1`+`2`+`3` —
   * numbering rounds instead of describing one — and each round ran more steps than the last while
   * writing the same single file.
   *
   * The rule lives in the prompt, and the wall behind it is `closeRound` clearing the plan: each
   * round starts from an empty plan, so outlines cannot accumulate across rounds.
   *
   * This used to be enforced by refusing a second outline on a recurring task, which was too
   * strong — a round may genuinely need several outlines (`1` gather, `2` write, `3` clean up),
   * exactly like a one-off task. The mistake worth preventing is one outline *per round*, not a
   * second outline in one round.
   */
  it('accepts several outlines within one round, like any other task', () => {
    const svc = service();
    const task = recurring(svc);
    expect(svc.updatePlan(task.id, { id: '1', title: '收集' }).ok).toBe(true)
    expect(svc.updatePlan(task.id, { id: '2', title: '写文件' }).ok).toBe(true)
    expect(svc.updatePlan(task.id, { id: '3', title: '收尾' }).ok).toBe(true)
    // All three landed, next to the sub-step the fixture already had.
    expect((svc.get(task.id)!.spec?.plan ?? []).map((s) => s.id)).toEqual(['1.1', '1', '2', '3'])
  })

  it('leaves a one-off task alone, because its plan is the whole job', () => {
    const svc = service();
    const task = svc.create({
      name: '一次性',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_off',
      spec: { plan: [{ id: '1.1', title: 'w', status: 'todo', agent: 'builtin-default' }] },
    })
    expect(svc.updatePlan(task.id, { id: '2', title: '收尾' }).ok).toBe(true)
    expect(svc.updatePlan(task.id, { id: '2.1', title: 'w', agent: 'builtin-default' }).ok).toBe(true)
  })
})

describe('a paused task ignores its triggers', () => {
  /**
   * Pausing is the person's instruction to stop. The branch asked 「may a run start now?」
   * (`startGate`) instead of 「is this task paused?」, so a task the person had stopped kept waking
   * the supervisor every minute to be told 「本轮被触发」.
   */
  it('banks the firing without waking anyone, whatever the pause reason', () => {
    for (const reason of ['waiting', 'awaiting_dispatch', 'process_lost'] as const) {
      const svc = service();
      const task = recurring(svc);
      svc.setStatus(task.id, 'paused', { pauseReason: reason });

      const before = svc.get(task.id)!.stats?.pendingTriggers?.length ?? 0
      expect(svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' })).toBeNull()
      const after = svc.get(task.id)!
      expect(after.status).toBe('paused')
      // Banked, not acted on: the firing is recorded so the person can see what arrived.
      expect(after.stats?.pendingTriggers?.length).toBe(before + 1)
    }
  })

  it('starts the next round once the pause is lifted', () => {
    // The rule it protects is not 「paused forever」: resuming is the person's way back in.
    const svc = service();
    const task = recurring(svc);
    svc.setStatus(task.id, 'paused', { pauseReason: 'waiting' })
    svc.claimTrigger(task.id, { kind: 'cron', at: 1000, detail: 'cron:*/1 * * * *' })
    svc.setStatus(task.id, 'backlog')

    expect(svc.claimTrigger(task.id, { kind: 'cron', at: 2000, detail: 'cron:*/1 * * * *' })).not.toBeNull()
    expect(svc.get(task.id)!.status).toBe('running')
  })
})
