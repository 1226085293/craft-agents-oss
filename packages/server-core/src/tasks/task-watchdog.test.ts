import { describe, expect, it } from 'bun:test';

import type { Task } from '@craft-agent/shared/tasks';

import {
  clampSleep,
  inspectTasks,
  MAX_WATCHDOG_FAILURES,
  MAX_WATCHDOG_SLEEP_MS,
  MIN_WATCHDOG_SLEEP_MS,
  nextCheckDelayMs,
  runWatchdogPass,
  upstreamRecoveredFor,
  startWatchdog,
  type WatchdogDeps,
} from './task-watchdog.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    name: 'task',
    instruction: 'x',
    status: 'running',
    pauseReason: null,
    supervisorSessionId: 'sup',
    sessionIds: ['sess-1'],
    currentWorkerSessionId: 'sess-1',
    dependsOn: [],
    priority: 1,
    budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
    handoffs: [],
    verify: { enabled: false, maxIterations: 2 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    origin: { supervisorSessionId: 'sup', toolCallId: 'call-1' },
    stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 60_000, runStartedAt: NOW - 60_000 },
    heartbeatIntervalMin: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function deps(tasks: Task[], overrides: Partial<WatchdogDeps> = {}): WatchdogDeps {
  return {
    listTasks: () => tasks,
    sessionExists: () => true,
    pause: () => undefined,
    notify: () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

describe('idle sessions', () => {
  // The reported bug: the task said 进行中 long after its session had stopped
  // working. `sessionExists` answered yes because the session object outlives the
  // turn, so the watchdog never looked again and never woke it.
  const idleSince = NOW - 20 * 60_000;

  it('flags a running task whose session exists but is not working', () => {
    // Reported as `unreported`, not `idle`: the session stopped and no hand-off was
    // filed for this run, so the owed action is 「交作业」, not 「继续」. The distinction
    // is not cosmetic — resuming a turn that ended normally answers `no re-runnable
    // model step`, which is exactly how one wake silently did nothing.
    const findings = inspectTasks(
      deps([task({ updatedAt: idleSince, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince } })], {
        sessionWorking: () => false,
      }),
    );
    expect(findings.map((f) => f.kind)).toContain('unreported');
  });

  it('leaves a working session alone', () => {
    const findings = inspectTasks(
      deps([task({ updatedAt: idleSince, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince } })], {
        sessionWorking: () => true,
      }),
    );
    expect(findings).toEqual([]);
  });

  it('treats an unknown answer as working', () => {
    // A host that cannot say must not make the watchdog fire.
    const findings = inspectTasks(
      deps([task({ updatedAt: idleSince, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince } })], {
        sessionWorking: () => undefined,
      }),
    );
    expect(findings).toEqual([]);
  });

  it('wakes the session before giving up', () => {
    let woken = 0;
    runWatchdogPass(
      deps([task({ updatedAt: idleSince, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince } })], {
        sessionWorking: () => false,
        wakeSession: () => {
          woken += 1;
        },
      }),
    );
    expect(woken).toBe(1);
  });

  it('does not wake a session that already filed its report', () => {
    /**
     * A worker that handed off and stopped is not idle, it is done.
     *
     * This used to fire — 「continue」 to a session whose last act was a hand-off — and
     * the supervisor read the nudge as work that needed resuming. Observed live on a
     * scope-limited task: hand-off at 09:01:53, idle wake at 09:08:19, and the
     * supervisor asked the person whether to continue because of it.
     */
    const pauses: string[] = [];
    let woken = 0;
    const filed = task({
      updatedAt: idleSince,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince, wakeAttempts: 0 },
      handoffs: [{ outcome: 'handoff', fromSessionId: 'sess-1', at: NOW, summary: 'x' }] as never,
    });
    runWatchdogPass(
      deps([filed], {
        sessionWorking: () => false,
        wakeSession: () => {
          woken += 1;
        },
        pause: (id) => pauses.push(id),
      }),
    );
    expect({ woken, pauses }).toEqual({ woken: 0, pauses: [] });
  });

  it('pauses the task once the wakes are spent', () => {
    // A wake that keeps not working is a loop paying for a model turn each time.
    const pauses: string[] = [];
    // No hand-off for this run, so the complaint stands and the idle budget applies.
    const idle = task({
      updatedAt: idleSince,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince, wakeAttempts: 2 },
      handoffs: [],
    });
    runWatchdogPass(
      deps([idle], {
        sessionWorking: () => false,
        wakeSession: () => {
          throw new Error('must not wake past the cap');
        },
        pause: (id) => pauses.push(id),
      }),
    );
    expect(pauses).toEqual(['T-1']);
  });
});

