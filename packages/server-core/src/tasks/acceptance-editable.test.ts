import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

function service() {
  const root = mkdtempSync(join(tmpdir(), 'craft-acceptance-'))
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
}

function created(svc: TaskService) {
  return svc.create({
    name: '状态图标验证',
    instruction: '只做 1.1',
    supervisorSessionId: 'sess_sup',
    toolCallId: 'call_1',
    spec: {
      cwd: '/tmp',
      acceptance: [
        { id: 'a1', check: 'docs/a.md 存在且内容非空', command: 'test -f docs/a.md' },
        { id: 'a2', check: '本轮未执行 1.2 读回确认与 2 收尾' },
      ],
    } as never,
  })
}

/**
 * A mis-worded acceptance item used to be permanent.
 *
 * One real task carried 「本轮未执行 1.2」: true in the run that wrote it, and permanently false from
 * the moment the user released 1.2 — because 1.2 then really was done, which is what the task
 * records. Every later hand-off was rejected against it, three rejections tripped the failure fuse,
 * and the supervisor's only way out was to abandon the task: no tool could edit the list.
 */
describe('editing the acceptance list', () => {
  it('replaces an item by id instead of adding a second copy', () => {
    const svc = service()
    const task = created(svc)

    const next = svc.setAcceptance(task.id, [
      { id: 'a1', check: 'docs/a.md 存在且内容非空', command: 'test -f docs/a.md' },
      { id: 'a2', check: 'docs/a.md 读回内容与写入一致' },
    ])

    expect(next.spec?.acceptance).toHaveLength(2)
    expect(next.spec?.acceptance?.find((item) => item.id === 'a2')?.check).toBe('docs/a.md 读回内容与写入一致')
  })

  it('re-grades against the new wording instead of the old', () => {
    const svc = service()
    const task = created(svc)
    // The judge reads `verify.requirement`; leaving it alone would keep grading the old sentence.
    expect(svc.get(task.id)?.verify.requirement).toContain('本轮未执行')

    const next = svc.setAcceptance(task.id, [{ id: 'a2', check: 'docs/a.md 读回内容与写入一致' }])

    expect(next.verify.requirement).toBe('docs/a.md 读回内容与写入一致')
    // A fresh list has no verdict yet: the old one was about the old sentence.
    expect(next.verify.lastVerdict).toBeUndefined()
  })

  it('refuses once the task is finished — completion was granted against that list', () => {
    const svc = service()
    const task = created(svc)
    svc.setStatus(task.id, 'canceled')

    expect(() => svc.setAcceptance(task.id, [{ check: 'whatever' }])).toThrow()
  })

  it('refuses an item that does not say what must be true', () => {
    const svc = service()
    const task = created(svc)

    expect(() => svc.setAcceptance(task.id, [{ check: '   ' }])).toThrow()
  })
})
