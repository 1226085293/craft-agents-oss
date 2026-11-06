import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  attachSession,
  createTask,
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

  it('records the pause reason and clears it on resume', () => {
    const paused = applyTransition(task(), 'paused', { now: 10, pauseReason: 'budget' }).task;
    expect(paused.pauseReason).toBe('budget');
    expect(paused.lifecycle.lastPausedAt).toBe(10);

    const resumed = applyTransition(paused, 'running', { now: 20 }).task;
    expect(resumed.pauseReason).toBeNull();
    expect(resumed.lifecycle.lastRecoveredAt).toBe(20);
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
    expect(verdict.reasons).toContain('no artifacts');
    expect(verdict.reasons).toContain('no verification command was run');
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

  it('fails past any limit', () => {
    expect(checkBudget(budget, { sessions: 3, runs: 0, activeMinutes: 0 }, 0).exceeded).toBe(true);
    expect(checkBudget(budget, { sessions: 0, runs: 3, activeMinutes: 0 }, 0).exceeded).toBe(true);
    expect(checkBudget(budget, { sessions: 0, runs: 0, activeMinutes: 11 }, 0).exceeded).toBe(true);
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
    let lifecycle: { errorCount: number; consecutiveFailures: number; lastError?: string; lastRecoveredAt?: number } = {
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
    expect(again.currentSessionId).toBe('sess_a');
  });

  it('returns null for a missing or corrupt task file', () => {
    const ws = workspace();
    expect(loadTask(ws, 'T-404')).toBeNull();
  });
});
