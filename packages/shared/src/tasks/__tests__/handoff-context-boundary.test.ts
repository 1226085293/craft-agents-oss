import { describe, expect, it } from 'bun:test'
import { formatHandoffContext } from '../brief.ts'
import type { Task } from '../types.ts'

/**
 * A hand-off written before the instruction must not outrank it.
 *
 * Observed in a resume: the brief said 「上一轮结论：边界只有 1.1」 and then, straight from the
 * hand-off, 「下一步：从 1.2 读回确认继续」. Two instructions about what to do next, and the worker
 * followed the one written by the previous session.
 *
 * The first fix withheld the next action entirely whenever a boundary existed. That stopped working
 * for the right reason: the boundary is no longer a set of ids the code can check, it is a sentence
 * a model wrote (`spec.directive`), so 「withhold when a boundary exists」 would now mean 「withhold
 * whenever the user has said anything」 — and the previous worker's next action is real knowledge.
 *
 * So both are passed on, and one line says which wins. That is what a person handing over work
 * would do, and it leaves no judgement to be made silently by whoever reads it next.
 */
const base = {
  id: 'T-1',
  handoffs: [
    {
      at: 1,
      fromSessionId: 's',
      outcome: 'handoff',
      summary: '1.1 完成，边界只有 1.1',
      nextAction: '从 1.2 读回确认继续，然后做 2',
    },
  ],
} as unknown as Task

describe('the hand-off does not overrule the instruction', () => {
  it('keeps the next action but marks it as subordinate to the directive', () => {
    const text = formatHandoffContext({
      ...base,
      spec: { directive: { text: '只做登录修复，其余不动', at: 99 } },
    } as Task)

    expect(text).toContain('上一轮结论')
    // The knowledge survives; the precedence is stated instead of enforced by omission.
    expect(text).toContain('从 1.2 读回确认继续')
    expect(text).toContain('以指令为准')
  })

  it('keeps the next action plainly when nothing has been directed', () => {
    const text = formatHandoffContext({ ...base, spec: {} } as Task)

    expect(text).toContain('下一步：从 1.2 读回确认继续')
    expect(text).not.toContain('以指令为准')
  })
})
