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
    currentSessionId: 'sess-1',
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
      currentSessionId: 'sess-gone',
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

describe('decision timeout', () => {
  it('finds a decision whose deadline passed', () => {
    const waiting = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'destroy-data',
        label: '删数据',
        reason: '命中高风险类别',
        askedAt: NOW - 13 * 60 * 60_000,
        deadlineAt: NOW - 1000,
      },
    });
    expect(inspectTasks(deps([waiting])).map((f) => f.kind)).toEqual(['decision_timeout']);
  });

  it('leaves an answered decision alone', () => {
    const answered = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'destroy-data',
        label: '删数据',
        reason: '命中高风险类别',
        askedAt: NOW - 13 * 60 * 60_000,
        deadlineAt: NOW - 1000,
        resolvedAt: NOW - 500,
        resolution: 'approved',
      },
    });
    expect(inspectTasks(deps([answered]))).toEqual([]);
  });

  it('does not fire before the deadline', () => {
    const pending = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'spend-money',
        label: '花钱',
        reason: '命中高风险类别',
        askedAt: NOW,
        deadlineAt: NOW + 60_000,
      },
    });
    expect(inspectTasks(deps([pending]))).toEqual([]);
  });

  it('defaults to refusal: denies instead of pausing again', () => {
    const denied: string[] = [];
    const notified: string[] = [];
    const waiting = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'destroy-data',
        label: '删数据',
        reason: '命中高风险类别',
        askedAt: NOW - 13 * 60 * 60_000,
        deadlineAt: NOW - 1000,
      },
    });

    const acted = runWatchdogPass(
      deps([waiting], {
        denyDecision: (id) => denied.push(id),
        pause: () => {
          throw new Error('a timeout must not re-pause the task');
        },
        notify: (_sup, text) => notified.push(text),
      }),
    );

    expect(acted).toBe(1);
    expect(denied).toEqual(['T-1']);
    expect(notified[0]).toContain('超时');
    expect(notified[0]).toContain('拒绝');
  });
});

describe('loop detection', () => {
  function withHandoffs(summaries: string[]): Task {
    return task({
      handoffs: summaries.map((summary, index) => ({
        at: NOW - (summaries.length - index) * 1000,
        fromSessionId: 'sess-1',
        outcome: 'handoff' as const,
        summary,
      })),
    });
  }

  it('flags three identical handoffs in a row', () => {
    const looping = withHandoffs(['还在改', '还在改', '还在改']);
    expect(inspectTasks(deps([looping])).map((f) => f.kind)).toEqual(['looping']);
  });

  it('ignores a repeat that is followed by progress', () => {
    const progressing = withHandoffs(['还在改', '还在改', '改完了，开始测试']);
    expect(inspectTasks(deps([progressing]))).toEqual([]);
  });

  it('treats whitespace-only differences as the same report', () => {
    const looping = withHandoffs(['还在 改', '还在改', '还在  改']);
    expect(inspectTasks(deps([looping])).map((f) => f.kind)).toEqual(['looping']);
  });

  it('pauses a looping worker instead of killing its session', () => {
    const paused: string[] = [];
    const looping = withHandoffs(['还在改', '还在改', '还在改']);
    runWatchdogPass(
      deps([looping], {
        pause: (id) => paused.push(id),
        notify: () => undefined,
      }),
    );
    expect(paused).toEqual(['T-1']);
  });
});

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

  it('wakes at the decision deadline rather than on a fixed tick', () => {
    const waiting = task({
      status: 'paused',
      pauseReason: 'needs_decision',
      decision: {
        category: 'spend-money',
        label: '花钱',
        reason: 'x',
        askedAt: NOW,
        deadlineAt: NOW + 7 * 60_000,
      },
    });
    expect(nextCheckDelayMs(deps([waiting]), NOW)).toBe(7 * 60_000);
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

describe('plan drift', () => {
  function withPlan(updatedAt: number): Task {
    return task({
      // Fresh heartbeat: the worker is alive, it simply stopped reporting
      // progress — that is exactly the case the plan check exists for.
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
  });

  it('flags a plan that stopped moving for 40 minutes', () => {
    const findings = inspectTasks(deps([withPlan(NOW - 41 * 60_000)]));
    expect(findings.map((f) => f.kind)).toEqual(['off_track']);
  });

  it('pauses the task and says how far it got', () => {
    const paused: string[] = [];
    const notified: string[] = [];
    runWatchdogPass(
      deps([withPlan(NOW - 41 * 60_000)], {
        pause: (id) => paused.push(id),
        notify: (_sup, text) => notified.push(text),
      }),
    );
    expect(paused).toEqual(['T-1']);
    expect(notified[0]).toContain('1/2');
  });

  it('does not flag a task that has no plan', () => {
    const noPlan = task({ updatedAt: NOW - 60_000 });
    expect(inspectTasks(deps([noPlan]))).toEqual([]);
  });
});

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
      currentSessionId: 'sess-2',
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
    deadlineAt: NOW + 60 * 60_000,
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

  it('still expires the unanswered question at its deadline', () => {
    // Waiting forever is the other failure: a question nobody answers must close itself.
    // The deadline rule reads the `decision` mirror, so the fixture has to carry both —
    // the store derives the mirror from the queue on every save.
    const overdue = { ...openQuestion, deadlineAt: NOW - 1 }
    const findings = inspectTasks(
      deps([task({ decision: overdue as never, decisions: [overdue] })], {
        sessionWorking: () => false,
      }),
    )
    expect(findings.map((f) => f.kind)).toEqual(['decision_timeout'])
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
