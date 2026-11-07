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
    getTask: (taskId) => ({ id: taskId, currentSessionId: 'w1' }),
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
    expect(h.sent[0]!.text).toBe('开始干活')
    h.runtime.dispose()
    rmSync(h.dir, { recursive: true, force: true })
  })
})
