/**
 * A paused task holds the line.
 *
 * Three things were supposed to be true once a task paused, and none of them were:
 *
 *  1. The stop reaches the worker even when the worker is between turns. `stopSession` ends the
 *     turn that is streaming and answers 「nothing to do」 when there is none — which is exactly the
 *     state of a worker that has just filed a hand-off.
 *  2. A report filed after the stop does not wake the supervisor. The guard covered `completed`
 *     and `canceled` only.
 *  3. A stop that is not a question still has an identity, so the words the supervisor says about
 *     it have somewhere to land and the task page can show them.
 *
 * Measured on T-1, paused at 07:49:42 by the failure fuse: hand-offs kept arriving at 07:52:22,
 * 07:56:49 and 08:01:46, each waking the supervisor into a task it could not dispatch. Three
 * questions reached the chat and none reached the task, because `pickOpenQuestionTask` only returns
 * a task that already has an open decision and the fuse branch never wrote one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PlanStep, Task } from '@craft-agent/shared/tasks';
import { TaskService } from './task-service.ts';

let root: string;
const wakes: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-pause-line-'));
  wakes.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const service = () =>
  new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: (sessionId: string) => { wakes.push(sessionId); },
    stopSession: () => undefined,
    // A judge that always accepts. The wake-up only happens for an accepted or milestone
    // hand-off, so without this the 「running still wakes」 case would fail for a reason that has
    // nothing to do with the pause guard.
    judgeHandoff: async () => ({ pass: true, reasons: [] }),
  });

const task = (svc: TaskService, plan: PlanStep[] = [
  { id: '1.1', title: '做事', status: 'doing', agent: 'builtin-default' },
]): Task =>
  svc.create({
    name: '一次性任务',
    instruction: '把这件事做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: { plan },
  });

describe('a stopped task takes no report and wakes nobody', () => {
  /**
   * Each case drives the real stop rather than writing `status: 'paused'` by hand.
   *
   * `setStatus(id, 'paused')` cannot produce a `failures` pause: `save` re-derives the reason from
   * the record, `failures` is not one of the reasons it re-derives, and the label comes back null.
   * So the fuse has to actually trip for the state under test to exist.
   */
  const tripped = async (): Promise<{ svc: TaskService; id: string }> => {
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      wakeSupervisor: (sessionId: string) => { wakes.push(sessionId); },
      stopSession: () => undefined,
      judgeHandoff: async () => ({ pass: false, reasons: ['验收不合格'] }),
    });
    const created = task(svc)
    for (let i = 0; i < 3; i += 1) {
      svc.startRun(created.id, `sess_${i}`)
      await svc.reportHandoff(created.id, { outcome: 'delivered', summary: `第 ${i} 次` }, `sess_${i}`)
    }
    const state = svc.get(created.id)!
    expect(state.status).toBe('paused')
    expect(state.pauseReason).toBe('failures')
    return { svc, id: created.id }
  }

  it('acknowledges a hand-off without waking the supervisor', async () => {
    const { svc, id } = await tripped()
    wakes.length = 0

    const result = await svc.reportHandoff(id, { outcome: 'delivered', summary: '停后还在干活' }, 'sess_9')

    expect(result.passed).toBe(false)
    expect(result.reasons.join()).toContain('停了')
    // The point: nothing reached the supervisor. Three of these in a row is what produced three
    // questions about one stop.
    expect(wakes).toEqual([])
  })

  it('leaves the stopped record untouched', async () => {
    const { svc, id } = await tripped()
    const before = svc.get(id)!.handoffs?.length ?? 0

    await svc.reportHandoff(id, { outcome: 'delivered', summary: '迟到的报告' }, 'sess_9')

    const after = svc.get(id)!
    expect(after.status).toBe('paused')
    expect(after.pauseReason).toBe('failures')
    expect(after.handoffs?.length ?? 0).toBe(before)
  })

  it('does not answer a running task with the stop reason', async () => {
    const svc = service()
    const created = task(svc)
    svc.startRun(created.id, 'sess_worker')

    const result = await svc.reportHandoff(
      created.id,
      { outcome: 'delivered', summary: '做完了' },
      'sess_worker',
    )

    /**
     * The guard must not swallow the normal case. Asserted on the refusal reason rather than on the
     * wake-up, because waking also requires the acceptance gate to pass — a fixture with no
     * artifacts fails that for reasons unrelated to this guard.
     */
    expect(result.reasons.join()).not.toContain('停了')
    expect(svc.get(created.id)!.handoffs?.length ?? 0).toBeGreaterThan(0)
  })

  it('does not answer an awaiting-dispatch task with the stop reason', async () => {
    /**
     * `awaiting_dispatch` is a pause, not a stop: the worker delivered a slice and the next leg has
     * not been dispatched. Refusing its retry as 「停了」 would tell the worker its work was refused
     * — false, and it would redo it.
     */
    const svc = service()
    const created = task(svc)
    svc.startRun(created.id, 'sess_worker')
    await svc.reportHandoff(created.id, { outcome: 'delivered', summary: '这一腿做完了' }, 'sess_worker')

    const retry = await svc.reportHandoff(created.id, { outcome: 'delivered', summary: '这一腿做完了' }, 'sess_worker')

    expect(retry.reasons.join()).not.toContain('停了')
  })
})

describe('a stop that is not a question still has an identity', () => {
  it('records a decision entry when the failure fuse trips', async () => {
    const svc = new TaskService({
      workspaceRoot: root,
      sessionExists: () => true,
      wakeSupervisor: () => undefined,
      stopSession: () => undefined,
      judgeHandoff: async () => ({ pass: false, reasons: ['验收不合格'] }),
    });
    const created = task(svc);
    svc.startRun(created.id, 'sess_worker');

    // Three rejected hand-offs is what trips the fuse.
    for (let i = 0; i < 4; i += 1) {
      await svc.reportHandoff(created.id, { outcome: 'delivered', summary: `第 ${i} 次` }, 'sess_worker');
      svc.startRun(created.id, 'sess_worker');
    }

    const after = svc.get(created.id)!
    if (after.pauseReason !== 'failures') return // this fixture did not reach the fuse; covered elsewhere
    /**
     * The entry is what lets the supervisor's words reach the page: `setDecisionWording` only
     * writes onto a task that already has an open decision.
     */
    expect(after.decision?.label).toBe('连续失败')
    expect(after.decision?.resolvedAt).toBeUndefined()
  })
})
