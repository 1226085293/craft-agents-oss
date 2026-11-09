import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answeredWithoutProgress } from '@craft-agent/shared/tasks'
import { TaskService } from './task-service.ts'

/**
 * A question asked before the last answer was acted on is the same question again.
 *
 * Reported live in 261110-bright-amber: answered 「暂不执行 2，保持暂停」 at 06:08:59, and the
 * supervisor asked 「是否继续？」 at 06:09:01. Reopening there started a fresh record with no answer,
 * so the person got a second card for a question they had just answered and the task lost the
 * reply entirely — the record showed an open question nobody had ever been told about.
 *
 * Nothing in the wording tells 「是否继续？」 apart from a genuine follow-up, so the signal is the
 * record: a new question is one asked about a state that changed.
 */
const service = (
  plan: Array<{ id: string; title: string; status: string }> = [
    { id: '1', title: '写文件', status: 'done' },
    { id: '2', title: '收尾', status: 'todo' },
  ],
) => {
  const root = mkdtempSync(join(tmpdir(), 'repeat-'))
  const svc = new TaskService({
    workspaceRoot: root,
    onChanged: () => {},
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
  const task = svc.create({
    name: 'x',
    instruction: 'x',
    supervisorSessionId: 'sess_sup',
    toolCallId: `call_${Math.random().toString(36).slice(2)}`,
    // The directive is older than every write the test makes, so it cannot look like progress.
    spec: { cwd: root, directive: { text: '做完 1.1 就停', at: 1 }, plan } as never,
  })
  return { svc, task, root }
}

describe('the same question is not asked twice', () => {
  it('refuses to reopen when the answer is the newest thing on the task', () => {
    const { svc, task, root } = service()
    svc.startRun(task.id, 'sess_w')
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    svc.setDecisionWording(task.id, { question: '要不要做 2？', options: ['做', '不做'] })
    svc.recordDecisionAnswer(task.id, '不做，保持暂停')

    const answered = svc.get(task.id)!
    expect(answered.decision?.answer?.text).toBe('不做，保持暂停')
    // The one condition this fixes: the reply is the most recent thing, and a step is still open.
    expect(answeredWithoutProgress(answered)).toBe(true)

    // Asking again right away is a confirmation loop, not a new question.
    const after = svc.setDecisionWording(task.id, { question: '是否继续？', options: ['继续'] })!

    expect(after.decision?.question).toBe('要不要做 2？')
    // And the reply survives: this is the data the reopen used to discard.
    expect(after.decision?.answer?.text).toBe('不做，保持暂停')
    expect(after.decision?.resolvedAt).toBeTruthy()

    rmSync(root, { recursive: true, force: true })
  })

  it('allows a new question once the reply has been acted on', () => {
    const { svc, task, root } = service()
    svc.startRun(task.id, 'sess_w')
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    svc.setDecisionWording(task.id, { question: '要不要做 2？' })
    svc.recordDecisionAnswer(task.id, '做，但要先读回确认')

    // The reply became a directive — the state a new question would be about has changed.
    svc.setDirective(task.id, '先读回确认，再做 2 收尾')

    const after = svc.setDecisionWording(task.id, { question: '读回确认已通过，继续做 2？' })!

    expect(after.decision?.question).toBe('读回确认已通过，继续做 2？')
    expect(after.decision?.answer).toBeUndefined()
    expect(after.decision?.resolvedAt).toBeUndefined()

    rmSync(root, { recursive: true, force: true })
  })

  it('says nothing when the plan has nothing left', () => {
    // A finished plan leaves nothing to ask about, so no card is owed either.
    const { svc, task, root } = service([{ id: '1', title: 'a', status: 'done' }])
    svc.startRun(task.id, 'sess_w')
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    svc.setDecisionWording(task.id, { question: '问了吗？' })
    svc.recordDecisionAnswer(task.id, '答了')

    expect(answeredWithoutProgress(svc.get(task.id)!)).toBe(false)

    rmSync(root, { recursive: true, force: true })
  })
})
