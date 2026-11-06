import { describe, expect, it } from 'bun:test';

import type { Task } from '@craft-agent/shared/tasks';

import {
  inspectTasks,
  MAX_WATCHDOG_FAILURES,
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
