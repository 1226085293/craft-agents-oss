import { describe, expect, it } from 'bun:test'
import { applyPlanPatch } from '../plan.ts'
import type { PlanStep } from '../plan.ts'

/**
 * The boundary was written down and nothing read it.
 *
 * A real run had 「完成 1.2 后暂停，不执行步骤 2」 in `spec.scope`; the worker marked 1.2, 2
 * and 2.1 done and delivered the whole task. The sentence was in the brief and in the
 * record — it just had no counterpart in code.
 */
const plan: PlanStep[] = [
  { id: '1', title: '写文件', status: 'todo' },
  { id: '1.1', title: '创建 docs/a.md', status: 'done' },
  { id: '1.2', title: '读回确认', status: 'todo' },
  { id: '2', title: '收尾', status: 'todo' },
]

describe('a run has an authorised slice', () => {
  it('lets the worker finish a step it was given', () => {
    const result = applyPlanPatch(plan, { id: '1.2', status: 'done' }, 1, {
      authorizedSteps: ['1.1', '1.2'],
    })

    expect(result.error).toBeUndefined()
    expect(result.plan.find((s) => s.id === '1.2')?.status).toBe('done')
  })

  it('refuses to start or finish a step outside the slice', () => {
    for (const status of ['doing', 'done'] as const) {
      const result = applyPlanPatch(plan, { id: '2', status }, 1, {
        authorizedSteps: ['1.1', '1.2'],
      })

      expect(result.error).toBeDefined()
      // The refusal has to name the boundary AND the way out; a wall with no exit is
      // what makes a worker pretend it finished.
      expect(result.error).toContain('不在本次授权范围内')
      expect(result.error).toContain('handoff')
      expect(result.plan.find((s) => s.id === '2')?.status).toBe('todo')
    }
  })

  it('still allows a note on a step it may not work on', () => {
    // Writing down why a step is out of scope is useful and harmless.
    const result = applyPlanPatch(plan, { id: '2', note: '留给后续会话' }, 1, {
      authorizedSteps: ['1.1', '1.2'],
    })

    expect(result.error).toBeUndefined()
  })

  it('does not gate anything when no slice was declared', () => {
    // An unrestricted task is the old behaviour and must stay that way.
    const flat: PlanStep[] = [
      { id: '1', title: '写文件', status: 'done' },
      { id: '1.1', title: '创建文件', status: 'done' },
      { id: '2', title: '收尾', status: 'todo' },
      { id: '2.1', title: '整理', status: 'todo' },
    ]
    const result = applyPlanPatch(flat, { id: '2.1', status: 'done' }, 1)
    expect(result.error).toBeUndefined()
    expect(result.plan.find((s) => s.id === '2.1')?.status).toBe('done')
  })
})
