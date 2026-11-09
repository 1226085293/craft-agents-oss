import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

function service() {
  const root = mkdtempSync(join(tmpdir(), 'craft-passthrough-'))
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
}

function created(svc: TaskService) {
  return svc.create({
    name: '状态图标验证',
    instruction: '做 1.1',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: {
      cwd: '/tmp',
      plan: [
        { id: '1', title: '写文件', status: 'doing' },
        { id: '1.1', title: '创建', status: 'done', agent: 'builtin-default' },
        { id: '2', title: '收尾', status: 'doing' },
      ],
    } as never,
  })
}

/**
 * The owner the worker names has to reach the rule that demands it.
 *
 * A real run sent `agent: "builtin-default"` seven times and was told each time that the sub-step
 * had no owner: the tool accepted the field, and the bridge into `applyPlanPatch` dropped it. Four
 * minutes of retries, two model turns spent re-reading the source, and a task handed back with a
 * question about the tooling — all from one missing spread.
 */
describe('a sub-step names its owner', () => {
  it('keeps the agent the caller sent', () => {
    const svc = service()
    const task = created(svc)

    const result = svc.updatePlan(task.id, { id: '2.1', title: '核对交付物', agent: 'agent-ui' })

    expect(result.ok).toBe(true)
    expect(svc.get(task.id)?.spec?.plan?.find((step) => step.id === '2.1')?.agent).toBe('agent-ui')
  })

  it('refuses one that names nobody', () => {
    const svc = service()
    const task = created(svc)

    const result = svc.updatePlan(task.id, { id: '2.1', title: '核对交付物' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('agent')
  })
})

/**
 * A plan may end in a single step, and that step must be closable.
 *
 * 「收尾」 is one action; nobody wants to split it into 2.1 for its own sake. Both doors used to be
 * shut on it: marking the section done was refused because it had no sub-steps, and creating a
 * sub-step was refused because of the owner bug above. A task with everything delivered could not
 * close its last row, so `delivered` was refused and the worker could only hand back a question.
 */
describe('closing a section that was never split', () => {
  it('accepts done when it says what proves it', () => {
    const svc = service()
    const task = created(svc)

    const result = svc.updatePlan(task.id, { id: '2', status: 'done', note: 'docs/a.md 核对通过，262 字节' })

    expect(result.ok).toBe(true)
    expect(svc.get(task.id)?.spec?.plan?.find((step) => step.id === '2')?.status).toBe('done')
  })

  it('refuses done without evidence', () => {
    const svc = service()
    const task = created(svc)

    const result = svc.updatePlan(task.id, { id: '2', status: 'done' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('note')
  })

  it('still refuses a status that is derived from sub-steps', () => {
    const svc = service()
    const task = created(svc)

    // 1 has sub-steps, so its status is theirs to report; writing it would be a suggestion the
    // next read overwrites.
    const result = svc.updatePlan(task.id, { id: '1', status: 'done' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('派生')
  })
})
