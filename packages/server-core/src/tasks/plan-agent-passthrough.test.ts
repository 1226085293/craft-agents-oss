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
 * An outline is a stage, so it is closed by its sub-steps — not by a status write.
 *
 * A plan may end in a single action (「2 收尾」). The way to finish it is to split it into `2.1` and
 * complete that: the section then reads `doing` because a child is, and `done` when the child
 * closes. Letting the section be marked `done` directly was tried and removed — it made one field
 * answer two questions (container or work unit?), and with no way to tell which, every later reader
 * has to guess.
 */
describe('closing a section that was never split', () => {
  it('refuses a direct status write, and says to split it', () => {
    const svc = service()
    const task = created(svc)

    const result = svc.updatePlan(task.id, { id: '2', status: 'done', note: '核对通过' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('派生')
    expect(result.error).toContain('2.1')
  })

  it('closes by derivation once its sub-step is finished', () => {
    const svc = service()
    const task = created(svc)

    const added = svc.updatePlan(task.id, { id: '2.1', title: '核对交付物', agent: 'builtin-default', status: 'doing' })
    expect(added.ok).toBe(true)
    // A section is under way when one of its children is — not merely because it has children.
    expect(svc.get(task.id)?.spec?.plan?.find((step) => step.id === '2')?.status).toBe('doing')

    const done = svc.updatePlan(task.id, { id: '2.1', status: 'done', note: 'docs/a.md 262B 核对通过' })
    expect(done.ok).toBe(true)
    expect(svc.get(task.id)?.spec?.plan?.find((step) => step.id === '2')?.status).toBe('done')
  })
})
