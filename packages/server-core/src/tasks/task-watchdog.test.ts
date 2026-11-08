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
    const findings = inspectTasks(
      deps([task({ updatedAt: idleSince, stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince } })], {
        sessionWorking: () => false,
      }),
    );
    expect(findings.map((f) => f.kind)).toContain('idle');
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

  it('pauses the task once the wakes are spent', () => {
    // A wake that keeps not working is a loop paying for a model turn each time.
    const pauses: string[] = [];
    const idle = task({
      updatedAt: idleSince,
      stats: { runs: 1, activeMs: 0, lastHeartbeatAt: idleSince, wakeAttempts: 2 },
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
    const filed = finished({ handoffs: [{ outcome: 'handoff', fromSessionId: 's', at: NOW, summary: 'x' }] as never });
    const findings = inspectTasks(deps([filed], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).not.toContain('unreported');
  })

  it('stays quiet while the plan is unfinished', () => {
    const half = finished({
      spec: { plan: [{ id: '1', title: 'a', status: 'done' }, { id: '2', title: 'b', status: 'todo' }] },
    });
    const findings = inspectTasks(deps([half], { sessionWorking: () => false }));
    expect(findings.map((f) => f.kind)).not.toContain('unreported');
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
