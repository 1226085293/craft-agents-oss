import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDecisionAnswersLine, openDecisions, undeliveredAnswers } from '@craft-agent/shared/tasks'
import { TaskService } from './task-service.ts'

/**
 * Several questions, answered one at a time, delivered once.
 *
 * The single `decision` slot meant a task could only be waiting on one thing. A second question
 * replaced the first — including the answer it had already received — so the model could not
 * express what actually happens: a worker hands back two failing checks, or a boundary opens in two
 * directions, and the person answers both before anybody acts.
 *
 * Two rules follow from that, and both are the person's:
 *   1. the same question is never asked twice;
 *   2. nothing reaches the supervisor until every question has been answered.
 */
const service = () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-'))
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
    spec: {
      cwd: root,
      directive: { text: '做完 1.1 就停', at: 1 },
      plan: [
        { id: '1', title: '写文件', status: 'done' },
        { id: '2', title: '收尾', status: 'todo' },
      ],
    } as never,
  })
  svc.startRun(task.id, 'sess_w')
  svc.setStatus(task.id, 'paused', { pauseReason: 'needs_decision' })
  return { svc, task, root }
}

describe('a task can hold several questions at once', () => {
  it('keeps both open instead of replacing the first', () => {
    const { svc, task, root } = service()
    svc.setDecisionWording(task.id, { question: '要不要做 2？', options: ['做', '不做'] })
    svc.setDecisionWording(task.id, { question: '要不要改验收标准？', options: ['改', '不改'] })

    const open = openDecisions(svc.get(task.id)!)
    expect(open.length).toBe(2)
    expect(open.map((entry) => entry.question)).toEqual(['要不要做 2？', '要不要改验收标准？'])
    // Each has its own identity, so an answer can name one.
    expect(new Set(open.map((entry) => entry.id)).size).toBe(2)

    rmSync(root, { recursive: true, force: true })
  })

  it('refuses the same question twice, whatever the whitespace', () => {
    const { svc, task, root } = service()
    svc.setDecisionWording(task.id, { question: '要不要做 2？' })
    svc.setDecisionWording(task.id, { question: '要不要做 2 ?' })
    svc.setDecisionWording(task.id, { question: ' 要不要做2？ ' })

    expect(openDecisions(svc.get(task.id)!).length).toBe(1)

    rmSync(root, { recursive: true, force: true })
  })

  it('answers one question without closing the others', () => {
    const { svc, task, root } = service()
    svc.setDecisionWording(task.id, { question: '要不要做 2？' })
    svc.setDecisionWording(task.id, { question: '验收标准要改吗？' })
    const [first, second] = openDecisions(svc.get(task.id)!)

    svc.recordDecisionAnswer(task.id, '做', first!.id)

    const after = svc.get(task.id)!
    expect(openDecisions(after).map((entry) => entry.question)).toEqual(['验收标准要改吗？'])
    // Still waiting on the person, so the pause has not been released.
    expect(after.status).toBe('paused')
    expect(after.pauseReason).toBe('needs_decision')
    expect(second!.id).toBe(openDecisions(after)[0]!.id)

    rmSync(root, { recursive: true, force: true })
  })

  it('releases the pause only when the last question is answered', () => {
    const { svc, task, root } = service()
    svc.setDecisionWording(task.id, { question: '要不要做 2？' })
    svc.setDecisionWording(task.id, { question: '验收标准要改吗？' })
    const [first, second] = openDecisions(svc.get(task.id)!)

    svc.recordDecisionAnswer(task.id, '做', first!.id)
    svc.recordDecisionAnswer(task.id, '不改', second!.id)

    const after = svc.get(task.id)!
    expect(openDecisions(after).length).toBe(0)
    expect(after.pauseReason).toBeNull()

    rmSync(root, { recursive: true, force: true })
  })
})

describe('answers wait for the last one before they travel', () => {
  it('collects answers and releases them together', () => {
    const { svc, task, root } = service()
    svc.setDecisionWording(task.id, { question: '要不要做 2？' })
    svc.setDecisionWording(task.id, { question: '验收标准要改吗？' })
    const [first, second] = openDecisions(svc.get(task.id)!)

    svc.recordDecisionAnswer(task.id, '做', first!.id)
    // One answer in hand, none delivered: the supervisor has not been told anything yet.
    const midway = svc.get(task.id)!
    expect(undeliveredAnswers(midway).length).toBe(1)

    svc.recordDecisionAnswer(task.id, '不改', second!.id)
    const all = svc.get(task.id)!
    expect(undeliveredAnswers(all).length).toBe(2)

    // One message, each answer naming the question it closes.
    const line = formatDecisionAnswersLine(all, undeliveredAnswers(all))
    expect(line).toContain('要不要做 2？')
    expect(line).toContain('→ 做')
    expect(line).toContain('验收标准要改吗？')
    expect(line).toContain('→ 不改')
    expect(line).toContain('任务 T-1')

    svc.markAnswersDelivered(task.id)
    // The mark is what stops the same answers being sent twice after a restart.
    expect(undeliveredAnswers(svc.get(task.id)!).length).toBe(0)

    rmSync(root, { recursive: true, force: true })
  })
})
