import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskService } from './task-service.ts'

/**
 * One question, three views — and they did not agree.
 *
 * The task page renders `task.decision`. The conversation renders the supervisor's own question.
 * The answer path reads `task.decision` again. When the supervisor paused a task with a plain
 * `task_update({status:'paused', pauseReason:'needs_decision'})` there was no record at all, so:
 *
 *   - the task page said 「等待督导把问题转达给你，稍后会上来这里」, and nothing ever created what it
 *     was waiting for, so it kept saying it;
 *   - the conversation showed a card with buttons;
 *   - pressing a button answered 「no pending decision on this task」.
 *
 * Reported live on T-1. These tests fix the contract at the service layer, where all three read
 * from the same record.
 */
describe('a supervisor question becomes the task question', () => {
  let root: string
  let svc: TaskService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'decision-norecord-'))
    svc = new TaskService({
      workspaceRoot: root,
      onChanged: () => {},
      sessionExists: () => true,
      wakeSupervisor: () => {},
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const paused = () => {
    const task = svc.create({
      name: '状态图标验证',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_${Math.random().toString(36).slice(2)}`,
      spec: {
        cwd: root,
        plan: [
          { id: '1', title: '写文件', status: 'todo' },
          { id: '1.1', title: '创建', status: 'done', agent: 'a', note: 'ok' },
          { id: '1.2', title: '读回确认', status: 'todo' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      } as never,
    })
    // The exact write the supervisor made on T-1: a pause reason, and nothing else.
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    return svc.get(task.id)!
  }

  it('creates the record instead of dropping the wording', () => {
    const task = paused()
    expect(task.decision).toBeUndefined()

    const written = svc.setDecisionWording(task.id, {
      question: '计划还有这两个剩余步骤，需要您拍板是否继续。',
      options: ['完成1.2，然后暂停', '全部做完'],
    })

    // Returning null here is what made answering impossible: the card existed, the record did not.
    expect(written).not.toBeNull()
    expect(written!.decision?.question).toContain('需要您拍板')
    expect(written!.decision?.options).toEqual(['完成1.2，然后暂停', '全部做完'])
    expect(written!.decision?.askedAt).toBeGreaterThan(0)
    expect(written!.decision?.resolvedAt).toBeUndefined()
  })

  it('accepts the answer once the record exists', () => {
    const task = paused()
    svc.setDecisionWording(task.id, { question: '继续吗？', options: ['继续', '停止'] })

    const answered = svc.recordDecisionAnswer(task.id, '完成1.2，然后暂停')

    // The reported failure: this returned null and the button said 「no pending decision」.
    expect(answered).not.toBeNull()
    expect(answered!.decision?.answer?.text).toBe('完成1.2，然后暂停')
    expect(answered!.decision?.resolvedAt).toBeGreaterThan(0)
  })

  it('writes the question even when the task was never paused', () => {
    const task = svc.create({
      name: '未暂停',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_unpaused',
      spec: { cwd: root } as never,
    })

    const written = svc.setDecisionWording(task.id, { question: '选一个' })

    // A question is a question: whether the status field has caught up is a separate fact, and
    // requiring the pause first is how the two surfaces drift apart.
    expect(written?.decision?.question).toBe('选一个')
  })

  it('still refuses a second answer to the same decision', () => {
    const task = paused()
    svc.setDecisionWording(task.id, { question: '继续吗？' })
    svc.recordDecisionAnswer(task.id, '继续')

    // The guard that must survive: two surfaces show one question, and a second reply used to be
    // read as a second instruction.
    expect(svc.recordDecisionAnswer(task.id, '再来一次')).toBeNull()
  })

  it('does not touch a decision that is already open', () => {
    const task = paused()
    const first = svc.setDecisionWording(task.id, { question: '第一次' })
    const second = svc.setDecisionWording(task.id, { question: '第二次' })

    // Re-asking replaces the wording; it must not mint a fresh `askedAt`, or an answered card
    // would come back to life with a new identity.
    expect(second!.decision?.askedAt).toBe(first!.decision?.askedAt)
    expect(second!.decision?.question).toBe('第二次')
  })
})
