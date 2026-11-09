import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './task-service.ts'

function service() {
  const root = mkdtempSync(join(tmpdir(), 'craft-unowned-'))
  return new TaskService({
    workspaceRoot: root,
    sessionExists: () => true,
    wakeSupervisor: () => {},
  })
}

/**
 * A plan may not be handed in with sub-steps that name nobody.
 *
 * `applyPlanPatch` already refused one — a sub-step is the unit of assignment. `task_create` writes
 * the whole plan at once and skipped that rule, so plans arrived with no owners at all and the page
 * showed bare titles. The tempting fix was to stamp the task's assignee into the gap; that records
 * a choice nobody made and, once the record looks complete, nothing ever asks the model again which
 * profile fits the section it is about to do.
 */
describe('a plan written in one piece', () => {
  const plan = (agent?: string) => [
    { id: '1', title: '写文件' },
    { id: '1.1', title: '创建 docs/a.md', ...(agent ? { agent } : {}) },
  ]

  it('is refused when a sub-step names no owner', () => {
    const svc = service()

    expect(() =>
      svc.create({
        name: 'x',
        instruction: 'x',
        supervisorSessionId: 'sess_sup',
        toolCallId: 'call_1',
        assigneeAgentId: 'builtin-default',
        spec: { cwd: '/tmp', plan: plan() } as never,
      }),
    ).toThrow(/1\.1/)
  })

  it('says which sub-steps are missing an owner', () => {
    const svc = service()

    let message = ''
    try {
      svc.create({
        name: 'x',
        instruction: 'x',
        supervisorSessionId: 'sess_sup',
        toolCallId: 'call_2',
        spec: { cwd: '/tmp', plan: plan() } as never,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // Naming the step is what makes the refusal actionable; 「出错」 alone would send the model to
    // read the whole schema again.
    expect(message).toContain('1.1')
    expect(message).toContain('agent')
  })

  it('is accepted once every sub-step names its owner', () => {
    const svc = service()

    const task = svc.create({
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_3',
      spec: { cwd: '/tmp', plan: plan('agent-qa') } as never,
    })

    expect(task.spec?.plan?.find((step) => step.id === '1.1')?.agent).toBe('agent-qa')
  })

  it('leaves outlines unowned — a stage is not an assignment', () => {
    const svc = service()

    const task = svc.create({
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_4',
      spec: { cwd: '/tmp', plan: plan('agent-qa') } as never,
    })

    expect(task.spec?.plan?.find((step) => step.id === '1')?.agent).toBeUndefined()
  })

  it('is refused the same way when the plan is replaced later', () => {
    const svc = service()
    const task = svc.create({
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_5',
      spec: { cwd: '/tmp' } as never,
    })

    expect(() => svc.updateSpec(task.id, { cwd: '/tmp', plan: plan() } as never)).toThrow(/1\.1/)
  })

  it('does not demand an owner for work that is already finished', () => {
    const svc = service()

    // History: the step was done before this plan was written. Asking for an owner now would mean
    // inventing one, so the check only covers what is still ahead.
    const task = svc.create({
      name: 'x',
      instruction: 'x',
      supervisorSessionId: 'sess_sup',
      toolCallId: 'call_6',
      spec: {
        cwd: '/tmp',
        plan: [
          { id: '1', title: '写文件', status: 'done' },
          { id: '1.1', title: '创建 docs/a.md', status: 'done' },
        ],
      } as never,
    })

    expect(task.spec?.plan?.length).toBe(2)
  })
})