describe('watchdog findings', () => {
  it('leaves a healthy running task alone', () => {
    expect(inspectTasks(deps([task()]))).toEqual([]);
  });

  it('flags a task whose session disappeared', () => {
    const findings = inspectTasks(deps([task()], { sessionExists: () => false }));
    expect(findings.map((f) => f.kind)).toEqual(['orphaned']);
  });

  it('waits out a pending claim instead of calling it an orphan', () => {
    // Claim-before-spawn: between `startRun('pending:dispatch')` and the bind, the lock is a
    // placeholder and `sessionExists` can only say no. Reading that no as 「会话已消失」 paused
    // a live run 23 ms after its claim (T-1, 2026-11-13) and released the lock the spawn was
    // about to bind, which then counted as a second run.
    const spawning = task({
      currentWorkerSessionId: 'sess-gone',
      stats: {
        runs: 2,
        activeMs: 0,
        lastHeartbeatAt: NOW - 5_000,
        runStartedAt: NOW - 5_000,
        lockSessionId: 'pending:dispatch',
      },
    });
    const findings = inspectTasks(
      deps([spawning], { sessionExists: () => false, sessionWorking: () => false }),
    );
    expect(findings).toEqual([]);
  });

  it('flags a stalled heartbeat', () => {
    const stalled = task({ stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 60 * 60_000 } });
    expect(inspectTasks(deps([stalled])).map((f) => f.kind)).toEqual(['stalled']);
  });

  it('flags three consecutive failures', () => {
    const failing = task({
      lifecycle: { errorCount: 3, consecutiveFailures: 3 },
    });
    expect(inspectTasks(deps([failing])).map((f) => f.kind)).toEqual(['failing']);
  });

  it('flags a passed deadline', () => {
    const overdue = task({
      budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: NOW - 1000 },
    });
    expect(inspectTasks(deps([overdue])).map((f) => f.kind)).toEqual(['overdue']);
  });
});

describe('an open question has no deadline', () => {
  /**
   * The twelve-hour expiry was removed on 2026-11-16.
   *
   * 「Silence is not consent」 was the reason for it, and the reason was already satisfied: a task
   * with an open question is paused, so silence cannot let it proceed. All the timer added was
   * turning an unanswered question into an answered 「no」 overnight — the task never resumed, it
   * just stopped being askable. A question now waits for the person it was asked of.
   */
  const withQuestion = (over: Record<string, unknown>) => task({
    status: 'paused',
    pauseReason: 'needs_decision',
    decision: {
      category: 'destroy-data',
      label: '删数据',
      reason: '命中高风险类别',
      askedAt: NOW - 13 * 60 * 60_000,
      ...over,
    },
  })

  it('does not expire a question however long it has been open', () => {
    // Asked thirteen hours ago — the fixture's `askedAt` is that old, and nothing closes it.
    const waiting = withQuestion({})
    expect(inspectTasks(deps([waiting]))).toEqual([])
  })

  it('still leaves an answered decision alone', () => {
    const answered = withQuestion({
      resolvedAt: NOW - 500,
      resolution: 'approved',
      answer: { text: '继续', at: NOW - 500 },
    })
    expect(inspectTasks(deps([answered]))).toEqual([])
  })

  it('never denies a decision on behalf of the person', () => {
    const denied: string[] = []
    runWatchdogPass(
      deps([withQuestion({})], {
        denyDecision: (id) => denied.push(id),
        notify: () => undefined,
      }),
    )
    expect(denied).toEqual([])
  })
})

describe('watchdog self monitoring', () => {
  it('reports once when its own passes keep failing', async () => {
    const reports: Array<{ failures: number; lastError: string }> = [];
    const stop = startWatchdog(
      deps([], {
        listTasks: () => {
          throw new Error('store unavailable');
        },
      }),
      5,
      { onSelfFailure: (info) => reports.push(info) },
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.failures).toBe(MAX_WATCHDOG_FAILURES);
    expect(reports[0]?.lastError).toContain('store unavailable');
  });
});

