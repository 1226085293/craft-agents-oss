import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getJournalPath, type Task } from '@craft-agent/shared/tasks';

import { recordMissedCronRuns, runCronPass, type TaskRunnerDeps } from './task-scheduler.ts';
import { TaskService } from './task-service.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-scheduler-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeService(): TaskService {
  return new TaskService({
    workspaceRoot: root,
    now: () => Date.UTC(2026, 10, 6, 0, 0, 0),
    // A spawned worker is alive; ids the test never created are not.
    sessionExists: (id: string) => id.startsWith('sess-'),
    wakeSupervisor: () => undefined,
  });
}

function cronTask(id: string, expr: string, lastTriggeredAt?: number): Task {
  return {
    id,
    name: `task ${id}`,
    instruction: 'x',
    status: 'backlog',
    pauseReason: null,
    supervisorSessionId: 'sup',
    sessionIds: [],
    dependsOn: [],
    priority: 1,
    budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
    handoffs: [],
    verify: { enabled: false, maxIterations: 2 },
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    origin: { supervisorSessionId: 'sup', toolCallId: 'call-1' },
    trigger: { kind: 'cron', expr, enabled: true },
    stats: { runs: 1, activeMs: 0, ...(lastTriggeredAt ? { lastTriggeredAt } : {}) },
    heartbeatIntervalMin: 10,
    createdAt: 0,
    updatedAt: 0,
  };
}

function depsWith(tasks: Task[], service: TaskService, started: string[]): TaskRunnerDeps {
  return {
    listTasks: () => tasks,
    tasks: service,
    spawnRun: async (task) => {
      started.push(task.id);
      return { sessionId: `sess-${task.id}` };
    },
  };
}

function journalTypes(id: string): string[] {
  const path = getJournalPath(root, id);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);
}

describe('cron gap policy', () => {
  it('records every missed minute while the app was closed and starts nothing', () => {
    const service = makeService();
    // Daily at 09:00. Last fired two days ago.
    const last = Date.UTC(2026, 10, 4, 9, 0, 0);
    const task = cronTask('T-1', '0 9 * * *', last);
    const started: string[] = [];

    const now = new Date(Date.UTC(2026, 10, 6, 12, 0, 0));
    const recorded = recordMissedCronRuns(depsWith([task], service, started), now);

    expect(recorded).toBe(1);
    expect(started).toEqual([]);
    const types = journalTypes('T-1');
    expect(types).toContain('cron_missed');
  });

  it('does not report a gap for a task that never ran', () => {
    const service = makeService();
    const task = cronTask('T-2', '0 9 * * *');
    const started: string[] = [];

    const recorded = recordMissedCronRuns(
      depsWith([task], service, started),
      new Date(Date.UTC(2026, 10, 6, 12, 0, 0)),
    );

    expect(recorded).toBe(0);
    expect(journalTypes('T-2')).toEqual([]);
  });

  it('reports nothing when the last run was recent', () => {
    const service = makeService();
    const now = Date.UTC(2026, 10, 6, 12, 0, 0);
    const task = cronTask('T-3', '0 9 * * *', now - 60_000);
    const started: string[] = [];

    expect(recordMissedCronRuns(depsWith([task], service, started), new Date(now))).toBe(0);
  });

  it('ignores disabled, terminal and non-cron tasks', () => {
    const service = makeService();
    const last = Date.UTC(2026, 10, 1, 9, 0, 0);
    const tasks: Task[] = [
      { ...cronTask('T-4', '0 9 * * *', last), trigger: { kind: 'cron', expr: '0 9 * * *', enabled: false } },
      { ...cronTask('T-5', '0 9 * * *', last), status: 'completed' },
      { ...cronTask('T-6', '0 9 * * *', last), trigger: { kind: 'manual' } },
    ];
    const started: string[] = [];

    const recorded = recordMissedCronRuns(
      depsWith(tasks, service, started),
      new Date(Date.UTC(2026, 10, 6, 12, 0, 0)),
    );

    expect(recorded).toBe(0);
    expect(started).toEqual([]);
  });
});

describe('cron pass', () => {
  it('starts a due task once per matching minute', async () => {
    const service = makeService();
    const started: string[] = [];

    // A real task record, so the run lock and the gate behave as in production.
    const stored = service.create({
      name: 'task T-7',
      instruction: 'x',
      supervisorSessionId: 'sup',
      toolCallId: 'call-7',
      trigger: { kind: 'cron', expr: '0 9 * * *', enabled: true },
    });
    // Re-read from disk, exactly like production: the scheduler must see the
    // state left by the previous pass (status running + the run lock).
    const deps = { ...depsWith([], service, started), listTasks: () => service.list() };

    const due = await runCronPass(deps, new Date(Date.UTC(2026, 10, 6, 9, 0, 0)));
    expect(due).toBe(1);
    expect(started).toEqual([stored.id]);

    // Same minute again: the run lock is held, so nothing new starts.
    const again = await runCronPass(deps, new Date(Date.UTC(2026, 10, 6, 9, 0, 0)));
    expect(again).toBe(0);
  });

  it('does not start a task that is not due', async () => {
    const service = makeService();
    const started: string[] = [];
    const stored = service.create({
      name: 'task T-8',
      instruction: 'x',
      supervisorSessionId: 'sup',
      toolCallId: 'call-8',
      trigger: { kind: 'cron', expr: '0 9 * * *', enabled: true },
    });

    const due = await runCronPass(
      depsWith([stored], service, started),
      new Date(Date.UTC(2026, 10, 6, 10, 0, 0)),
    );
    expect(due).toBe(0);
    expect(started).toEqual([]);
  });
});
