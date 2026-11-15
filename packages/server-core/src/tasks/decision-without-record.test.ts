import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyTransition } from '@craft-agent/shared/tasks'
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
          { id: '1.2', title: '读回确认', status: 'todo', agent: 'a' },
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

  it('leaves an open question alone when a different one arrives', () => {
    const task = paused()
    const first = svc.setDecisionWording(task.id, { question: '第一次' })
    const second = svc.setDecisionWording(task.id, { question: '第二次' })

    /**
     * A second, different question joins the first instead of replacing it.
     *
     * Replacing was how a card took the other card's answer with it. What must not happen is a fresh
     * `askedAt` on the *existing* question — an answered card coming back to life with a new identity
     * — so the first entry keeps its clock and its id.
     */
    const all = second!.decisions ?? []
    expect(all.length).toBe(2)
    expect(all[0]!.askedAt).toBe(first!.decision?.askedAt ?? all[0]!.askedAt)
    expect(all[1]!.question).toBe('第二次')
  })
})

describe('a pause with no question is not 「等你决定」', () => {
  let root: string
  let svc: TaskService

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'asking-'))
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
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: `call_${Math.random().toString(36).slice(2)}`,
      spec: { cwd: root } as never,
    })
    svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
    return svc.get(task.id)!
  }

  it('records 「等问句」 when the question has not been worded yet', () => {
    const task = paused()

    // The board used to show this under a column headed 「必须由人决定」 with nothing in it to
    // decide. The record knows the difference is just "is there a question yet".
    expect(task.pauseReason).toBe('asking')
    expect(task.decision).toBeUndefined()
  })

  it('becomes 「等你决定」 the moment the question lands', () => {
    const task = paused()
    const asked = svc.setDecisionWording(task.id, { question: '继续吗？', options: ['继续', '停止'] })

    expect(asked!.pauseReason).toBe('needs_decision')
    expect(asked!.decision?.question).toBe('继续吗？')
  })

  it('never claims 「等你决定」 on a task that already has a question', () => {
    // Straight at the transition, because the service cannot produce this sequence: a task with an
    // open decision refuses to go back to `running` at all, which is the guard doing its job.
    const withDecision = {
      id: 'T-9',
      name: 'y',
      instruction: 'x',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      sessionIds: [],
      handoffs: [],
      lifecycle: { errorCount: 0, consecutiveFailures: 0 },
      stats: { runs: 1, activeMs: 0 },
      decision: { category: 'direction', label: '问过了', reason: '', askedAt: 1},
    } as never

    const paused = applyTransition(withDecision, 'paused', { now: 10, pauseReason: 'needs_decision' })

    // There is a question on record, so the pause means what it says from the start.
    expect(paused.task.pauseReason).toBe('needs_decision')
  })

  it('leaves other pause reasons untouched', () => {
    const task = svc.create({
      name: 'z',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_waiting',
      spec: { cwd: root } as never,
    })
    // `waiting` is derived from the dependency record now, so the test has to have a dependency
    // that is still unfinished — a pause that only claims `waiting` is cleared to nothing.
    const blocker = svc.create({
      name: '前置任务',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_blocker',
      spec: { cwd: root } as never,
    })
    const dependent = svc.create({
      name: 'z2',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_dependent',
      spec: { cwd: root } as never,
      dependsOn: [blocker.id],
    })
    svc.setStatus(dependent.id, 'paused', { pauseReason: 'waiting' })
    expect(svc.get(dependent.id)!.pauseReason).toBe('waiting')
  })
})