describe('event-driven scheduling', () => {
  it('sleeps to the cap when nothing is pending', () => {
    expect(nextCheckDelayMs(deps([]), NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(clampSleep(Number.POSITIVE_INFINITY)).toBe(MAX_WATCHDOG_SLEEP_MS);
  });

  it('wakes exactly when a healthy task would become stalled', () => {
    // Last beat one minute ago, 10 minute interval → due in 19 minutes.
    const delay = nextCheckDelayMs(deps([task()]), NOW);
    expect(delay).toBe(19 * 60_000);
  });

  it('schedules nothing for an open question, because nothing about it can fall due', () => {
    /**
     * An open question used to schedule a wake-up at its `deadlineAt`. There is no deadline any
     * more, and no future moment at which re-reading the task would change anything, so the honest
     * answer is `Infinity`. Scheduling instead from an absent field would compute
     * `Math.min(Infinity, undefined)` → `NaN`; `clampSleep` caps a non-finite delay at its maximum,
     * so every pass would then run on a flat 30-second tick rather than on what is actually due.
     */
    const waiting = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'spend-money',
        label: '花钱',
        reason: 'x',
        askedAt: NOW,
      },
    });
    expect(nextCheckDelayMs(deps([waiting]), NOW)).toBe(Number.POSITIVE_INFINITY);
    // Still bounded, so an answered-elsewhere question is noticed by the periodic re-read.
    expect(clampSleep(nextCheckDelayMs(deps([waiting]), NOW))).toBe(MAX_WATCHDOG_SLEEP_MS);
  });

  it('is due immediately when a heartbeat is already overdue', () => {
    const stalled = task({ stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 60 * 60_000 } });
    expect(nextCheckDelayMs(deps([stalled]), NOW)).toBeLessThan(0);
    // ...but the loop never busy-spins on it.
    expect(clampSleep(nextCheckDelayMs(deps([stalled]), NOW))).toBe(MIN_WATCHDOG_SLEEP_MS);
  });

  it('keeps the sleep bounded so an idle app still re-reads disk', () => {
    expect(clampSleep(24 * 60 * 60_000)).toBe(MAX_WATCHDOG_SLEEP_MS);
  });

  it('runs a pass immediately on start instead of waiting a full interval', async () => {
    let passes = 0;
    const stop = startWatchdog(
      deps([], { listTasks: () => { passes += 1; return []; } }),
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(passes).toBeGreaterThanOrEqual(1);
  });
});

describe('a long step is not drift', () => {
  /**
   * The forty-minute plan-stall rule was removed on 2026-11-16.
   *
   * It paused any task whose plan sat unchanged, calling it 「偏离目标」. But the steps that matter
   * most are precisely the ones that leave the plan untouched for an hour: an end-to-end run, a
   * real-device sweep, a full suite. Live T-1: a worker was mid-delivery with a fresh heartbeat and
   * the rule paused it anyway. Liveness is what the stall/orphaned/unreported rules measure, and
   * they measure it properly.
   */
  function withPlan(updatedAt: number): Task {
    return task({
      // A live worker: this is the exact fixture that used to be paused.
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 30_000, runStartedAt: NOW - 60_000 },
      updatedAt: updatedAt,
      spec: {
        plan: [
          { id: '1.0', title: '接口改造', status: 'done', updatedAt: NOW - 120 * 60_000 },
          { id: '1.1', title: '改 handler', status: 'doing', updatedAt },
        ],
      },
    });
  }

  it('leaves a worker whose plan is moving alone', () => {
    expect(inspectTasks(deps([withPlan(NOW - 60_000)]))).toEqual([]);
  })

  it('does not pause a live worker whose step has run for hours', () => {
    // Four hours on one step, heartbeat fresh: still working, so still not a problem.
    expect(inspectTasks(deps([withPlan(NOW - 4 * 60 * 60_000)]))).toEqual([]);
  })

  it('still notices the same worker when its heartbeat goes stale', () => {
    // The rule that should catch a stuck worker is liveness, and it still does.
    const stuck = task({
      stats: {
        runs: 1,
        activeMs: 0,
        lastHeartbeatAt: NOW - 4 * 60 * 60_000,
        runStartedAt: NOW - 5 * 60 * 60_000,
      },
      updatedAt: NOW - 4 * 60 * 60_000,
      spec: { plan: [{ id: '1.1', title: '改 handler', status: 'doing', updatedAt: NOW - 4 * 60 * 60_000 }] },
    })
    expect(inspectTasks(deps([stuck])).map((f) => f.kind)).toContain('stalled')
  })
})

