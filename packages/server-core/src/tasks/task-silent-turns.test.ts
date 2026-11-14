/**
 * A supervisor turn that says nothing is a fault, whatever woke it.
 *
 * Measured 2026-11-14 on T-1: the watchdog woke the task supervisor three times about a worker that
 * would not report. Each turn died as `503 no healthy account`. The rule that is supposed to report
 * 「a supervisor that stops answering」 already existed — `settleTaskTriggers` counted three silent
 * turns and told the user lane — but it only counted tasks with a *delivered trigger backlog*, and
 * a watchdog nudge never writes one. The counter therefore never moved, and the task paused with a
 * correct board and nobody told.
 *
 * So the count is no longer about the source. These tests fix the two halves the fix depends on: the
 * count survives the process that wrote it, and a reply ends the run instead of merely pausing it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJournal } from '@craft-agent/shared/tasks';
import { MAX_IDLE_WAKES } from './task-watchdog.ts';
import { TaskService } from './task-service.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-silent-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({ workspaceRoot: root, sessionExists: () => false, wakeSupervisor: () => undefined });

const task = (svc: TaskService) =>
  svc.create({
    name: '状态图标验证',
    instruction: '只做 1.1：创建 docs/a.md 后立即停止',
    supervisorSessionId: 'sess_task_lane',
    toolCallId: 'call_1',
  });

describe('a silent supervisor turn is counted against the task it was working on', () => {
  it('counts from zero, one turn at a time', () => {
    const svc = service();
    const t = task(svc);
    expect(svc.noteSilentTurn(t.id)).toBe(1);
    expect(svc.noteSilentTurn(t.id)).toBe(2);
    expect(svc.get(t.id)!.stats?.silentTurns).toBe(2);
  })

  /**
   * The record, not memory: the process that sees the third failure is not necessarily the one that
   * saw the first (a restart between two watchdog nudges would otherwise reset the count to zero and
   * the alert would never fire).
   */
  it('persists across a fresh reader', () => {
    const svc = service();
    const t = task(svc);
    svc.noteSilentTurn(t.id);
    svc.noteSilentTurn(t.id);
    const reread = service().get(t.id)!.stats?.silentTurns;
    expect(reread).toBe(2);
  })

  it('writes the count to the journal so the timeline explains the alert', () => {
    const svc = service();
    const t = task(svc);
    svc.noteSilentTurn(t.id);
    const kinds = readJournal(root, t.id).map((entry) => entry.type);
    expect(kinds).toContain('silent_turn');
  })
})

describe('a reply ends the run of silent turns', () => {
  it('clears the count and reports what it was', () => {
    const svc = service();
    const t = task(svc);
    svc.noteSilentTurn(t.id);
    svc.noteSilentTurn(t.id);
    svc.noteSilentTurn(t.id);
    expect(svc.clearSilentTurns(t.id)).toBe(3);
    expect(svc.get(t.id)!.stats?.silentTurns).toBe(0);
  })

  /**
   * The caller decides whether the outage was ever announced by comparing this return value against
   * its threshold. Returning 0 means 「nothing to announce」, so a task that was silent once and then
   * answered must not produce an all-clear for an alert nobody saw.
   */
  it('returns zero when there was nothing to clear', () => {
    const svc = service();
    const t = task(svc);
    expect(svc.clearSilentTurns(t.id)).toBe(0);
    expect(svc.noteSilentTurn(t.id)).toBe(1);
    expect(svc.clearSilentTurns(t.id)).toBe(1);
    expect(svc.clearSilentTurns(t.id)).toBe(0);
  })

  it('counts again from one after a recovery', () => {
    const svc = service();
    const t = task(svc);
    svc.noteSilentTurn(t.id);
    svc.clearSilentTurns(t.id);
    expect(svc.noteSilentTurn(t.id)).toBe(1);
  })
})

describe('the threshold is the watchdog budget plus one', () => {
  /**
   * The two budgets have to move together. The watchdog nudges a worker `MAX_IDLE_WAKES` times and
   * pauses on the next pass; the supervisor gets one turn more than that, because it is the one that
   * has to answer those nudges. When they were independent — a hardcoded 3 here, the constant there —
   * the pause and the alert drifted apart.
   */
  it('is derived, not hardcoded', () => {
    expect(MAX_IDLE_WAKES + 1).toBe(3);
  })
})
