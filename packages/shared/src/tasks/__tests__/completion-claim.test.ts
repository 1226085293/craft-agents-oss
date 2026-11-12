import { describe, expect, it } from 'bun:test'
import { completedClaimRefusal } from '../completion-claim.ts'
import type { Task } from '../types.ts'

function task(plan: Array<{ id: string; status: string; title?: string }> | undefined): Task {
  return {
    id: 'T-1',
    name: '分工验证',
    instruction: 'x',
    status: 'running',
    supervisorSessionId: 's1',
    sessionIds: ['s2'],
    handoffs: [],
    lifecycle: { errorCount: 0, consecutiveFailures: 0 },
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    spec: { scope: 'x', cwd: '/tmp', plan: plan as never },
  } as unknown as Task
}

describe('claiming a task is completed while its plan is open', () => {
  /**
   * The live case: a task was created, its plan written, the first step queued — and the user
   * lane announced 「已建，3 条大纲及各自负责人已写入，系统正在分析范围并派活」 as `completed`.
   */
  it('refuses a freshly created task and names the steps that are still open', () => {
    const refusal = completedClaimRefusal(
      task([
        { id: '1', title: '数据', status: 'todo' },
        { id: '1.1', title: '写 data.md', status: 'todo' },
        { id: '2', title: '界面', status: 'todo' },
        { id: '2.1', title: '写 ui.md', status: 'todo' },
      ]),
    )
    expect(refusal).not.toBeNull()
    expect(refusal).toContain('T-1')
    expect(refusal).toContain('1.1')
    expect(refusal).toContain('2.1')
    // The three kinds are named, because the model's next move is to pick a different one.
    expect(refusal).toContain('decision')
    expect(refusal).toContain('blocked')
  })

  it('allows it once every step is done', () => {
    expect(
      completedClaimRefusal(
        task([
          { id: '1', status: 'done' },
          { id: '1.1', status: 'done' },
          { id: '2', status: 'done' },
          { id: '2.1', status: 'done' },
        ]),
      ),
    ).toBeNull()
  })

  /**
   * The predicate is `openSteps`, which is what `assertPlanSettled` asks — so the sentence the
   * person reads and the refusal the record writes can never name different sets of steps.
   *
   * An outline counts as open while any child of it is, which is why the list names both the
   * section and the unfinished step under it. The finished sibling is never named.
   */
  it('names the section and the open step under it, never the finished one', () => {
    const refusal = completedClaimRefusal(
      task([
        { id: '1', status: 'todo' },
        { id: '1.1', status: 'done' },
        { id: '1.2', status: 'todo' },
      ]),
    )
    expect(refusal).toContain('1.2')
    expect(refusal).toContain('（1、1.2）')
    expect(refusal).not.toContain('1.1')
  })

  it('allows a task with no plan at all', () => {
    expect(completedClaimRefusal(task([]))).toBeNull()
    expect(completedClaimRefusal(task(undefined))).toBeNull()
  })

  it('allows when no task is named, because there is nothing to check', () => {
    expect(completedClaimRefusal(undefined)).toBeNull()
  })
})