describe('finished plan, nothing filed', () => {
  /**
   * A real run reached `done` on every step, said 「✅ 已完成」 in its transcript,
   * and never called report_result — so the task sat on `running` with zero
   * hand-offs, no verdict, and nothing that would ever notice.
   */
  const finished = (overrides: Partial<Task> = {}) =>
    task({
      updatedAt: NOW - 20 * 60_000,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 20 * 60_000 },
      spec: {
        plan: [
          { id: '1', title: 'a', status: 'done' },
          { id: '2', title: 'b', status: 'done' },
        ],
      },
      handoffs: [],
      ...overrides,
    })

  it('flags a task whose plan is complete with no hand-off', () => {
    const findings = inspectTasks(deps([finished()], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).toContain('unreported');
  })

  it('stays quiet once the worker filed something', () => {
    // The hand-off has to be from THIS run: an earlier session's report is still in the
    // record and must not silence the current executor.
    const filed = finished({ handoffs: [{ outcome: 'handoff', fromSessionId: 'sess-1', at: NOW, summary: 'x' }] as never });
    const findings = inspectTasks(deps([filed], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).not.toContain('unreported');
  })

  it('flags it even when the plan is unfinished', () => {
    // The regression this replaces. A worker finished its assigned slice (1.1 done),
    // the plan still had 1.2 and 2 open, and the old rule required a complete plan
    // before asking for a hand-off. So nothing asked: the task sat on 进行中 with zero
    // hand-offs and a supervisor that was never woken, while the worker had already
    // written its summary in the transcript and considered itself done.
    const half = finished({
      spec: { plan: [{ id: '1', title: 'a', status: 'done' }, { id: '2', title: 'b', status: 'todo' }] },
    });
    const findings = inspectTasks(deps([half], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).toContain('unreported');
  })

  it('does not silence a later leg because an earlier session reported', () => {
    const second = finished({
      currentWorkerSessionId: 'sess-2',
      handoffs: [{ outcome: 'handoff', fromSessionId: 'sess-1', at: NOW - 600_000, summary: 'x' }] as never,
    });
    const findings = inspectTasks(deps([second], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).toContain('unreported');
  })

  it('asks for the report rather than more work', () => {
    let reason: string | undefined;
    runWatchdogPass(
      deps([finished()], {
        sessionWorking: () => false,
        wakeSession: (_task, _sessionId, why) => {
          reason = why;
        },
      }),
    );
    expect(reason).toBe('unreported');
  })
})

describe('waiting is not stuck', () => {
  const idleTask = () =>
    task({
      updatedAt: NOW - 20 * 60_000,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 20 * 60_000 },
    })

  /**
   * A worker that backgrounded a long shell ends its turn on purpose and is woken by
   * `shell_completed`. Waking it on the idle clock makes it re-run or pre-empt work
   * that is still going — which is why "how long has it been quiet" could never be
   * the whole rule.
   */
  it('leaves a session waiting on a background task alone', () => {
    const findings = inspectTasks(
      deps([idleTask()], { sessionWorking: () => false, sessionWaiting: () => true }),
    )
    expect(findings).toEqual([]);
  })

  it('still wakes one that is not waiting on anything', () => {
    const findings = inspectTasks(
      deps([idleTask()], { sessionWorking: () => false, sessionWaiting: () => false }),
    )
    // Nothing filed this run, so the wake is 「交作业」 rather than 「继续」.
    expect(findings.map((f) => f.kind)).toContain('unreported')
  })
})

describe('a wake that did not happen is not reported as a wake', () => {
  /**
   * Production: the idle rule called `resumeTurn()` on a session whose turn had ended
   * normally. The subprocess answered `Cannot retry: no re-runnable model step`, nothing
   * resumed, and the supervisor was told 「已唤醒它继续」. The task then sat there while
   * both parties believed it had been woken.
   */
  const idleTask = () =>
    task({
      updatedAt: NOW - 20 * 60_000,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 20 * 60_000 },
    });

  const notices = () => {
    const sent: string[] = [];
    return { sent, notify: (_id: string, text: string) => sent.push(text) };
  };

  it('tells the supervisor when the wake returned false', () => {
    const { sent, notify } = notices();
    runWatchdogPass(
      deps([idleTask()], { sessionWorking: () => false, wakeSession: () => false, notify }),
    );
    expect(sent.join(' ')).toContain('唤醒失败');
  });

  it('tells the supervisor when the wake rejected', async () => {
    const { sent, notify } = notices();
    runWatchdogPass(
      deps([idleTask()], {
        sessionWorking: () => false,
        wakeSession: () => Promise.reject(new Error('cannot retry')),
        notify,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.join(' ')).toContain('唤醒失败');
  });

  it('reports success only once the wake resolved true', async () => {
    const { sent, notify } = notices();
    runWatchdogPass(
      deps([idleTask()], {
        sessionWorking: () => false,
        wakeSession: () => Promise.resolve(true),
        notify,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.join(' ')).toContain('已');
    expect(sent.join(' ')).not.toContain('唤醒失败');
  })
})

describe('the wake is not late', () => {
  /**
   * Reported: 「watchdog 还是没及时触发」. Both windows were five minutes, so a worker
   * that stopped at 13:42 was picked up at 13:47 — and the reason given for five was
   * that a pass cannot run more often than every five minutes. That stopped being true
   * once the loop began sleeping to `nextCheckDelayMs`: latency is now the grace itself.
   */
  it('asks a session that filed nothing well before the idle window', () => {
    const stopped = (msAgo: number) =>
      task({
        updatedAt: NOW - msAgo,
        stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - msAgo, runStartedAt: NOW - msAgo },
      });

    // Past the 90s grace, well under the 5 min idle window.
    expect(inspectTasks(deps([stopped(2 * 60_000)], { sessionWorking: () => false })).map((f) => f.kind))
      .toContain('unreported')
  })

  /**
   * The ninety-second grace answers "did it even start?" — a question that is only
   * open while the run has produced nothing. A real run sat idle from 16:26 to
   * 16:27:40 because the spawn grace was applied to a session that had already
   * finished a turn: there was nothing left to wait for, and the model was doing
   * nothing the whole time.
   */
  it('does not make a session that already worked wait out the spawn grace', () => {
    const worked = task({
      updatedAt: NOW - 6_000,
      // Started ten minutes ago, last moved six seconds ago: it ran, then stopped.
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 6_000, runStartedAt: NOW - 600_000 },
    })
    const findings = inspectTasks(deps([worked], { sessionWorking: () => false }))
    expect(findings.map((f) => f.kind)).toContain('unreported')
  })

  it('still gives a run that never moved the full spawn grace', () => {
    const notYet = task({
      updatedAt: NOW - 6_000,
      // Heartbeat and run start are the same instant: nothing has happened yet.
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 6_000, runStartedAt: NOW - 6_000 },
    })
    const findings = inspectTasks(deps([notYet], { sessionWorking: () => false }))
    // Still spawning, still reading its brief — not late for anything yet.
    expect(findings.map((f) => f.kind)).not.toContain('unreported')
  })

  it('schedules the check at that deadline, not at the idle window', () => {
    const stopped = task({
      updatedAt: NOW - 60_000,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 60_000, runStartedAt: NOW - 60_000 },
    })
    const delay = nextCheckDelayMs(deps([stopped], { sessionWorking: () => false }), NOW)
    // 30s left of the 90s grace; scheduling for the 5 min window would be minutes later.
    expect(delay).toBeLessThanOrEqual(31_000)
  })

  it('still gives a supervisor five minutes after a hand-off', () => {
    const filed = task({
      updatedAt: NOW - 60_000,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 60_000, runStartedAt: NOW - 600_000 },
      handoffs: [{ outcome: 'handoff', fromSessionId: 'sess-1', at: NOW - 60_000, summary: 'x' }] as never,
    })
    const findings = inspectTasks(deps([filed], { sessionWorking: () => false }))
    // Nothing owed by the worker; the ball is with the supervisor.
    expect(findings.map((f) => f.kind)).not.toContain('unreported')
  })
})

