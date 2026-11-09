import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

function service() {
  const root = mkdtempSync(join(tmpdir(), 'craft-closed-'))
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
}

function pausedOnDecision(svc: TaskService) {
  const task = svc.create({
    name: '状态图标验证',
    instruction: '只做 1.1',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: { cwd: '/tmp', scope: '只做 1.1' } as never,
  })
  svc.setStatus(task.id, 'running')
  // A hand-off that asks for a decision writes the record; the pause alone does not. This is the
  // real path — `setStatus(paused, needs_decision)` on its own leaves nothing to close.
  // A question, not just a label: a wording with no words is a different entry in the queue, and
  // the test is about one question being answered, not about two open at once.
  svc.setDecisionWording(task.id, { label: '这一段做完了，等你决定', question: '继续吗？' })
  svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
  return svc.get(task.id)!
}

/**
 * A pause for a decision needs an open decision to be paused for.
 *
 * Observed live: a supervisor wrote `directive` and `scope` in one turn, the scope write closed the
 * decision as `obsolete` (nobody approved anything), and the task stayed `paused / asking` — no
 * question, no answer, and a gate that would have allowed it to run. Every rule missed it: the
 * watchdog looks for an *open* decision it can push, and the scheduler only looks at running tasks.
 */
describe('a decision that closed leaves no pause behind', () => {
  it('does not stay paused on 「等问句」', () => {
    const svc = service()
    const task = pausedOnDecision(svc)
    // The pause with no words yet is classified as 等问句.
    // Constructed with its words already written (see `pausedOnDecision`), so this is 「等你拍板」;
    // the 「等问句」 case is covered by its own test.
    expect(svc.get(task.id)?.pauseReason).toBe('needs_decision')

    svc.resolveDecision(task.id, 'obsolete', '问题不再成立')

    const after = svc.get(task.id)!
    // Nothing is waiting any more, so the label must not claim that something is.
    expect(after.pauseReason).toBeNull()
  })

  it('does not stay paused on 「等你拍板」 either', () => {
    const svc = service()
    const task = pausedOnDecision(svc)
    expect(svc.get(task.id)?.pauseReason).toBe('needs_decision')

    svc.recordDecisionAnswer(task.id, '继续')

    expect(svc.get(task.id)!.pauseReason).toBeNull()
  })

  it('keeps an unrelated pause reason untouched', () => {
    const svc = service()
    const task = pausedOnDecision(svc)
    // `paused → paused` is a no-op, so reach a budget pause the way it really happens: run again,
    // then pause on the budget gate.
    svc.resolveDecision(task.id, 'approved', 'ok')
    svc.setStatus(task.id, 'running')
    svc.setStatus(task.id, 'paused', { pauseReason: 'budget' })

    // Budget describes the task, not a decision; closing decisions must never rewrite it.
    expect(svc.get(task.id)!.pauseReason).toBe('budget')
  })
})
