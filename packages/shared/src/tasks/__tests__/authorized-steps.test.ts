import { describe, expect, it } from 'bun:test'
import { applyPlanPatch } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * The boundary is no longer a list of step ids, and this file records why.
 *
 * `applyPlanPatch` used to refuse a `doing`/`done` move on any step outside
 * `authorizedSteps` / `authorizedUpTo`. Two live failures came out of it:
 *
 *   - the user released 「大纲 2」 and the worker could not create its first sub-step:
 *     「2.1 不在本次授权范围内（授权：2）」 — the explicit list matched ids exactly while the ceiling
 *     matched children, so the same authorisation behaved differently depending on which field
 *     happened to be written;
 *   - the ids are invented by the party being gated, so a boundary naming them could be satisfied
 *     by renaming, and 「把那个登录问题修完」 could not be written as an id at all when the work
 *     spans two outlines and half of a third.
 *
 * What is left is the part that can actually be checked: what was started is history. These tests
 * assert that, and that the guard which used to block legitimate work is gone.
 */
const plan: PlanStep[] = [
  { id: '1', title: '写文件', status: 'todo' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'todo' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a released outline can be broken down', () => {
  it('lets the worker add the first sub-step under an authorised outline', () => {
    // This is the exact call that came back 「2.1 不在本次授权范围内」 on a live run.
    const result = applyPlanPatch(
      plan,
      { id: '2.1', title: '总体验收确认', agent: 'agent-qa' },
      1,
    )

    expect(result.error).toBeUndefined()
    expect(result.plan.find((s) => s.id === '2.1')?.title).toBe('总体验收确认')
  })

  it('lets the worker start and finish steps in a later outline', () => {
    // The person's real boundary may not be expressible as an id — deciding what it means is the
    // model's job, so the plan writer must not be second-guessed by a numeric ceiling.
    const withChild = applyPlanPatch(plan, { id: '2.1', title: '收尾', agent: 'agent-qa' }, 1)
    const started = applyPlanPatch(withChild.plan, { id: '2.1', status: 'doing', agent: 'agent-qa' }, 2)
    const done = applyPlanPatch(started.plan, { id: '2.1', status: 'done', note: '验过了' }, 3)

    expect(started.error).toBeUndefined()
    expect(done.error).toBeUndefined()
    expect(done.plan.find((s) => s.id === '2.1')?.status).toBe('done')
  })
})

describe('what was started is history', () => {
  it('refuses to delete a step that has been picked up', () => {
    const started = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 10)
    expect(started.error).toBeUndefined()

    const removed = applyPlanPatch(started.plan, { id: '1.2', remove: true }, 11)

    // Deleting it would leave a plan that looks clean while the work that actually happened —
    // the code read, the decision taken — has nowhere to be read from.
    expect(removed.error).toBeDefined()
    expect(removed.error).toContain('不能删')
    expect(removed.error).toContain('blocked')
    expect(removed.plan.find((s) => s.id === '1.2')).toBeDefined()
  })

  it('still deletes a step nobody ever started', () => {
    // A proposal nobody acted on costs one line to drop; there is no history to lose.
    const removed = applyPlanPatch(plan, { id: '2', remove: true }, 11)
    expect(removed.error).toBeUndefined()
    expect(removed.plan.find((s) => s.id === '2')).toBeUndefined()
  })

  it('keeps a started step un-deletable after it is put back to todo', () => {
    const started = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 10)
    const parked = applyPlanPatch(started.plan, { id: '1.2', status: 'todo', note: '先做别的' }, 11)
    const removed = applyPlanPatch(parked.plan, { id: '1.2', remove: true }, 12)

    // `startedAt` rather than `status === 'doing'`: otherwise one status change without a note
    // makes the step deletable again, which is the same erasure one step later.
    expect(removed.error).toBeDefined()
  })

  it('stamps startedAt on the first doing and never moves it', () => {
    const first = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 100)
    const again = applyPlanPatch(first.plan, { id: '1.2', status: 'doing' }, 200)

    expect(again.plan.find((s) => s.id === '1.2')?.startedAt).toBe(100)
  })
})

describe('walking away from a started step needs a reason', () => {
  for (const status of ['blocked', 'todo'] as const) {
    it(`refuses doing -> ${status} without a note`, () => {
      const started = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 10)
      const left = applyPlanPatch(started.plan, { id: '1.2', status }, 11)

      // Otherwise "picked up and abandoned" is indistinguishable from "never touched" on the
      // next read, and the next worker either redoes it or skips it without knowing which.
      expect(left.error).toBeDefined()
      expect(left.error).toContain('原因')
      expect(left.plan.find((s) => s.id === '1.2')?.status).toBe('doing')
    })
  }

  it('accepts doing -> blocked with a note', () => {
    const started = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 10)
    const blocked = applyPlanPatch(started.plan, { id: '1.2', status: 'blocked', note: '接口改了，等确认' }, 11)

    expect(blocked.error).toBeUndefined()
    expect(blocked.plan.find((s) => s.id === '1.2')?.status).toBe('blocked')
  })

  it('does not require a note when the step finishes', () => {
    // `done` already requires proof through its own rule; it is not an abandonment.
    const started = applyPlanPatch(plan, { id: '1.2', status: 'doing' }, 10)
    const done = applyPlanPatch(started.plan, { id: '1.2', status: 'done', note: '读回一致' }, 11)
    expect(done.error).toBeUndefined()
  })
})

describe('an outline has no status of its own', () => {
  it('refuses to set one, and says what to set instead', () => {
    const result = applyPlanPatch(plan, { id: '2', status: 'done' }, 1)

    // The value was recomputed from the sub-steps on every read anyway, so accepting the write
    // meant answering "ok" and then showing something else.
    //
    // A section with no sub-steps now has a second way out — mark it done with a note saying what
    // proves it — so the refusal names both paths instead of only "go and split it up".
    expect(result.error).toBeDefined()
    expect(result.error).toContain('2.1')
    expect(result.error).toContain('note')
  })

  it('refuses a bare outline that has no sub-steps yet', () => {
    const result = applyPlanPatch(plan, { id: '2', status: 'doing' }, 1)
    expect(result.error).toContain('拆成可执行的小节')
  })
})

describe('a sub-step names its owner', () => {
  it('refuses a sub-step with no agent', () => {
    const result = applyPlanPatch(plan, { id: '2.1', title: '收尾' }, 1)

    // The outline used to hand down its owner, so a blank field still looked filled. Outlines
    // carry nobody now, and a sub-step is the unit of assignment: an ownerless one was never
    // assigned to anyone.
    expect(result.error).toBeDefined()
    expect(result.error).toContain('agent')
  })

  it('does not inherit an owner from the outline', () => {
    const withOwner: PlanStep[] = [
      { id: '2', title: '收尾', status: 'todo', agent: 'agent-lead' },
      { id: '2.1', title: '整理', status: 'todo' },
    ]
    const result = applyPlanPatch(withOwner, { id: '2.2', title: '验收', agent: 'agent-qa' }, 1)
    expect(result.plan.find((s) => s.id === '2.2')?.agent).toBe('agent-qa')
  })
})