/**
 * A question being decided is not 「nobody is working」.
 *
 * Observed live, in this order: 11:30:47 the supervisor asked 「是否继续？」; 11:36:10 the watchdog
 * woke the executor with 「继续任务 T-1」; 11:41:57 it resumed step 1.2; 11:42:43 it added a step the
 * person had never agreed to. The task was `running` (asking does not change status) with an open
 * question on it, so every rule below read the state as stalled and told the work to carry on.
 */
describe('a task with an open question', () => {
  const openQuestion = {
    id: 'd-1',
    category: 'direction',
    label: '需要你决定',
    reason: '原指令授权仅到 1.1',
    question: '是否继续做 1.2？',
    askedAt: NOW - 10 * 60_000,
  }

  it('is never woken to continue, even when its session looks idle', () => {
    const findings = inspectTasks(
      deps([task({ decision: openQuestion as never, decisions: [openQuestion] })], {
        sessionWorking: () => false,
      }),
    )
    // The only finding that may survive is the deadline, which lives in the future here.
    expect(findings).toEqual([])
  })

  it('is not woken as unreported either', () => {
    const findings = inspectTasks(
      deps([task({ decision: openQuestion as never, decisions: [openQuestion], handoffs: [] })], {
        sessionWorking: () => false,
        sessionWaiting: () => false,
      }),
    )
    expect(findings.filter((f) => f.kind === 'unreported')).toEqual([])
    expect(findings.filter((f) => f.kind === 'idle')).toEqual([])
  })

  /**
   * The pause case is the one the rule did not used to reach.
   *
   * The check sat below `if (task.status !== 'running') continue`, but three paused-state rules ran
   * *above* that line — `upstream`, `process_lost`, and the unannounced-pause wake. So a paused task
   * with an open question could still be retried or announced while the person was deciding.
   * `awaiting_release` is the sharpest of the three: it produces a finding for any paused task that
   * was never announced, which is exactly the shape of a task waiting on a question.
   */
  const parkedOnQuestion = (over: Partial<Task> = {}) => task({
    status: 'paused',
    pauseReason: 'awaiting_release',
    decision: openQuestion as never,
    decisions: [openQuestion],
    // Never announced, and long past the grace — the unannounced-pause rule would fire.
    stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 4 * 60 * 60_000, runStartedAt: NOW - 5 * 60 * 60_000 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0, lastPausedAt: NOW - 60 * 60_000 },
    ...over,
  })

  it('is not announced as an unannounced pause while it waits on the question', () => {
    const findings = inspectTasks(
      deps([parkedOnQuestion()], { sessionExists: () => false, sessionWorking: () => false }),
    )
    expect(findings).toEqual([])
  })

  it('is not woken by the lost-process retry while it waits on the question', () => {
    // `process_lost` retries on its own — but not past a question the person has not answered.
    const findings = inspectTasks(
      deps([parkedOnQuestion({ pauseReason: 'process_lost' })], { sessionExists: () => false }),
    )
    expect(findings).toEqual([])
  })

  it('catches a question sitting second in the queue, not only the newest', () => {
    /**
     * `decision` is a mirror of the newest open question and `decisions` is the queue. A record can
     * hold an answered entry followed by an open one; reading only the mirror would let the open one
     * through, and the task would be inspected as if nobody were waiting.
     */
    const answered = {
      ...openQuestion,
      id: 'd-0',
      resolvedAt: NOW - 60_000,
      answer: { text: '继续', at: NOW - 60_000 },
    }
    const findings = inspectTasks(
      deps([parkedOnQuestion({ decision: answered as never, decisions: [answered, openQuestion] })], {
        sessionExists: () => false,
      }),
    )
    expect(findings).toEqual([])
  })

  it('resumes being watched once every question is answered', () => {
    const answered = { ...openQuestion, resolvedAt: NOW - 60_000, answer: { text: '继续', at: NOW - 60_000 } }
    // Long enough that any grace window has elapsed: the point is that answering re-arms the rules.
    const findings = inspectTasks(
      deps(
        [task({ decisions: [answered], updatedAt: NOW - 2 * 60 * 60_000, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: NOW - 2 * 60 * 60_000, runStartedAt: NOW - 2 * 60 * 60_000 } })],
        { sessionWorking: () => false },
      ),
    )
    expect(findings.length).toBeGreaterThan(0)
  })
})

