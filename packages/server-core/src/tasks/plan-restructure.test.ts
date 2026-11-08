import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'
import { readJournal } from '@craft-agent/shared/tasks'

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'craft-restructure-'))
  const service = new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
  const task = service.create({
    name: '状态图标验证',
    instruction: '先做 1.1',
    supervisorSessionId: 'sess_s',
    toolCallId: 'call_1',
    spec: {
      scope: '只做 1.1',
      cwd: '/tmp',
      plan: [
        { id: '1', title: '写文件', status: 'done' },
        { id: '1.1', title: '创建', status: 'done' },
        { id: '2', title: '收尾', status: 'todo' },
        { id: '3', title: '通知用户', status: 'todo' },
      ],
    },
  })
  return { service, root, task }
}

/**
 * A restructured plan must leave a trace.
 *
 * A plan that changes silently is indistinguishable from a plan that was never followed, and
 * the titles it replaced are the only evidence of what the worker decided to abandon.
 */
describe('restructuring through the task service', () => {
  it('replaces the tail and records what it replaced', () => {
    const { service, root, task } = harness()
    const result = service.restructurePlan(task.id, {
      fromId: '2',
      outlines: [{ title: '校验产物' }, { title: '整理结论' }],
    })
    expect(result.ok).toBe(true)

    const after = service.get(task.id)!
    expect(after.spec?.plan?.filter((s) => /^\d+$/.test(s.id)).map((s) => s.title)).toEqual([
      '写文件',
      '校验产物',
      '整理结论',
    ])

    const entry = readJournal(root, task.id).find((e) => e.type === 'plan_restructured')
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry)).toContain('收尾')
    expect(JSON.stringify(entry)).toContain('校验产物')
  })

  it('leaves the plan untouched when it refuses', () => {
    const { service, task } = harness()
    const shape = () =>
      (service.get(task.id)!.spec?.plan ?? []).map((s) => `${s.id} ${s.title} ${s.status}`)
    const before = shape()
    const result = service.restructurePlan(task.id, { fromId: '1', outlines: [{ title: 'x' }] })
    expect(result.ok).toBe(false)
    expect(shape()).toEqual(before)
  })
})
