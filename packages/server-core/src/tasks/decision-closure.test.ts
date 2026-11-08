import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

/**
 * The state T-1 got stuck in, reproduced.
 *
 * ```
 * status: paused   pauseReason: needs_decision
 * decision.resolvedAt: 1794145705150   decision.answer: null   decision.question: null
 * ```
 *
 * Three facts that cannot all be true: the task said it was waiting for a person, the decision
 * said a person had settled it, and the card had nothing to show. Nothing could move it again —
 * the watchdog only wakes tasks whose decision is unresolved, and no path resumes a task with a
 * settled decision.
 */
function service() {
  const root = mkdtempSync(join(tmpdir(), 'craft-decision-'))
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
}

/** The real path that produces `paused / needs_decision`: a worker hands off asking to be told. */
async function pausedOnDecision(svc: TaskService) {
  const task = svc.create({ name: '状态图标验证', scope: '只做 1.1' })
  svc.setStatus(task.id, 'running')
  await svc.reportHandoff(
    task.id,
    {
      outcome: 'needs_decision',
      summary: '1.1 已完成，1.2 未授权',
      decision: {
        category: 'direction',
        label: '范围内的工作已完成',
        reason: '还剩 1 步没有授权：2',
      },
    },
    'sess_w',
  )
  return svc.get(task.id)!
}

describe('closing a decision that stopped being true', () => {
  it('does not claim a person approved it', async () => {
    const svc = service()
    await pausedOnDecision(svc)
    const after = svc.resolveDecision('T-1', 'obsolete', '范围已包含 1.2')

    expect(after.decision?.resolution).toBe('obsolete')
    // The distinction that was missing: settled, but with nobody's words attached.
    expect(after.decision?.answer).toBeUndefined()
    expect(after.decision?.resolvedAt).toBeGreaterThan(0)
  })

  it('records why it closed, so an empty answer is not the only evidence', async () => {
    const svc = service()
    await pausedOnDecision(svc)
    const after = svc.resolveDecision('T-1', 'obsolete', '范围已包含 1.2')
    expect(after.decision?.reason).toBe('范围已包含 1.2')
  })
})

describe('a cleared pause reason actually clears', () => {
  it('drops it, because setStatus paused→paused is a no-op', async () => {
    const svc = service()
    await pausedOnDecision(svc)

    // The reason the obvious fix does not work: same status short-circuits.
    svc.setStatus('T-1', 'paused', { pauseReason: null })
    expect(svc.get('T-1')!.pauseReason).toBe('needs_decision')

    expect(svc.clearPauseReason('T-1').pauseReason).toBeNull()
  })
})

describe('a re-asked question does not inherit the old diagnosis', () => {
  it('starts with an empty reason and no answer', async () => {
    const svc = service()
    await pausedOnDecision(svc)
    svc.recordDecisionAnswer('T-1', '完成1.2后暂停')

    const reopened = svc.setDecisionWording('T-1', { question: '现在还要继续吗？' })!
    expect(reopened.decision?.question).toBe('现在还要继续吗？')
    expect(reopened.decision?.reason).toBe('')
    expect(reopened.decision?.answer).toBeUndefined()
    expect(reopened.decision?.resolvedAt).toBeUndefined()
  })
})
