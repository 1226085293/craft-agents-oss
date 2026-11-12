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

  it('carries the instruction a model recorded', () => {
    const behind = [
      { id: '1', title: 'a', status: 'done' as const },
      { id: '1.1', title: 'b', status: 'done' as const },
      { id: '2', title: 'c', status: 'todo' as const },
    ]
    const verdict = resumeDecisionFor(
      task({
        spec: { plan: behind, directive: { text: '做到 1.2 就停', at: 99 } },
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
    if (verdict.allowed) expect(verdict.directive).toBe('做到 1.2 就停')
  })

  it('resumes when the reply was acted on', () => {
    const verdict = resumeDecisionFor(
      task({
        spec: { plan: [{ id: '1', title: 'a', status: 'todo' as const }], directive: { text: '继续', at: 99 } },
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

/**
 * The chain that once displayed 「用户拍板放行」 with no answer anywhere in the record:
 * the supervisor asked, wrote its own directive, and its scope write closed the question as
 * obsolete. This used to fall through to 「没有待回答的问题」 — allowed on nobody.
 */
describe('a question closed without an answer unlocks nothing on its own', () => {
  const closedWithoutAnswer = {
    category: 'direction',
    label: '是否放行大纲2？',
    reason: 'x',
    askedAt: 100,
    deadlineAt: 200,
    resolvedAt: 150,
  }

  it('refuses when nobody has spoken since the question was asked', () => {
    const verdict = resumeDecisionFor(
      task({
        spec: { directive: { text: '执行大纲 2 收尾', at: 160 } },
        decision: closedWithoutAnswer,
      }),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.why).toContain('没有任何人回答过')
  })

  it('refuses when the person spoke but nobody translated the words into a directive', () => {
    const verdict = resumeDecisionFor(
      task({ humanAuthAt: 170, decision: closedWithoutAnswer }),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.why).toContain('翻译成指令')
  })

  it('allows when the person spoke and a directive newer than that contact exists', () => {
    const verdict = resumeDecisionFor(
      task({
        humanAuthAt: 170,
        spec: { directive: { text: '只做大纲 2 收尾', at: 180 } },
        decision: closedWithoutAnswer,
      }),
    )
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.directive).toBe('只做大纲 2 收尾')
  })
})

/**
 * A task can hold several questions. Answering one is not answering the rest, and a second
 * question the supervisor closes for itself must not ride the first question's answer.
 */
describe('several questions in the queue', () => {
  it('refuses when an answered question sits beside a closed one nobody saw', () => {
    const verdict = resumeDecisionFor(
      task({
        humanAuthAt: 4,
        spec: { directive: { text: '只做 1.2', at: 10 } },
        decisions: [
          {
            category: 'direction',
            label: 'Q1',
            reason: 'x',
            askedAt: 1,
            deadlineAt: 2,
            resolvedAt: 3,
            answer: { text: '只做 1.2', at: 4 },
          },
          {
            category: 'direction',
            label: 'Q2',
            reason: 'x',
            askedAt: 6,
            deadlineAt: 7,
            resolvedAt: 9,
          },
        ],
        decision: {
          category: 'direction',
          label: 'Q2',
          reason: 'x',
          askedAt: 6,
          deadlineAt: 7,
          resolvedAt: 9,
        },
      }),
    )
    // Q2 was asked after the person's last words — closing it is the supervisor answering itself.
    expect(verdict.allowed).toBe(false)
  })

  it('refuses while any question in the queue is still open, even without a mirror', () => {
    const verdict = resumeDecisionFor(
      task({
        decisions: [
          {
            category: 'direction',
            label: '等你拍板',
            reason: 'x',
            askedAt: 1,
            deadlineAt: 2,
          },
        ],
      }),
    )
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.why).toContain('等你拍板')
  })
})