describe('a hand-off that was accepted is not re-asked for', () => {
  /**
   * Live 2026-11-15 on T-2: `Handoff accepted.` at 16:40:44, and the same second the worker was
   * told 「no hand-off record arrived」 — three times in a row, each wake handing it the identical
   * 「## Hand-off context」 brief. The stamp only existed if the round had closed, and the round
   * had not: the worker had reported, `currentWorkerSessionId` had already moved, and both guards in
   * `hasFiledThisRun` compared against a session that was no longer the reporter.
   */
  const handoffAt = NOW - 5_000
  const quiet = { sessionWorking: () => false }

  it('does not ask again when the stamp belongs to this run, even if currentWorkerSessionId moved on', () => {
    const findings = inspectTasks(deps([
      task({
        // Long enough ago that the stopped-grace window is not what keeps it quiet.
        updatedAt: NOW - 20 * 60_000,
        stats: {
          runs: 1,
          activeMs: 0,
          lastHeartbeatAt: handoffAt,
          runStartedAt: NOW - 60_000,
          lastHandoffAt: handoffAt,
          lastHandoffSessionId: 'sess-reporter',
        },
        currentWorkerSessionId: 'sess-somebody-else',
        handoffs: [
          {
            at: handoffAt,
            fromSessionId: 'sess-reporter',
            summary: 'did the work',
            outcome: 'handoff',
            passed: true,
          },
        ],
      }),
    ], quiet))

    expect(findings.filter((finding) => finding.kind === 'unreported')).toHaveLength(0)
  })

  it('still asks when the stamp predates this run', () => {
    const findings = inspectTasks(deps([
      task({
        updatedAt: NOW - 20 * 60_000,
        // An unfinished plan: the nudge fires on 「this run owes a report」, not 「the plan is done」.
        spec: { plan: [{ id: '1', title: 'a', status: 'done' }, { id: '2', title: 'b', status: 'todo' }] },
        stats: {
          runs: 2,
          activeMs: 0,
          /**
           * Worked, stopped, and stopped a while ago.
           *
           * Heartbeat is after the claim (so the short 5 s 「worked then stopped」 grace applies)
           * and far enough before `now` to clear it. The report it owes is the point of the test;
           * the timings only have to let the rule look at it.
           */
          lastHeartbeatAt: NOW - 60_000,
          runStartedAt: NOW - 600_000,
          lastHandoffAt: NOW - 900_000,
          lastHandoffSessionId: 'sess-1',
        },
      }),
    ], quiet))

    expect(findings.filter((finding) => finding.kind === 'unreported')).toHaveLength(1)
  })
})

