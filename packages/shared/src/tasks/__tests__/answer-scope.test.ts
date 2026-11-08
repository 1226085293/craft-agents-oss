import { describe, expect, it } from 'bun:test'
import { authorizedStepsFromAnswer } from '../answer-scope.ts'
import type { PlanStep } from '../plan.ts'

/**
 * A reply said 「完成 1.2 后暂停」 and the worker ran 1.2, 2 and 2.1 anyway.
 *
 * The boundary existed only as prose, and the only thing that could translate it into
 * anything enforceable was a supervisor turn — one that had already been rate-limited.
 * These cases pin the deterministic reading, including the cases where it must decide
 * NOT to guess.
 */
const plan: PlanStep[] = [
  { id: '1', title: '写文件', status: 'done' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'todo' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a reply can authorise a slice', () => {
  it('reads 「完成 1.2 后暂停」 as "up to 1.2, not beyond"', () => {
    expect(authorizedStepsFromAnswer('完成1.2后暂停', plan)).toEqual(['1', '1.1', '1.2'])
  })

  it('reads 「做完 1.2 就停下」 the same way', () => {
    expect(authorizedStepsFromAnswer('做完 1.2 就停下', plan)).toEqual(['1', '1.1', '1.2'])
  })

  /**
   * The case that kept coming back: the step named in the reply is not in the plan yet.
   *
   * 「完成 1.2 后暂停」 is answered exactly when 1.2 has not been planned — the worker has not
   * expanded that section, or expanded it after the reply. Requiring the id to already exist
   * returned `undefined`, the pause lifted with nothing holding the run, and the worker was
   * resumed with the whole remaining plan: the task was completed past the boundary it had
   * just been given.
   */
  it('bounds a run even when the named step does not exist yet', () => {
    const unfinished: PlanStep[] = [
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建 docs/a.md', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ]

    expect(authorizedStepsFromAnswer('完成1.2后暂停', unfinished)).toEqual(['1', '1.1'])
  })

  it('orders by id, not by position in the plan', () => {
    // A plan stored out of order must still bound at the same place.
    const shuffled: PlanStep[] = [
      { id: '2', title: '收尾', status: 'todo' },
      { id: '1.2', title: '读回确认', status: 'todo' },
      { id: '1', title: '写文件', status: 'done' },
    ]

    expect(authorizedStepsFromAnswer('完成 1.2 后暂停', shuffled)).toEqual(['1.2', '1'])
  })

  it('refuses to narrow when the reply does not ask to stop', () => {
    // 「1.2 也做完」 is permission to continue, not a boundary.
    expect(authorizedStepsFromAnswer('1.2 也做完', plan)).toBeUndefined()
  })

  it('refuses to guess from a sentence with no step id it knows', () => {
    expect(authorizedStepsFromAnswer('继续吧，看起来没问题', plan)).toBeUndefined()
    expect(authorizedStepsFromAnswer('暂停一下', plan)).toBeUndefined()
  })

  it('ignores ids the plan does not have', () => {
    // A version number or an unrelated figure must not become a step.
    expect(authorizedStepsFromAnswer('暂停，v1.9 的事以后再说', plan)).toBeUndefined()
  })

  it('does not create a boundary when nothing follows the named step', () => {
    // Stopping after the last step is just finishing: no slice to enforce.
    expect(authorizedStepsFromAnswer('做完 2 后暂停', plan)).toBeUndefined()
  })
})
