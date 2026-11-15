import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SupervisorRuntime, type SupervisorSessionInfo } from '../supervisor-runtime.ts'

function harness(handoff?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-handoff-'))
  const sent: Array<{ sessionId: string; text: string }> = []
  const supervisor: SupervisorSessionInfo = { id: 'sup', role: 'supervisor', spawnDepth: 0, isProcessing: false }
  const worker: SupervisorSessionInfo = { id: 'w1', role: 'worker', spawnDepth: 1, isProcessing: false, taskId: 'T-1' }
  const sessions = new Map([['sup', supervisor], ['w1', worker]])
  const runtime = new SupervisorRuntime({
    workspaceRoot: dir,
    ensureSupervisorSession: async () => supervisor,
    getSession: (id) => sessions.get(id) ?? null,
    spawnWorker: async () => ({ sessionId: 'w2' }),
    sendToSession: async (sessionId, text) => { sent.push({ sessionId, text }) },
    writeToSupervisor: async () => {},
    askUser: async () => {},
    getTask: (taskId) => ({ id: taskId, currentWorkerSessionId: 'w1' }),
    ...(handoff ? { handoffContext: () => handoff } : {}),
  })
  return { runtime, sent, dir }
}

/**
 * The hand-off has to reach the session that continues the work.
 *
 * It used to live only inside a new worker's brief, so dispatching the next step
 * into a session that was already running sent the instruction alone — the
 * findings, next action and artifact paths stayed in the task file.
 */
describe('handing work to an existing session', () => {
  it('sends the previous hand-off ahead of the instruction', async () => {
    const h = harness('## 交接上下文\n上一轮结论：接口已改完\n\n下一步：补测试')
    await h.runtime.dispatch({
      fromSessionId: 'sup',
      target: { kind: 'session', sessionId: 'w1' },
      scope: 'T-1 的第二节',
      instruction: '把回归用例补上',
      attachTaskId: 'T-1',
      parallel: false,
    })
    await h.runtime.onSupervisorIdle()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('上一轮结论：接口已改完')
    expect(h.sent[0]!.text).toContain('下一步：补测试')
    expect(h.sent[0]!.text).toContain('把回归用例补上')
    // The instruction stays distinguishable from the record.
    expect(h.sent[0]!.text).toContain('这一轮要做的事')
    h.runtime.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  })

  it('sends the instruction alone when nothing was handed off yet', async () => {
    const h = harness()
    await h.runtime.dispatch({
      fromSessionId: 'sup',
      target: { kind: 'session', sessionId: 'w1' },
      scope: 'T-1 的第一节',
      instruction: '开始干活',
      attachTaskId: 'T-1',
      parallel: false,
    })
    await h.runtime.onSupervisorIdle()
    expect(h.sent[0]!.text).toBe('开始干活')
    h.runtime.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  })
})

/**
 * The plan is how a dispatch knows which step it is for.
 *
 * Live run: 「执行步骤 1.2（读回确认）」 was dispatched at 10:50:47, thirty-four seconds after the
 * worker had marked 1.2 done at 10:50:13. The task was not `paused` at that instant, so the pause
 * gate passed it; the worker re-read the same file, filed a second hand-off, and the supervisor
 * told the person 「交接通过」 twice for one step. The instruction is prose and could not be checked
 * against anything — `stepId` makes it checkable.
 */
describe('dispatching a step the plan already records as done', () => {
  function taskWithPlan(steps: Array<{ id: string; status: string }>) {
    const dir = mkdtempSync(join(tmpdir(), 'craft-stepgate-'))
    const supervisor: SupervisorSessionInfo = { id: 'sup', role: 'supervisor', spawnDepth: 0, isProcessing: false }
    const sessions = new Map([['sup', supervisor]])
    const runtime = new SupervisorRuntime({
      workspaceRoot: dir,
      ensureSupervisorSession: async () => supervisor,
      getSession: (id) => sessions.get(id) ?? null,
      spawnWorker: async () => ({ sessionId: 'w2' }),
      sendToSession: async () => {},
      writeToSupervisor: async () => {},
      askUser: async () => {},
      getTask: (taskId) => ({
        id: taskId,
        spec: { plan: steps },
        handoffs: [{ outcome: 'handoff' }],
      }),
      handoffContext: () => undefined,
    })
    return { runtime, dir }
  }

  it('refuses a step that is already done', async () => {
    const { runtime, dir } = taskWithPlan([
      { id: '1.1', status: 'done' },
      { id: '1.2', status: 'done' },
      { id: '2', status: 'todo' },
    ])
    await expect(
      runtime.dispatch({
        fromSessionId: 'sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '1.2',
        scope: '读回确认',
        instruction: '读回 docs/a.md',
        parallel: false,
      }),
    ).rejects.toThrow(/1\.2 已经完成/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a step that is not in the plan', async () => {
    const { runtime, dir } = taskWithPlan([{ id: '1.1', status: 'todo' }])
    await expect(
      runtime.dispatch({
        fromSessionId: 'sup',
        target: { kind: 'task', taskId: 'T-1' },
        stepId: '9.9',
        scope: '不存在的一节',
        instruction: '做点什么',
        parallel: false,
      }),
    ).rejects.toThrow(/没有 9\.9/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets an open step through', async () => {
    const { runtime, dir } = taskWithPlan([{ id: '1.1', status: 'done' }, { id: '1.2', status: 'todo' }])
    const result = await runtime.dispatch({
      fromSessionId: 'sup',
      target: { kind: 'task', taskId: 'T-1' },
      stepId: '1.2',
      scope: '读回确认',
      instruction: '读回 docs/a.md',
      parallel: false,
    })
    // Accepted and queued: the spawn happens at the end of the turn, which is the point.
    expect(result.queued).toBe(true)
    await runtime.onSupervisorIdle('sup')
    rmSync(dir, { recursive: true, force: true })
  })
})