describe('a task parked on an unreachable provider', () => {
  /**
   * Live 2026-11-15, T-2: a 502 ended the supervisor's turn mid-dispatch, the task parked as
   * `awaiting_dispatch`, and every rule that reads 「the session stopped」 woke it again — three
   * identical briefs, each ending in the same 502, while nothing was retrying and nothing said
   * 「the provider is down」.
   */
  const parked = (overrides: Partial<Task> = {}) =>
    task({
      status: 'paused',
      pauseReason: 'upstream' as never,
      updatedAt: NOW - 5 * 60_000,
      ...overrides,
    })

  const strategiesOf = () => ['commandcode']

  it('is reported as upstream_wait and no other rule touches it', () => {
    const findings = inspectTasks(deps([parked({ handoffs: [] })], {
      sessionWorking: () => false,
      strategiesOf,
    }))
    expect(findings.map((f) => f.kind)).toEqual(['upstream_wait'])
  })

  it('names the strategy groups its own sessions use, deduplicated', () => {
    const findings = inspectTasks(deps([parked({ currentStageSessionId: 'sess-1' } as never)], {
      sessionWorking: () => false,
      strategiesOf: (_task, sessionIds) => {
        expect(sessionIds).toContain('sup')
        expect(sessionIds).toContain('sess-1')
        return ['commandcode', 'provider', 'provider']
      },
    }))
    const wait = findings.find((f) => f.kind === 'upstream_wait')
    expect(wait && 'strategies' in wait ? wait.strategies : null).toEqual(['commandcode', 'provider'])
  })

  /**
   * The flow is serial, so there is one holder and one answer.
   *
   * `currentWorkerSessionId` follows the work: the worker while it runs, the supervisor once the slice is
   * handed back, the acceptance session when it judges. Nothing to reconcile, and nothing stale —
   * the lifetime list (`sessionIds`) would carry dead sessions that never have a strategy to probe.
   */
  it('asks about the current holder and the supervisor, and nothing else', () => {
    let asked: string[] = []
    inspectTasks(deps([
      parked({
        sessionIds: ['ancient-1', 'ancient-2'],
        roundSessionIds: ['worker-a', 'worker-b'],
        currentWorkerSessionId: 'worker-b',
        currentStageSessionId: 'worker-b',
      } as never),
    ], {
      sessionWorking: () => false,
      strategiesOf: (_task, sessionIds) => {
        asked = sessionIds
        return ['commandcode']
      },
    }))
    expect(asked).toEqual(['worker-b', 'sup'])
    expect(asked).not.toContain('ancient-1')
    expect(asked).not.toContain('worker-a')
  })

  /**
   * Recovery is `resume`, not a nudge.
   *
   * The first version called `wakeSession(..., 'pause')`, which sends a sentence and leaves the
   * task exactly as paused — so the next pass found the same finding and sent it again, every
   * couple of seconds, forever. Live 2026-11-15 21:30: 「Task T-2 … is paused and waiting for you」
   * was re-steered into the same turn dozens of times and the task never moved.
   */
  it('resumes only when every group the task needs answers', async () => {
    const resumed: string[] = []
    const depsWithProbe = (answers: Record<string, boolean>) =>
      deps([parked()], {
        sessionWorking: () => false,
        strategiesOf: () => ['commandcode', 'provider'],
        probeStrategy: async (id) => answers[id] === true,
        resume: (task) => {
          resumed.push(task.id)
          return true
        },
        notify: () => undefined,
      })

    // One of the two groups is still down: the task must stay parked.
    await runWatchdogPass(depsWithProbe({ commandcode: true, provider: false }))
    expect(resumed).toEqual([])

    await runWatchdogPass(depsWithProbe({ commandcode: true, provider: true }))
    expect(resumed).toEqual(['T-1'])
  })

  it('probes each distinct group once, however many tasks wait on it', async () => {
    const probed: string[] = []
    await runWatchdogPass(deps([parked({ id: 'T-1' }), parked({ id: 'T-2' })], {
      sessionWorking: () => false,
      strategiesOf: () => ['commandcode'],
      probeStrategy: async (id) => {
        probed.push(id)
        return true
      },
      wakeSession: () => true,
      notify: () => undefined,
    }))
    expect(probed).toEqual(['commandcode'])
  })

  it('stays parked when the probe throws', async () => {
    const woken: string[] = []
    await runWatchdogPass(deps([parked()], {
      sessionWorking: () => false,
      strategiesOf,
      probeStrategy: async () => {
        throw new Error('probe exploded')
      },
      wakeSession: (_task, sessionId) => {
        woken.push(sessionId)
        return true
      },
      notify: () => undefined,
    }))
    expect(woken).toEqual([])
  })
})

