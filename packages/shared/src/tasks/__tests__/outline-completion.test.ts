import { describe, expect, it } from 'bun:test'
import { deriveOutlineStatus, openSteps } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * 「大纲 1」 spun forever while every sub-step of it was closed, and the supervisor therefore
 * read the plan as 「还剩 1、2」 and asked the person to release work that was already done.
 *
 * The cause was `deriveOutlineStatus` returning `doing` for a finished section whenever the
 * *next* outline had no sub-steps yet — a navigation concern encoded as a false status.
 */
const done: PlanStep[] = [
  { id: '1', title: '写文件', status: 'doing' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'done' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a finished section is not reported as outstanding', () => {
  /**
   * The status still says `doing` — deliberately, because closing a section requires the next
   * one to be broken down, and a derived close would walk around that. What was wrong is that
   * the same lookahead leaked into "what is left to do": the supervisor asked the person to
   * 「放行剩余步骤 1、2」 when every sub-step of 1 was complete. `openSteps` answers that
   * question from the sub-steps, so the flow constraint stops being read as unfinished work.
   */
  it('stays doing at the status level while the next section is unplanned', () => {
    expect(deriveOutlineStatus(done, done.find((s) => s.id === '1')!)).toBe('doing')
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
    // `1` still says `doing` on disk; the answer is still "not this one".
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
