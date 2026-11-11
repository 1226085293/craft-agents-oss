/**
 * The turn-end flush has four ways to lose or duplicate a question. Each one is a case here.
 *
 * They are not hypothetical: every one was reachable in the code as first written, and each is
 * invisible from the happy path — the card appears, the tests pass, and the defect only shows as
 * 「这个问题我问过，但用户说没看到」 or 「同一个问题弹了两次」.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDecisions, undeliveredQuestions } from '@craft-agent/shared/tasks';

import { SessionManager, createManagedSession } from './SessionManager.ts';
import { TaskService } from '../tasks/task-service.ts';

describe('question flush safety', () => {
  let tmpRoot: string;
  let sm: SessionManager;

  let tasks: TaskService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-flush-'));
    sm = new SessionManager();
    // A real task service over a temp root: the flush's contract is with the record, so a stub
    // would test the stub. `getTasks` is replaced because workspace registration is not part of
    // what these cases are about.
    tasks = new TaskService({
      workspaceRoot: tmpRoot,
      sessionExists: () => true,
      getTask: (id: string) => tasks.get(id),
    } as never);
    ;(sm as unknown as { getTasks: unknown }).getTasks = () => tasks;
  });

  afterEach(async () => {
    await sm.flushAllSessions();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function buildSupervisor(id: string, lane: 'user' | 'task') {
    const workspace = { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() };
    const managed = createManagedSession({ id, name: `督导 · ${lane}` }, workspace as never, {
      messagesLoaded: true,
    });
    managed.supervisorLane = lane;
    managed.agent = { chat: () => undefined } as never;
    managed.isProcessing = false;
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed);
    return managed;
  }

  function task(over: Record<string, unknown> = {}) {
    return tasks.create({
      name: 'T-1',
      instruction: '做点事',
      supervisorSessionId: 'sess_task',
      toolCallId: `call-${Math.random()}`,
      ...over,
    } as never);
  }

  const flush = async (managed: { id: string }) =>
    (sm as unknown as {
      flushPendingQuestions: (m: unknown) => Promise<void>;
    }).flushPendingQuestions(managed);

  /**
   * 1. A delivery that fails must not be marked as sent.
   *
   * `deliverQuestionToUserLane` used to `return` when it could not open the reader lane — a silent
   * success. The flush then wrote `questionDeliveredAt` on questions nobody had seen, and the next
   * turn's list was empty, so they were never retried. Throwing is what lets the caller tell.
   */
  it('leaves the question pending when the reader lane cannot be opened', async () => {
    const sup = buildSupervisor('sess_task', 'task');
    const t = task();
    tasks.setDecisionWording(t.id, { question: '要不要做 2？' });

    // No user lane exists and creating one fails — the delivery has nowhere to land.
    ;(sm as unknown as { ensureSupervisorSession: unknown }).ensureSupervisorSession = async () => {
      throw new Error('no reader lane');
    };
    ;(sm as unknown as { resolveReaderLane: unknown }).resolveReaderLane = async () => undefined;

    await flush(sup);

    // Still pending: nothing was shown, so nothing may claim to have been.
    expect(undeliveredQuestions(tasks.get(t.id)!)).toHaveLength(1);
    expect(openDecisions(tasks.get(t.id)!)).toHaveLength(1);
  });

  /**
   * 2. A question about no task at all must still reach the person.
   *
   * The flush reads questions off a task. With none, `writeUserVisible` used to record nothing and
   * deliver nothing — the question vanished, and no card, log line or retry ever mentioned it.
   *
   * The routing rule is asserted directly rather than through a whole session build: the binding
   * that holds it is created inline per session, so a test that could not reach the rule is a test
   * that would keep passing if the fallback were deleted.
   */
  it('routes a task-less question straight to the person instead of into a flush that cannot see it', () => {
    const route = (sm as unknown as { questionRoute: (id?: string) => string }).questionRoute.bind(sm);

    expect(route('T-1')).toBe('collect');
    expect(route(undefined)).toBe('deliver-now');
  });

  /**
   * 3. The user lane asks about tasks the task lane owns.
   *
   * Keying the flush on `supervisorSessionId === managed.id` dropped every one of them: the
   * question was recorded, the task stayed paused, and no card ever appeared. The flush now uses
   * the same candidate rule as the ask.
   */
  it('flushes questions the user lane asked about the task lane\u2019s tasks', async () => {
    const taskLane = buildSupervisor('sess_task', 'task');
    const userLane = buildSupervisor('sess_user', 'user');
    const t = task();
    expect(t.supervisorSessionId).toBe(taskLane.id);

    // Asked from the user lane, recorded on the task lane's task.
    tasks.setDecisionWording(t.id, { question: '要不要做 2？' });

    const delivered: string[] = [];
    ;(sm as unknown as { deliverQuestionToUserLane: unknown }).deliverQuestionToUserLane = async (
      _m: unknown,
      questions: Array<{ question: string }>,
    ) => {
      delivered.push(...questions.map((q) => q.question));
    };

    await flush(userLane);

    expect(delivered).toEqual(['要不要做 2？']);
    expect(undeliveredQuestions(tasks.get(t.id)!)).toHaveLength(0);
  });

  /**
   * 4. Two flushes must not both draw the card.
   *
   * The flush is asynchronous and the next turn can start before it finishes, so both read the
   * same undelivered set — the duplicate this whole change removes, reintroduced by timing.
   */
  it('runs one flush at a time per session', async () => {
    const sup = buildSupervisor('sess_task', 'task');
    const t = task();
    tasks.setDecisionWording(t.id, { question: '要不要做 2？' });

    let concurrent = 0;
    let maxConcurrent = 0;
    ;(sm as unknown as { deliverQuestionToUserLane: unknown }).deliverQuestionToUserLane = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    };

    await Promise.all([flush(sup), flush(sup), flush(sup)]);

    expect(maxConcurrent).toBe(1);
  });
});
