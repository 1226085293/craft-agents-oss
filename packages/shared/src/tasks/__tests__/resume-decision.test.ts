import { describe, expect, it } from 'bun:test'
import { resumeDecisionFor } from '../resume-decision.ts'
import type { Task } from '../types.ts'

/**
 * One function answers "may this run, and how far".
 *
 * Four entry points used to answer it separately — manual run, a supervisor resume, an event
 * route, the scheduler — and they disagreed. The observed failure: 「完成 1.2 后暂停」 lifted
 * the pause on one path and resumed the whole remaining plan on another, so the task was
 * completed past the boundary it had just been given.
 */
const plan = [
  { id: '1', title: 'a', status: 'done' as const },
  { id: '1.1', title: 'b', status: 'done' as const },
  { id: '1.2', title: 'c', status: 'todo' as const },
  { id: '2', title: 'd', status: 'todo' as const },
]

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1',
    name: 'x',
    instruction: 'x',
    status: 'paused',
    supervisorSessionId: 'sup',
    sessionIds: [],
    dependsOn: [],
    priority: 0,
    budget: { maxSessions: 8, maxRuns: 12, activeMinutes: 0 },
    handoffs: [],
    spec: { plan },
    ...over,
  } as unknown as Task
}

describe('may this task run', () => {
  it('refuses while the question is still open', () => {
    const verdict = resumeDecisionFor(
      task({ decision: { category: 'direction', label: '等你拍板', reason: 'x', askedAt: 1, deadlineAt: 2 } }),
    )

    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.why).toContain('等你拍板')
  })

  it('refuses when the reply ended the task', () => {
    const verdict = resumeDecisionFor(
      task({
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '到此为止，结束任务', at: 4 },
        },
      }),
    )

    expect(verdict.allowed).toBe(false)
  })

  /**
   * The boundary is what a model wrote down, not what a parser guessed from the sentence.
   *
   * This test used to assert that 「完成1.2后暂停」 produced `authorizedSteps: ['1','1.1','1.2']`
   * by keyword matching. That mechanism is gone: it read 「其余」 as "everything" in one phrasing
   * and as "nothing" in another, and it never saw 「停止剩下的任务」 at all.
   */
  it('does not invent a boundary from the words', () => {
    const verdict = resumeDecisionFor(
      task({
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '完成1.2后暂停', at: 4 },
        },
      }),
    )
    // Nobody has acted on the reply yet, so it must not run — not with a guessed boundary.
    expect(verdict.allowed).toBe(false)
  })

  it('carries the boundary a model recorded, including one the plan has not reached', () => {
    const behind = [
      { id: '1', title: 'a', status: 'done' as const },
      { id: '1.1', title: 'b', status: 'done' as const },
      { id: '2', title: 'c', status: 'todo' as const },
    ]
    const verdict = resumeDecisionFor(
      task({
        spec: { plan: behind, authorizedUpTo: '1.2', authorizedAt: 99 },
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '完成1.2后暂停', at: 4 },
        },
      }),
    )
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.authorizedUpTo).toBe('1.2')
  })

  it('resumes without a boundary when the reply set none and was acted on', () => {
    const verdict = resumeDecisionFor(
      task({
        spec: { plan: [{ id: '1', title: 'a', status: 'todo' as const }], authorizedAt: 99 },
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '继续', at: 4 },
        },
      }),
    )
    expect(verdict.allowed).toBe(true)
  })
})
