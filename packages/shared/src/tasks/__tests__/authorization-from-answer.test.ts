import { describe, expect, it } from 'bun:test'
import { authorizationFromAnswer } from '../answer-scope.ts'
import { isAuthorizedStep } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * Both real answers from the run that got stuck, plus the neighbouring phrasings that look
 * similar. The defect was that only the NARROWING direction was ever derived, so
 * 「放行步骤 2（收尾），把任务做完」 was recorded and had no effect: the task stayed bounded at
 * 1.2, the brief printed 「本次只做到 1.2，到此为止」 under the release it had just quoted, and
 * every plan write for step 2 came back 「2.1 不在本次授权范围内」.
 */
const plan: PlanStep[] = [
  { id: '1', title: '写文件', status: 'done' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'done' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a reply that says to stop', () => {
  it('bounds the run at the step it names', () => {
    const read = authorizationFromAnswer('完成1.2后暂停', plan)!
    expect(read.authorizedUpTo).toBe('1.2')
    // The list travels with the ceiling: the ceiling bounds a step that is not planned yet,
    // the list is what the resume path hands the worker.
    expect(read.authorizedSteps).toEqual(['1', '1.1', '1.2'])
  })

  it('does not authorise anything past that step', () => {
    const read = authorizationFromAnswer('完成1.2后暂停', plan)!
    expect(isAuthorizedStep('2', read)).toBe(false)
    expect(isAuthorizedStep('2.1', read)).toBe(false)
  })

  it('is not a boundary when nothing is left beyond it', () => {
    // Every step done: "stop after the last one" is just finishing.
    const finished = plan.map((s) => ({ ...s, status: 'done' as const }))
    expect(authorizationFromAnswer('完成后暂停', finished)).toBeUndefined()
  })
})

describe('a reply that says to go on', () => {
  it('widens to the step it names, and to that step’s sub-steps', () => {
    const read = authorizationFromAnswer('放行步骤 2（收尾），把任务做完', plan)!
    expect(read.authorizedUpTo).toBe('2')
    expect(read.authorizedSteps).toEqual(['1', '1.1', '1.2', '2'])
    // The step the worker was actually refused on.
    expect(isAuthorizedStep('2.1', read)).toBe(true)
  })

  it('covers the whole plan when it says to finish', () => {
    const read = authorizationFromAnswer('放行剩余全部步骤，把任务做完', plan)!
    expect(read.authorizedUpTo).toBe('2')
  })

  it('keeps a release that excludes the rest narrow', () => {
    // 「其余之后再定」 excludes the rest — reading it as "the whole plan" would grant the one
    // authorisation this system must never grant by accident: more than was given.
    const read = authorizationFromAnswer('仅放行 1.2 读回，其余之后再定', plan)!
    expect(read.authorizedUpTo).toBe('1.2')
    expect(isAuthorizedStep('2', read)).toBe(false)
  })
})

describe('a reply that ends the task', () => {
  it('authorises nothing', () => {
    expect(authorizationFromAnswer('到此为止，结束任务', plan)).toBeUndefined()
  })
})

describe('a reply with no plan to read against', () => {
  it('authorises nothing rather than guessing', () => {
    expect(authorizationFromAnswer('放行步骤 2', undefined)).toBeUndefined()
    expect(authorizationFromAnswer('放行步骤 2', [])).toBeUndefined()
  })
})

describe('a step under the ceiling', () => {
  it('counts as inside it', () => {
    // Authorising a section authorises the work under it, described one level down.
    expect(isAuthorizedStep('2.1', { authorizedUpTo: '2' })).toBe(true)
    expect(isAuthorizedStep('2.1.3', { authorizedUpTo: '2' })).toBe(true)
  })

  it('does not leak sideways', () => {
    expect(isAuthorizedStep('3', { authorizedUpTo: '2' })).toBe(false)
    expect(isAuthorizedStep('2', { authorizedUpTo: '1.2' })).toBe(false)
  })
})
