import { describe, expect, it } from 'bun:test'
import { nextLeg, restructurePlan } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * 「展开下一条大纲」 used to be indistinguishable from 「没事可做」: both were `nextLeg`
 * returning `undefined`. No caller could tell a gap in the plan from a finished plan, so the
 * only instruction to expand was a sentence in the brief that the worker could skip — and the
 * worker skipped it, because the plan it read had nothing to execute under that section.
 */
describe('where execution stands', () => {
  it('names the section that still needs expanding', () => {
    const plan: PlanStep[] = [
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
    ]
    const leg = nextLeg(plan)!
    expect(leg.kind).toBe('expand')
    if (leg.kind === 'expand') expect(leg.outline.id).toBe('2')
  })

  it('names the step when the section is expanded', () => {
    const plan: PlanStep[] = [
      { id: '2', title: '收尾', status: 'doing' },
      { id: '2.1', title: '确认文件', status: 'todo' },
    ]
    const leg = nextLeg(plan)!
    expect(leg.kind).toBe('step')
    if (leg.kind === 'step') expect(leg.step.id).toBe('2.1')
  })

  it('is undefined only when nothing is left', () => {
    const plan: PlanStep[] = [
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建', status: 'done' },
    ]
    expect(nextLeg(plan)).toBeUndefined()
  })
})

/**
 * The other half of the same problem: a plan written up front is a guess, and there was no way
 * to repair the guess in bulk. So it was executed as written even after the first sections
 * proved it wrong.
 */
describe('rewriting the part of the plan that has not started', () => {
  const plan: PlanStep[] = [
    { id: '1', title: '写文件', status: 'done' },
    { id: '1.1', title: '创建 docs/a.md', status: 'done' },
    { id: '1.2', title: '读回确认', status: 'done' },
    { id: '2', title: '收尾', status: 'todo' },
    { id: '3', title: '通知用户', status: 'todo' },
  ]

  it('replaces the unstarted outlines', () => {
    const result = restructurePlan(plan, {
      fromId: '2',
      outlines: [{ title: '校验产物' }, { title: '整理结论' }, { title: '通知用户' }],
    }, 1)
    expect(result.error).toBeUndefined()
    expect(result.plan.filter((s) => /^\d+$/.test(s.id)).map((s) => `${s.id} ${s.title}`)).toEqual([
      '1 写文件',
      '2 校验产物',
      '3 整理结论',
      '4 通知用户',
    ])
  })

  it('keeps the finished work untouched', () => {
    const result = restructurePlan(plan, { fromId: '2', outlines: [{ title: 'x' }] }, 1)
    expect(result.plan.filter((s) => s.id.startsWith('1')).map((s) => s.title)).toEqual([
      '写文件',
      '创建 docs/a.md',
      '读回确认',
    ])
  })

  it('refuses to touch a section that already has sub-steps', () => {
    // Sub-steps mean somebody decided this section was next; rewriting it now would erase
    // the decision after the fact.
    const result = restructurePlan(plan, { fromId: '1', outlines: [{ title: 'x' }] }, 1)
    expect(result.error).toContain('1')
    expect(result.changed).toBe(false)
  })

  it('refuses to touch a finished or started section', () => {
    /**
     * 「Started」 is `startedAt`, not `doing`.
     *
     * `doing` is derived for the section the plan has arrived at, so the untouched tail reads as
     * `doing` and used to be refused as if someone had worked on it. What cannot be rewritten is
     * a section that was actually picked up.
     */
    const started: PlanStep[] = [
      { id: '1', title: 'a', status: 'done' },
      { id: '2', title: 'b', status: 'doing', startedAt: 5 },
    ]
    expect(restructurePlan(started, { fromId: '2', outlines: [{ title: 'x' }] }, 1).error).toContain('2')

    const finished: PlanStep[] = [
      { id: '1', title: 'a', status: 'done' },
      { id: '2', title: 'b', status: 'done' },
    ]
    expect(restructurePlan(finished, { fromId: '2', outlines: [{ title: 'x' }] }, 1).error).toContain('2')
  })

  it('allows rewriting a tail that only reads as doing because it is next', () => {
    const untouched: PlanStep[] = [
      { id: '1', title: 'a', status: 'done' },
      { id: '2', title: 'b', status: 'doing' },
    ]

    const result = restructurePlan(untouched, { fromId: '2', outlines: [{ title: 'x' }] }, 1)

    expect(result.error).toBeUndefined()
    expect(result.plan.filter((s) => /^\d+$/.test(s.id)).map((s) => s.title)).toEqual(['a', 'x'])
  })

  it('refuses an empty replacement', () => {
    expect(restructurePlan(plan, { fromId: '2', outlines: [] }, 1).error).toBeTruthy()
  })

  it('refuses a bare title-less outline', () => {
    expect(restructurePlan(plan, { fromId: '2', outlines: [{ title: '  ' }] }, 1).error).toBeTruthy()
  })

  it('refuses ids that go backwards', () => {
    const result = restructurePlan(plan, {
      fromId: '2',
      outlines: [{ id: '3', title: 'a' }, { id: '2', title: 'b' }],
    }, 1)
    expect(result.error).toBeTruthy()
  })

  it('accepts explicit ids that are ordered', () => {
    const result = restructurePlan(plan, {
      fromId: '2',
      outlines: [{ id: '2', title: 'a' }, { id: '5', title: 'b' }],
    }, 1)
    expect(result.error).toBeUndefined()
    expect(result.plan.filter((s) => /^\d+$/.test(s.id)).map((s) => s.id)).toEqual(['1', '2', '5'])
  })
})
