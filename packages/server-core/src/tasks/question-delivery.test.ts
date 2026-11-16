import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDecisions, undeliveredQuestions } from '@craft-agent/shared/tasks';

import { TaskService } from './task-service.ts';

/**
 * A question is recorded when it is asked, and shown when the turn ends.
 *
 * These are two events with two different failure modes, which is why they are two marks:
 *
 *  - recorded immediately → nothing is lost if the turn dies, and `startGate` /
 *    `classifyPauseReason` see the question while it is still open;
 *  - marked delivered → a restart does not draw the card again.
 *
 * One real turn asked the same unresolved question twice, two minutes apart, with different
 * buttons; the person had to dismiss one card to answer the other. The turn-end flush is what
 * makes 「one turn, one card」 true, and the mark on the record is what keeps it true across a
 * restart — an in-memory list would clear on both.
 */
describe('question delivery', () => {
  let root: string;
  let svc: TaskService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'task-question-'));
    svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      getTask: () => null,
    } as never);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function task() {
    return svc.create({
      name: 'T-1',
      instruction: '做点事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call-1',
    } as never);
  }

  it('records a question but counts it as undelivered', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });

    const after = svc.get(t.id)!;
    expect(openDecisions(after)).toHaveLength(1);
    expect(undeliveredQuestions(after)).toHaveLength(1);
    /**
     * The record is what the gate reads, and it is written here — not at turn end.
     *
     * A backlog task keeps its status (the derivation only pauses a *running* task with an open
     * question), but `startGate` refuses to start it while the question is open. That is the
     * property that matters: the work cannot run behind a question nobody has answered, even
     * though the card has not been drawn yet.
     */
    expect(after.status).toBe('backlog');
    expect(svc.startRun(t.id, 'sess_worker')).toMatchObject({ ok: false });
  });

  it('stops counting it as undelivered once shown', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' })
    svc.markQuestionsDelivered(t.id);

    const after = svc.get(t.id)!;
    // Still open — the person has not answered — but no longer pending delivery.
    expect(openDecisions(after)).toHaveLength(1)
    expect(undeliveredQuestions(after)).toHaveLength(0)
    expect(after.decision?.questionDeliveredAt).toBeTruthy()
  })

  /**
   * The list is cleared by the flush, and it stays cleared across a restart.
   *
   * 「清空问题列表防止重复提问」 in one assertion: what the asker reads after the turn ends is
   * empty, so the next turn cannot re-send the same batch. The record keeps the question (the
   * task stays paused and the card stays answerable) — clearing the *list* is not deleting the
   * question.
   */
  it('clears the pending list once the questions go out', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });
    svc.setDecisionWording(t.id, { question: '验收标准要改吗？' });
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(2);

    svc.markQuestionsDelivered(t.id);

    // Cleared: nothing left to send.
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(0);
    // But still on the record, so the task stays held and the person can still answer.
    expect(openDecisions(svc.get(t.id)!)).toHaveLength(2);
  });

  it('survives a restart: shown once, not twice', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });
    svc.markQuestionsDelivered(t.id);

    // A fresh service reads the mark from disk, which is the whole point of it being on the record.
    const reopened = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      getTask: () => null,
    } as never);
    expect(undeliveredQuestions(reopened.get(t.id)!)).toHaveLength(0);
  });

  it('batches two questions from one turn into one pending set', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });
    svc.setDecisionWording(t.id, { question: '验收标准要改吗？' });

    // Both are pending together — the flush sends one card, not two.
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(2);

    svc.markQuestionsDelivered(t.id);
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(0);
    expect(openDecisions(svc.get(t.id)!)).toHaveLength(2);
  });

  it('does not resurrect a resolved question', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });
    const id = openDecisions(svc.get(t.id)!)[0]!.id
    svc.recordDecisionAnswer(t.id, '做', id);

    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(0);
  });

  it('keeps the answer mark separate from the question mark', () => {
    const t = task();
    svc.setDecisionWording(t.id, { question: '要不要做 2？' });
    svc.markQuestionsDelivered(t.id);
    const id = openDecisions(svc.get(t.id)!)[0]!.id
    svc.recordDecisionAnswer(t.id, '做', id);

    const after = svc.get(t.id)!
    // The question was shown, the answer has not been delivered yet: two directions, two marks.
    expect(after.decision?.questionDeliveredAt).toBeTruthy()
    expect(after.decision?.handledAt).toBeFalsy()
    expect(after.decision?.answer?.text).toBe('做')
  });
});

/**
 * The flush is what clears the list, and the list the asker reads is the pending one.
 *
 * Asserted together because either half alone passes while the defect survives: a flush that
 * marks but a list that ignores the mark still re-sends the same batch next turn.
 */
describe('the turn-end flush clears the pending list', () => {
  let root: string;
  let svc: TaskService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'task-flush-'));
    svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      getTask: () => null,
    } as never);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves nothing pending after it runs, and nothing pending after a restart', () => {
    const t = svc.create({
      name: 'T-1',
      instruction: '做点事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call-1',
    } as never);
    svc.setDecisionWording(t.id, { question: '要不要做 2？' })
    svc.setDecisionWording(t.id, { question: '验收标准要改吗？' })

    // What the flush does for one task, in order: send, then clear.
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(2)
    svc.markQuestionsDelivered(t.id)
    expect(undeliveredQuestions(svc.get(t.id)!)).toHaveLength(0)

    // A restart must not bring the batch back — the mark is on the record.
    const reopened = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      getTask: () => null,
    } as never)
    expect(undeliveredQuestions(reopened.get(t.id)!)).toHaveLength(0)
    // The questions themselves are not deleted: the card still has them to answer.
    expect(openDecisions(reopened.get(t.id)!)).toHaveLength(2)
  });

  it('keeps a question asked after the flush pending', () => {
    const t = svc.create({
      name: 'T-2',
      instruction: '做点事',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call-2',
    } as never);
    svc.setDecisionWording(t.id, { question: '第一批' })
    svc.markQuestionsDelivered(t.id)

    svc.setDecisionWording(t.id, { question: '第二批' })
    const pending = undeliveredQuestions(svc.get(t.id)!)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.question).toBe('第二批')
  });
});