describe('upstreamRecoveredFor', () => {
  it('needs every group, not any of them', () => {
    const answers = new Map([['a', true], ['b', false]])
    expect(upstreamRecoveredFor(['a', 'b'], answers)).toBe(false)
    expect(upstreamRecoveredFor(['a'], answers)).toBe(true)
  })

  it('refuses to resume a task with no recorded group', () => {
    // Resuming on no evidence is worse than staying parked: it recreates the 503 hop.
    expect(upstreamRecoveredFor([], new Map())).toBe(false)
  })

  it('treats a group the probe never answered as not recovered', () => {
    expect(upstreamRecoveredFor(['a'], new Map())).toBe(false)
  })
})

describe('which session the outage probe asks about', () => {
  /**
   * The record now separates 「the worker that ran」 from 「whoever is holding the task」.
   * Confusing them is what made `stopWorker` stop the wrong session during acceptance, and what
   * made the probe ask about a worker that had already handed off.
   */
  const parked2 = (overrides: Partial<Task> = {}) =>
    task({ status: 'paused', pauseReason: 'upstream' as never, updatedAt: NOW - 5 * 60_000, ...overrides })

  const asker = () => {
    const asked: string[][] = []
    return {
      asked,
      deps: (task: Task) => inspectTasks(deps([task], {
        sessionWorking: () => false,
        strategiesOf: (_task, sessionIds) => {
          asked.push([...sessionIds])
          return ['commandcode']
        },
      })),
    }
  }

  it('asks about the current stage holder, not the worker that already handed off', () => {
    const probe = asker()
    probe.deps(parked2({
      currentWorkerSessionId: 'worker-that-finished',
      currentStageSessionId: 'the-judge',
    } as never))
    expect(probe.asked[0]).toEqual(['the-judge', 'sup'])
    expect(probe.asked[0]).not.toContain('worker-that-finished')
  })

  it('follows the baton back to the supervisor once it holds the task', () => {
    const probe = asker()
    probe.deps(parked2({
      currentWorkerSessionId: 'worker-that-finished',
      currentStageSessionId: 'sup',
    } as never))
    // Deduplicated to one group rather than asking the same session twice.
    expect(probe.asked[0]).toEqual(['sup'])
  })

  /**
   * A record written before the split needs no fallback here.
   *
   * `normalizeTask` fills `currentStageSessionId` on read (from the old `currentSessionId`, then
   * the worker, then the supervisor), and `inspectTasks` only ever sees normalized tasks. So the
   * watchdog asks about the field and nothing else — a missing value means a task with no holder,
   * which is a real state, not a record to translate.
   */
  it('asks only about the holder and the supervisor, even for an old record', () => {
    const probe = asker()
    probe.deps(parked2({
      currentWorkerSessionId: 'old-style-worker',
      currentStageSessionId: 'normalized-holder',
    } as never))
    expect(probe.asked[0]).toEqual(['normalized-holder', 'sup'])
    expect(probe.asked[0]).not.toContain('old-style-worker')
  })
})

describe('the stage session tracks the baton', () => {
  /**
   * Four moments, and the recorded holder has to match the real one at each: created (the
   * supervisor is deciding), dispatched (a worker is working), handed back (the supervisor decides
   * again), acceptance (the judge is judging). The probe reads this field, so a stale value asks
   * about a provider that has nothing to do with why the task cannot move.
   */
  const parked3 = (overrides: Partial<Task> = {}) =>
    task({ status: 'paused', pauseReason: 'upstream' as never, updatedAt: NOW - 5 * 60_000, ...overrides })

  const askedFor = (t: Task): string[] => {
    let asked: string[] = []
    inspectTasks(deps([t], {
      sessionWorking: () => false,
      strategiesOf: (_task, sessionIds) => {
        asked = sessionIds
        return ['commandcode']
      },
    }))
    return asked
  }

  it('asks the supervisor on a task that has not dispatched yet', () => {
    expect(askedFor(parked3({
      currentStageSessionId: 'sup',
      currentWorkerSessionId: undefined,
    } as never))).toEqual(['sup'])
  })

  it('asks the worker while it works', () => {
    expect(askedFor(parked3({
      currentStageSessionId: 'sess-1',
      currentWorkerSessionId: 'sess-1',
    } as never))).toEqual(['sess-1', 'sup'])
  })

  it('asks the supervisor again once the report came back', () => {
    expect(askedFor(parked3({
      currentStageSessionId: 'sup',
      currentWorkerSessionId: 'sess-1',
    } as never))).toEqual(['sup'])
  })

  it('asks the judge while it judges', () => {
    expect(askedFor(parked3({
      currentStageSessionId: 'the-judge',
      currentWorkerSessionId: 'sess-1',
    } as never))).toEqual(['the-judge', 'sup'])
  })
})
