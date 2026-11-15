/**
 * A question asked much later is not a repeat of the answer it follows.
 *
 * `answeredWithoutProgress` reads 「nothing has happened since the reply」 off timestamps, which is
 * the right test for a supervisor re-asking in the same breath — the live case was 2 seconds apart,
 * and reopening the decision there discarded the person's answer.
 *
 * It has no time in it, so it also swallowed questions asked long afterwards about situations the
 * reply could not have covered, and the swallow was silent.
 *
 * Measured on T-1: answered 05:48:20 under a fuse that left the plan unfinished. The supervisor
 * asked at 07:01:50 (budget nearly gone, one defect left) and 07:51:53 (budget gone, work done,
 * needs a real person). Both were dropped before anything was written — the journal carries
 * `decision_asked` for both, the record has neither, and the person saw two questions in the chat
 * that the task page never showed. The 05:48 answer was 「merge main first, then do ②③」, which says
 * nothing about a fuse or a budget because neither had happened yet.
 *
 * So the guard is bounded: a repeat only while the previous answer is still the newest thing on the
 * record *and* recent enough that no work could plausibly sit between them.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { answeredWithoutProgress, saveTask } from '@craft-agent/shared/tasks'
import { TaskService, REPEAT_QUESTION_WINDOW_MS } from './task-service.ts'

let root: string
let clock: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repeat-window-'))
  clock = Date.now()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const service = () =>
  new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => undefined,
    stopSession: () => undefined,
    now: () => clock,
  })

const questions = (svc: TaskService, id: string): string[] =>
  (svc.get(id)?.decisions ?? []).map((entry) => entry.question ?? '')

/**
 * A task whose record satisfies the guard's premise: answered, nothing written to the plan since.
 *
 * Every service write stamps the plan, so the shape has to be put on disk directly — that is the
 * part `answeredWithoutProgress` reads, and nothing in the public API produces it.
 *
 * Returns the moment of the answer.
 */
function taskAnsweredWithNothingSince(svc: TaskService): { id: string; answeredAt: number } {
  const created = svc.create({
    name: '一次性任务',
    instruction: '把这件事做完',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: { plan: [{ id: '1.1', title: '做事', status: 'doing', agent: 'builtin-default' }] },
  })
  svc.setDecisionWording(created.id, { question: '合并 main 还是自己实现？' })
  svc.recordDecisionAnswer(created.id, '先合并 main')

  const stored = svc.get(created.id)!
  const answeredAt = stored.decision!.answer!.at
  const plan = stored.spec?.plan ?? []
  saveTask(root, {
    ...stored,
    status: 'paused',
    spec: {
      ...stored.spec!,
      plan: plan.map((step) => ({ ...step, updatedAt: answeredAt - 1_000 })),
    },
  })
  // The premise itself, asserted rather than assumed: without it the cases below prove nothing.
  expect(answeredWithoutProgress(svc.get(created.id)!)).toBe(true)
  return { id: created.id, answeredAt }
}

describe('the repeat-question guard is bounded in time', () => {
  it('writes a question asked long after the last answer', () => {
    const svc = service()
    const { id, answeredAt } = taskAnsweredWithNothingSince(svc)

    // The gap measured on T-1 between the answer and the swallowed question.
    clock = answeredAt + 73 * 60 * 1000
    svc.setDecisionWording(id, { question: '熔断了，接下来怎么办？' })

    expect(questions(svc, id)).toContain('熔断了，接下来怎么办？')
  })

  it('turns on the window boundary, not on a step', () => {
    const svc = service()
    const { id, answeredAt } = taskAnsweredWithNothingSince(svc)

    clock = answeredAt + REPEAT_QUESTION_WINDOW_MS + 1
    svc.setDecisionWording(id, { question: '过了窗口的问句？' })

    expect(questions(svc, id)).toContain('过了窗口的问句？')
  })

  it('still refuses a repeat asked in the same breath', () => {
    /**
     * The case this guard exists for, and it must survive the change: ask, read the answer, ask
     * again 2 seconds later. Reopening there discards the reply.
     */
    const svc = service()
    const { id, answeredAt } = taskAnsweredWithNothingSince(svc)
    const before = questions(svc, id).length

    clock = answeredAt + 2_000
    svc.setDecisionWording(id, { question: '是否继续？' })

    expect(questions(svc, id)).toHaveLength(before)
    expect(questions(svc, id)).not.toContain('是否继续？')
  })

  it('writes the first question asked after a long silence again', () => {
    /**
     * The regression T-1 hit twice: two questions, one after a fuse and one after the budget ran
     * out, both dropped silently. Asserted as a count so a guard that swallows both fails loudly.
     */
    const svc = service()
    const { id, answeredAt } = taskAnsweredWithNothingSince(svc)

    clock = answeredAt + 73 * 60 * 1000
    svc.setDecisionWording(id, { question: '熔断了怎么办？' })
    clock = answeredAt + 123 * 60 * 1000
    svc.setDecisionWording(id, { question: '预算用完怎么办？' })

    expect(questions(svc, id)).toContain('熔断了怎么办？')
    expect(questions(svc, id)).toContain('预算用完怎么办？')
  })
})
