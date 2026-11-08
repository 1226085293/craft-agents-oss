import { describe, expect, it } from 'bun:test'
import { formatHandoffContext } from '../brief.ts'
import type { Task } from '../types.ts'

/**
 * A hand-off written before the boundary must not compete with it.
 *
 * Observed in a resume: the brief said 「上一轮结论：边界只有 1.1」 and then, straight from the
 * hand-off, 「下一步：从 1.2 读回确认继续」. Two instructions about what to do next, and the
 * worker followed the one written by the previous session.
 *
 * Rephrasing it (「下一步（本次只到 1.2…）」) is still an instruction plus a request to police
 * its own scope. The fix is to not pass it on: the boundary is enforced where it is checkable,
 * so the stale plan is withheld rather than qualified.
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

describe('the hand-off does not overrule the boundary', () => {
  it('withholds the next action when a boundary exists', () => {
    const text = formatHandoffContext({ ...base, spec: { authorizedUpTo: '1.2' } } as Task)

    expect(text).toContain('上一轮结论')
    // The stale instruction is gone, not merely qualified.
    expect(text).not.toContain('从 1.2 读回确认继续')
    expect(text).not.toContain('下一步')
  })

  it('keeps the next action when there is no boundary', () => {
    const text = formatHandoffContext({ ...base, spec: {} } as Task)

    expect(text).toContain('下一步：从 1.2 读回确认继续')
  })
})
