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

  it('carries the boundary the reply named', () => {
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

    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.authorizedSteps).toEqual(['1', '1.1', '1.2'])
  })

  it('allows an ordinary resume with no boundary when the reply set none', () => {
    const verdict = resumeDecisionFor(
      task({
        decision: {
          category: 'direction',
          label: 'x',
          reason: 'x',
          askedAt: 1,
          deadlineAt: 2,
          resolvedAt: 3,
          answer: { text: '继续吧', at: 4 },
        },
      }),
    )

    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.authorizedSteps).toBeUndefined()
  })

  it('does not block a task that never asked anything', () => {
    expect(resumeDecisionFor(task()).allowed).toBe(true)
  })
})
