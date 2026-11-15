import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyTransition,
  assertTransition,
  canTransition,
  checkBudget,
  checkHandoffRules,
  IllegalTransitionError,
  isHeartbeatStalled,
  normalizeHandoff,
  recordRunResult,
  shouldRotateSession,
  shouldTripFuse,
} from '../state.ts';
import {
  activeTasks,
  appendJournal,
  deleteTask,
  attachSession,
  createTask,
  getJournalPath,
  getTaskPath,
  loadIndex,
  loadTask,
  nextTaskId,
  readJournal,
  saveTask,
} from '../store.ts';
import { FAILURE_FUSE } from '../types.ts';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-tasks-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function task(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  return createTask({
    id: 'T-1',
    name: '多 Agent 上线',
    instruction: '把多 Agent 功能做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    ...overrides,
  });
}

describe('state machine', () => {
  it('allows the documented moves', () => {
    expect(canTransition('backlog', 'running')).toBe(true);
    expect(canTransition('running', 'paused')).toBe(true);
    expect(canTransition('running', 'running')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('rejects moves that skip the lifecycle', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('canceled', 'running')).toBe(false);
    expect(() => assertTransition('completed', 'running')).toThrow(IllegalTransitionError);
  });

  it('lets a paused task finish its round, because the pause can land mid-turn', () => {
    // A watchdog stall check (or a budget stop) pauses the task while the worker's turn is still
    // running — stopping a session is cooperative, so the `report_result` already in flight still
    // arrives. `closeRound` ends by returning the record to `backlog`; with no edge there, that
    // write threw `IllegalTransitionError` straight out of `reportHandoff`.
    const paused = applyTransition(task(), 'paused', { now: 10, pauseReason: 'process_lost' }).task;
    const closed = applyTransition(paused, 'backlog', { now: 20 });
    expect(closed.changed).toBe(true);
    expect(closed.task.status).toBe('backlog');
  });

  it('lets a paused task be closed, because the pause is what the person decides on', () => {
    // The supervisor learns a task is done by reading why it paused (a failure, a budget stop, a
    // worker that went quiet). Without this edge that decision was refused by the state machine and
    // the task could only reach `canceled` — which says 「never mind」, not 「finished」.
    const paused = applyTransition(task(), 'paused', { now: 10, pauseReason: 'budget' }).task;
    const done = applyTransition(paused, 'completed', { now: 20 });
    expect(done.changed).toBe(true);
    expect(done.task.status).toBe('completed');
  });

  it('records the pause reason and clears it on resume', () => {
    const paused = applyTransition(task(), 'paused', { now: 10, pauseReason: 'budget' }).task;
    expect(paused.pauseReason).toBe('budget');
    expect(paused.lifecycle.lastPausedAt).toBe(10);

    const resumed = applyTransition(paused, 'running', { now: 20 }).task;
    expect(resumed.pauseReason).toBeNull();
    // `lastRecoveredAt` used to be stamped here and never read by anyone. It is gone; what resumes a
    // task is the status itself.
    expect(resumed.lifecycle.lastPausedAt).toBe(10);
  });

  it('counts failures on the failed transition', () => {
    const failed = applyTransition(task(), 'failed', { now: 5, error: 'boom' }).task;
    expect(failed.lifecycle.errorCount).toBe(1);
    expect(failed.lifecycle.lastError).toBe('boom');
  });
});

describe('handoff', () => {
  it('defaults to handoff, never delivered', () => {
    const h = normalizeHandoff({}, 'sess_1', 1);
    expect(h.outcome).toBe('handoff');
    expect(h.summary).toBe('未提供交接内容');
  });

  it('caps the summary and keeps structured fields', () => {
    const h = normalizeHandoff(
      {
        outcome: 'delivered',
        summary: 'x'.repeat(500),
        keyFindings: ['a', '', 'b'],
        nextAction: '跑测试',
        artifacts: [{ path: '/tmp/a.txt', note: 'log' }, { note: 'no path' }],
        verify: { ran: ['bun test', ''], passed: true },
      },
      'sess_1',
      1,
    );
    expect(h.summary).toHaveLength(200);
    expect(h.keyFindings).toEqual(['a', 'b']);
    expect(h.artifacts).toHaveLength(1);
    expect(h.verify?.ran).toEqual(['bun test']);
  });

  it('fails the rule gate without artifacts or a verification run', () => {
    const h = normalizeHandoff({ summary: 'done' }, 'sess_1', 1);
    const verdict = checkHandoffRules(h, () => ({ exists: true, nonEmpty: true }));
    expect(verdict.passed).toBe(false);
    // The reason has to tell the reader what to do, not just which rule tripped.
    expect(verdict.reasons.join(' ')).toContain('artifacts');
    expect(verdict.reasons.join(' ')).toContain('verify.ran');
  });

  it('fails when an artifact path does not exist', () => {
    const h = normalizeHandoff(
      { artifacts: [{ path: '/missing' }], verify: { ran: ['bun test'], passed: true } },
      'sess_1',
      1,
    );
    expect(checkHandoffRules(h, () => ({ exists: false, nonEmpty: false })).reasons).toContain('missing artifact: /missing');
  });

  it('passes when artifacts exist and verification passed', () => {
    const h = normalizeHandoff(
      { artifacts: [{ path: '/ok' }], verify: { ran: ['bun test'], passed: true } },
      'sess_1',
      1,
    );
    expect(checkHandoffRules(h, () => ({ exists: true, nonEmpty: true })).passed).toBe(true);
  });

  it('never passes a needs_decision handoff', () => {
    const h = normalizeHandoff({ outcome: 'needs_decision' }, 'sess_1', 1);
    expect(checkHandoffRules(h, () => ({ exists: true, nonEmpty: true })).passed).toBe(false);
  });
});

describe('budget and fuse', () => {
  const budget = { maxSessions: 2, maxRuns: 2, activeMinutes: 10, deadline: null };

  it('passes inside the limits', () => {
    expect(checkBudget(budget, { sessions: 2, runs: 2, activeMinutes: 10 }, 0).exceeded).toBe(false);
  });

  it('fails past the session limit', () => {
    expect(checkBudget(budget, { sessions: 3, runs: 0, activeMinutes: 0 }, 0).exceeded).toBe(true);
  });

  it('does not treat runs or active minutes as a limit any more', () => {
    // A recurring task blows through both by design: 「每分钟一次」 reaches 12 runs in twelve
    // minutes. Those numbers were a round cap wearing a budget's name, and they paused a task the
    // person had explicitly asked to loop.
    expect(checkBudget(budget, { sessions: 0, runs: 3, activeMinutes: 0 }, 0).exceeded).toBe(false);
    expect(checkBudget(budget, { sessions: 0, runs: 0, activeMinutes: 11 }, 0).exceeded).toBe(false);
    expect(checkBudget(budget, { sessions: 0, runs: 500, activeMinutes: 10_000 }, 0).exceeded).toBe(false);
  });

  it('fails a passed deadline', () => {
    const verdict = checkBudget(
      { ...budget, deadline: 100 },
      { sessions: 0, runs: 0, activeMinutes: 0 },
      101,
    );
    expect(verdict.exceeded).toBe(true);
  });

  it('trips the fuse after three consecutive failures and resets on success', () => {
    let lifecycle: { errorCount: number; consecutiveFailures: number; lastError?: string } = {
      errorCount: 0,
      consecutiveFailures: 0,
    };
    for (let i = 0; i < FAILURE_FUSE; i += 1) {
      lifecycle = recordRunResult(lifecycle, false, i, 'boom');
    }
    expect(shouldTripFuse(lifecycle)).toBe(true);
    expect(lifecycle.errorCount).toBe(FAILURE_FUSE);

    lifecycle = recordRunResult(lifecycle, true, 9);
    expect(lifecycle.consecutiveFailures).toBe(0);
    expect(lifecycle.lastError).toBeUndefined();
    // The audit trail survives a success.
    expect(lifecycle.errorCount).toBe(FAILURE_FUSE);
  });

  it('detects a stalled heartbeat after two missed intervals', () => {
    const t = { ...task(), lastHeartbeatAt: 0, heartbeatIntervalMin: 10 };
    expect(isHeartbeatStalled(t, 19 * 60_000)).toBe(false);
    expect(isHeartbeatStalled(t, 21 * 60_000)).toBe(true);
  });

  it('rotates the session past the context threshold', () => {
    expect(shouldRotateSession(0.69)).toBe(false);
    expect(shouldRotateSession(0.7)).toBe(true);
  });
});

describe('store', () => {
  it('round-trips a task and updates the index', () => {
    const ws = workspace();
    const t = task();
    saveTask(ws, t);

    const loaded = loadTask(ws, 'T-1');
    expect(loaded?.name).toBe('多 Agent 上线');

    const active = activeTasks(ws);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe('T-1');
  });

  it('hands out increasing ids', () => {
    const ws = workspace();
    expect(nextTaskId(ws)).toBe('T-1');
    expect(nextTaskId(ws)).toBe('T-2');
  });

  it('appends journal lines without rewriting', () => {
    const ws = workspace();
    appendJournal(ws, 'T-1', { type: 'created', at: 1 });
    appendJournal(ws, 'T-1', { type: 'handoff', at: 2, data: { outcome: 'handoff' } });

    const journal = readJournal(ws, 'T-1');
    expect(journal).toHaveLength(2);
    expect(journal[1]?.type).toBe('handoff');
  });

  it('attaches sessions without duplicating them', () => {
    const t = attachSession(task(), 'sess_a', 1);
    const again = attachSession(t, 'sess_a', 2);
    expect(again.sessionIds).toEqual(['sess_a']);
    expect(again.currentWorkerSessionId).toBe('sess_a');
  });

  it('returns null for a missing or corrupt task file', () => {
    const ws = workspace();
    expect(loadTask(ws, 'T-404')).toBeNull();
  });
});

/**
 * Deleting a task removes the record, the journal and the index entry — and the
 * id is not handed back. Reusing a number would leave an old log line pointing
 * at a different task, and the journal is meant to be evidence.
 */
describe('deleting a task', () => {
  it('removes the record, the journal and the index entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-task-rm-'));
    const task = createTask({ id: 'T-1', name: 'cleanup', instruction: 'x', supervisorSessionId: 's', toolCallId: 'c', now: 1 });
    saveTask(root, task);
    appendJournal(root, 'T-1', { type: 'created', at: 1, data: {} });

    expect(existsSync(getTaskPath(root, 'T-1'))).toBe(true);
    expect(existsSync(getJournalPath(root, 'T-1'))).toBe(true);
    expect(loadIndex(root).tasks.map((t) => t.id)).toContain('T-1');

    expect(deleteTask(root, 'T-1')).toBe(true);

    expect(existsSync(getTaskPath(root, 'T-1'))).toBe(false);
    expect(existsSync(getJournalPath(root, 'T-1'))).toBe(false);
    expect(loadIndex(root).tasks.map((t) => t.id)).not.toContain('T-1');
    rmSync(root, { recursive: true, force: true });
  });

  it('does not hand the id back to the pool', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-task-rm2-'));
    expect(nextTaskId(root)).toBe('T-1');
    deleteTask(root, 'T-1');
    // Still T-2: a deleted number stays retired, so old log lines keep meaning
    // what they meant.
    expect(nextTaskId(root)).toBe('T-2');
    rmSync(root, { recursive: true, force: true });
  });

  it('is idempotent so a second click cannot raise an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-task-rm3-'));
    expect(deleteTask(root, 'T-404')).toBe(false);
    expect(deleteTask(root, 'T-404')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('a pending decision cannot be answered by the executor', () => {
  /**
   * Observed: a task paused for 「是否放行剩余步骤」. The supervisor read the request in its
   * own lane, decided on the user's behalf (「按你最初的授权，我拍板选 (b)」), resumed the
   * task, marked the excluded steps done and added a new one. The user never saw a question
   * they could answer, and 「不要碰 1.2 和 2」 was reversed without anyone noticing.
   *
   * `paused → running` is a legal resume because most pauses are the system's own
   * interruptions. This one was a question addressed to a person.
   */
  const awaiting = () =>
    ({
      id: 'T-1',
      name: 't',
      instruction: 'x',
      status: 'paused' as const,
      pauseReason: 'needs_decision' as const,
      supervisorSessionId: 'sup',
      sessionIds: [],
      dependsOn: [],
      priority: 1,
      budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 120, deadline: null },
      handoffs: [],
      verify: { enabled: false, maxIterations: 2 },
      lifecycle: { errorCount: 0, consecutiveFailures: 0 },
      origin: { supervisorSessionId: 'sup', toolCallId: 'c' },
      heartbeatIntervalMin: 10,
      createdAt: 0,
      updatedAt: 0,
      decision: {
        category: 'direction' as const,
        label: '范围内的工作已完成',
        reason: '还剩 1.2 和 2 未授权',
        askedAt: 0,
        deadlineAt: Date.now() + 60_000,
      },
    }) as never;

  it('refuses to resume a task that is waiting for an answer', () => {
    expect(() => applyTransition(awaiting(), 'running', { now: 1 })).toThrow(/等待用户拍板/);
  })

  it('resumes once the decision is resolved', () => {
    const task = { ...(awaiting() as Record<string, unknown>) } as never;
    (task as { decision: { resolvedAt: number } }).decision.resolvedAt = 1;
    const result = applyTransition(task, 'running', { now: 2 });
    expect(result.changed).toBe(true);
    expect(result.task.status).toBe('running');
  })

  it('still resumes an ordinary pause', () => {
    const task = { ...(awaiting() as Record<string, unknown>), decision: undefined } as never;
    (task as { pauseReason: string }).pauseReason = 'waiting';
    const result = applyTransition(task, 'running', { now: 2 });
    expect(result.task.status).toBe('running');
  })
})
