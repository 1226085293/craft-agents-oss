/**
 * A question's identity has to exist from birth, or the person sees it twice.
 *
 * Machine-raised decisions (`needs_decision` hand-off, spinning-in-place) are wordless on
 * purpose — the supervisor supplies the words later, in `setDecisionWording`. That later write
 * only updates the existing entry in place, so an id missing at birth stayed missing forever.
 * The card identity lookup (`openDecisionIdFor`) then failed, which skipped the 「this question
 * was shown」 mark after the first card was drawn — and the record-side flush drew the same card
 * a second time. One question, two cards, observed live on T-2.
 *
 * These cases pin the chain end to end: raised with id → worded in place keeps id → the mark
 * finds the question → the record-side flush has nothing left to re-send.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJournal, undeliveredQuestions, allDecisions } from '@craft-agent/shared/tasks'
import { TaskService } from './task-service.ts'

const service = (root: string) =>
  new TaskService({
    workspaceRoot: root,
    onChanged: () => {},
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })

const createTask = (svc: TaskService, root: string) =>
  svc.create({
    name: '状态图标验证',
    instruction: '只做 1.1',
    supervisorSessionId: 'sess_s',
    toolCallId: `call_${Math.random().toString(36).slice(2)}`,
    spec: {
      cwd: root,
      scope: '只做 1.1',
      plan: [{ id: '1', title: '写文件', status: 'doing' }],
    } as never,
  })

describe('a machine-raised decision is born with an id', () => {
  it('needs_decision hand-off raises an identified entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-id-'))
    const svc = service(root)
    const task = createTask(svc, root)
    svc.setStatus(task.id, 'running')
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        summary: '1.1 已完成，1.2 未授权',
        decision: { category: 'direction', label: '范围内的工作已完成', reason: '还剩 1 步没有授权：2' },
      },
      'sess_w',
    )

    const after = svc.get(task.id)!
    expect(after.decision?.id).toBeDefined()
    expect(allDecisions(after).some((entry) => entry.id === after.decision?.id)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('spinning-in-place raises an identified entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-spin-'))
    const svc = service(root)
    const task = createTask(svc, root)
    // The gate probes artifact paths, so the artifact must exist on disk.
    writeFileSync(join(root, 'a.md'), '1.1 的产物\n')

    svc.setStatus(task.id, 'running')
    const handoff = (sessionId: string) =>
      svc.reportHandoff(
        task.id,
        {
          outcome: 'handoff',
          summary: '还是不行，交给下一个',
          artifacts: [{ path: 'a.md', note: '产物' }],
          verify: { ran: ['cat a.md'], passed: true },
        },
        sessionId,
      )
    await handoff('sess_w1')
    await handoff('sess_w2')
    const third = await handoff('sess_w3')

    // The third stalled hand-off is the spinning point: paused on a fresh decision.
    expect(third.passed).toBe(true)
    const after = svc.get(task.id)!
    expect(after.status).toBe('paused')
    expect(after.decision?.label).toBe('原地打转')
    expect(after.decision?.id).toBeDefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('wording an existing entry never loses the identity', () => {
  it('keeps the id it was born with, and the journal says the same one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-word-'))
    const svc = service(root)
    const task = createTask(svc, root)
    svc.setStatus(task.id, 'running')
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        summary: '1.1 已完成，1.2 未授权',
        decision: { category: 'direction', label: '范围内的工作已完成', reason: '还剩 1 步没有授权：2' },
      },
      'sess_w',
    )
    const bornId = svc.get(task.id)!.decision!.id
    expect(bornId).toBeDefined()

    const worded = svc.setDecisionWording(task.id, {
      question: '剩余步骤怎么定？',
      options: ['做完', '就停'],
    })!

    const entry = allDecisions(worded).find((candidate) => candidate.question === '剩余步骤怎么定？')
    expect(entry).toBeDefined()
    expect(entry!.id).toBe(bornId!)

    const journal = readJournal(root, task.id)
    const asked = journal.find((row: { type: string }) => row.type === 'decision_asked')
    expect(asked).toBeDefined()
    expect((asked!.data as { decisionId: string }).decisionId).toBe(bornId!)
    rmSync(root, { recursive: true, force: true })
  })

  it('repairs a legacy record whose unworded entry has no id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-legacy-'))
    const svc = service(root)
    const task = createTask(svc, root)
    svc.setStatus(task.id, 'running')
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        summary: '1.1 已完成，1.2 未授权',
        decision: { category: 'direction', label: '范围内的工作已完成', reason: '还剩 1 步没有授权：2' },
      },
      'sess_w',
    )

    // Simulate a record written before ids existed at birth: strip the id, then word it.
    const stripped = svc.get(task.id)!
    delete (stripped.decision as { id?: string }).id
    svc['save']({ ...stripped }, { poke: false })

    const worded = svc.setDecisionWording(task.id, { question: '剩余步骤怎么定？' })!
    const entry = allDecisions(worded).find((candidate) => candidate.question === '剩余步骤怎么定？')
    expect(entry?.id).toBeDefined()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the delivery mark finds the worded question', () => {
  it('leaves nothing for the record-side flush to re-send', async () => {
    const root = mkdtempSync(join(tmpdir(), 'decision-mark-'))
    const svc = service(root)
    const task = createTask(svc, root)
    svc.setStatus(task.id, 'running')
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        summary: '1.1 已完成，1.2 未授权',
        decision: { category: 'direction', label: '范围内的工作已完成', reason: '还剩 1 步没有授权：2' },
      },
      'sess_w',
    )
    svc.setDecisionWording(task.id, { question: '剩余步骤怎么定？' })

    // Before delivery the record-side flush would find the question.
    expect(undeliveredQuestions(svc.get(task.id)!).length).toBe(1)

    svc.markQuestionsDelivered(task.id)

    // After the mark it finds nothing — which is what stops the second card.
    expect(undeliveredQuestions(svc.get(task.id)!).length).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })
})
