import { describe, expect, it } from 'bun:test'
import { deriveOutlineStatus, openSteps } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * 「大纲 1」 spun forever while every sub-step of it was closed.
 *
 * Two separate harms came from one cause — `deriveOutlineStatus` returning `doing` for a finished
 * section whenever the *next* outline had no sub-steps yet, a navigation concern encoded as a false
 * status:
 *
 *   1. the supervisor read the plan as 「还剩 1、2」 and asked the person to release work that was
 *      already done (fixed earlier by having `openSteps` count sub-steps);
 *   2. the person saw a spinner over a section whose every sub-step was green, and read a 3/3 plan
 *      as unfinished (fixed now: the status states the section, `nextLeg` carries the nudge).
 */
const done: PlanStep[] = [
  { id: '1', title: '写文件', status: 'doing' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'done' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a finished section is not reported as outstanding', () => {
  it('reads as done the moment its last sub-step closes', () => {
    // The screenshot that reported this showed 「执行计划 (3/3)」 with a spinner on 「1」. A plan
    // that is finished everywhere must not have one section claiming to be under way.
    expect(deriveOutlineStatus(done, done.find((s) => s.id === '1')!)).toBe('done')
  })

  it('is still not counted as work that remains', () => {
    expect(openSteps(done).map((s) => s.id)).toEqual(['2'])
  })

  it('is doing while a sub-step is still open', () => {
    const half = done.map((s) => (s.id === '1.2' ? { ...s, status: 'todo' as const } : s))
    expect(deriveOutlineStatus(half, half.find((s) => s.id === '1')!)).toBe('doing')
  })
})

describe('what is actually left to do', () => {
  it('does not count a section whose sub-steps are all closed', () => {
    expect(openSteps(done).map((s) => s.id)).toEqual(['2'])
  })

  it('counts a section with an open sub-step', () => {
    const half = done.map((s) => (s.id === '1.2' ? { ...s, status: 'todo' as const } : s))
    expect(openSteps(half).map((s) => s.id)).toEqual(['1', '1.2', '2'])
  })

  it('is empty when everything is closed', () => {
    expect(openSteps([{ id: '1', title: 'a', status: 'done' }])).toEqual([])
  })
})
