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
  const task = svc.create({
    name: '状态图标验证',
    instruction: '建立任务「状态图标验证」，只做 1.1',
    supervisorSessionId: 'sess_s',
    toolCallId: 'call_1',
    spec: { scope: '只做 1.1', cwd: '/tmp' },
  })
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

/**
 * The second real answer, end to end — under the new contract.
 *
 * The reply is recorded verbatim; what it means comes from a model writing it down through
 * `task_update`, not from a parser reading 「放行步骤 2」. This is the same scenario the keyword
 * tables used to handle, and they only handled it because the phrase happened to be in the list.
 */
describe('a release answer unblocks the plan', () => {
  it('lets the released outline be broken into a sub-step, and that sub-step start', async () => {
    const svc = service()
    const task = svc.create({
      name: '状态图标验证',
      instruction: '建立任务，先只做 1.1',
      supervisorSessionId: 'sess_s',
      toolCallId: 'call_1',
      spec: {
        scope: '只做 1.1',
        cwd: '/tmp',
        plan: [
          { id: '1', title: '写文件', status: 'done' },
          { id: '1.1', title: '创建', status: 'done' },
          { id: '1.2', title: '读回', status: 'done' },
          { id: '2', title: '收尾', status: 'todo' },
        ],
      },
    })
    svc.setStatus(task.id, 'running')
    await svc.reportHandoff(
      task.id,
      {
        outcome: 'needs_decision',
        summary: '1.2 已完成，2 未授权',
        decision: { category: 'direction', label: '还剩步骤 2', reason: '2 未授权' },
      },
      'sess_w',
    )

    const answered = svc.recordDecisionAnswer('T-1', '放行步骤 2（收尾），把任务做完')!
    // Recording alone authorises nothing: the words are stored, nothing is inferred.
    expect(answered.spec?.directive).toBeUndefined()

    // What the supervisor does after reading the reply.
    svc.setDirective('T-1', '放行第 2 条（收尾），把任务做完')

    /**
     * The exact call that used to fail on a live run with 「2.1 不在本次授权范围内（授权：2）」.
     *
     * Adding a sub-step under a released outline is the first thing 「放行 2」 authorises, because
     * an outline is a goal, not work: it becomes work only once it has sub-steps.
     */
    const written = svc.updatePlan('T-1', { id: '2.1', title: '最终验收与收尾', status: 'doing', agent: 'agent-qa' })
    expect(written.error).toBeUndefined()
    expect(written.ok).toBe(true)
  })
})
